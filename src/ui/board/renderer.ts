import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

import { sanitizeOneLine } from '../../domain/sanitization.js';
import type { Attachment, QuestionItem, UpdateItem } from '../../domain/types.js';
import {
  BOARD_TABS,
  type BoardListRow,
  type BoardTab,
  type BoardViewModel,
  type HistoryDetailModel,
} from './model.js';

const MINIMUM_WIDTH = 50;
const WIDE_WIDTH = 100;
const MAX_VISIBLE_ROWS = 12;
const MAX_DETAIL_LINES = 14;
const SAFE_TEXT_LIMIT = 10_000;
const RESIZE_MESSAGE =
  'Signal Board requires at least 50 columns. Resize the terminal or press Esc.';

export interface BoardRenderState {
  readonly width: number;
  readonly theme: Theme;
  readonly model: BoardViewModel;
  readonly activeTab: BoardTab;
  readonly selectedIndex: number;
  readonly detailExpanded: boolean;
  readonly helpVisible: boolean;
  readonly recommendationAvailable: boolean;
}

export function renderBoard(state: BoardRenderState): string[] {
  const width = normalizeWidth(state.width);
  if (width < MINIMUM_WIDTH) return width === 0 ? [] : wrap(RESIZE_MESSAGE, width);

  const lines = state.helpVisible
    ? renderHelp(state, width)
    : state.model.availability.kind === 'ready'
      ? width >= WIDE_WIDTH
        ? renderWide(state, width)
        : renderNarrow(state, width)
      : renderUnavailable(state, width);
  return lines.map((line) => boundLine(line, width));
}

function renderNarrow(state: BoardRenderState, width: number): string[] {
  const tab = state.model.tabs[state.activeTab];
  const rows = visibleRows<BoardListRow>(tab.rows, state.selectedIndex);
  const selected = tab.rows[state.selectedIndex];
  const lines = [
    state.theme.fg(
      'accent',
      state.theme.bold(`SIGNAL · ${tabName(state.activeTab)} ${tab.visibleCount}/${tab.count}`),
    ),
    ...catchUpLines(state, width),
    tabsLine(state, width),
    separator(width),
  ];

  if (tab.rows.length === 0) {
    lines.push(safe(tab.empty.title));
    if (tab.empty.detail !== undefined) lines.push(...wrap(tab.empty.detail, width));
  } else {
    for (const row of rows) lines.push(renderRow(row, row === selected, width, state.theme));
  }

  if (state.activeTab === 'history' && state.model.tabs.history.truncationNotice !== undefined) {
    lines.push(state.theme.fg('warning', safe(state.model.tabs.history.truncationNotice)));
  }
  if (state.detailExpanded && selected !== undefined) {
    lines.push(separator(width));
    lines.push(...detailLines(state, selected, width).slice(0, MAX_DETAIL_LINES));
  }

  lines.push(separator(width), ...contextualFooter(state, selected, width), ...globalFooter(width));
  return lines;
}

function renderWide(state: BoardRenderState, width: number): string[] {
  const leftWidth = clamp(30, Math.floor(width * 0.38), 46);
  const rightWidth = width - leftWidth - 1;
  const tab = state.model.tabs[state.activeTab];
  const selected = tab.rows[state.selectedIndex];
  const rows = visibleRows<BoardListRow>(tab.rows, state.selectedIndex);
  const left =
    rows.length === 0
      ? [
          safe(tab.empty.title),
          ...(tab.empty.detail === undefined ? [] : wrap(tab.empty.detail, leftWidth)),
        ]
      : rows.map((row) => renderRow(row, row === selected, leftWidth, state.theme));
  if (state.activeTab === 'history' && state.model.tabs.history.truncationNotice !== undefined) {
    left.push(state.theme.fg('warning', safe(state.model.tabs.history.truncationNotice)));
  }
  const right =
    selected === undefined
      ? ['No item selected.']
      : detailLines(state, selected, rightWidth).slice(0, MAX_DETAIL_LINES);
  const paneHeight = Math.max(3, left.length, right.length);
  const panes: string[] = [];
  for (let index = 0; index < paneHeight; index += 1) {
    panes.push(
      `${pad(left[index] ?? '', leftWidth)}${state.theme.fg('borderMuted', '│')}${right[index] ?? ''}`,
    );
  }

  return [
    state.theme.fg('accent', state.theme.bold('PI SIGNAL BOARD')),
    ...catchUpLines(state, width),
    tabsLine(state, width),
    separator(width),
    ...panes,
    separator(width),
    ...contextualFooter(state, selected, width),
    ...globalFooter(width),
  ];
}

function renderUnavailable(state: BoardRenderState, width: number): string[] {
  const availability = state.model.availability;
  if (availability.kind === 'ready') return [];
  const heading = availability.kind === 'error' ? 'SIGNAL BOARD ERROR' : 'SIGNAL BOARD UNAVAILABLE';
  const color = availability.kind === 'error' ? 'error' : 'warning';
  return [
    state.theme.fg(color, state.theme.bold(heading)),
    separator(width),
    ...wrap(availability.message, width),
    `Code: ${availability.code}`,
    separator(width),
    'Esc close · ? help',
  ];
}

function renderHelp(state: BoardRenderState, width: number): string[] {
  return [
    state.theme.fg('accent', state.theme.bold('Signal Board keys')),
    separator(width),
    ...wrap('Global: Tab/Shift+Tab view · ↑↓/jk move · Enter details · Esc close', width),
    ...wrap('Inbox: A answer · R recommendation · X dismiss · Y retry delivery', width),
    ...wrap('Updates: H archive terminal item', width),
    ...wrap('Decisions and History: read-only', width),
    ...wrap('Other: ? help', width),
    '',
    ...wrap('Commands: /signalboard [inbox|updates|decisions|history|summary|doctor]', width),
    separator(width),
    '? or Esc return to board',
  ];
}

function catchUpLines(state: BoardRenderState, width: number): string[] {
  if (!state.model.catchUp.visible) return [];
  if (width < WIDE_WIDTH) return [state.theme.fg('warning', safe(state.model.catchUp.label))];
  const counts = state.model.catchUp.counts;
  const summary = [
    countLabel(counts.delivery_attention, 'delivery attention'),
    countLabel(counts.blocked_failed, 'blocked/failed'),
    countLabel(counts.question, 'question'),
    countLabel(counts.completed_applied, 'completed/applied'),
    countLabel(counts.update, 'update'),
  ].join(' · ');
  return [state.theme.fg('warning', `SINCE LAST VIEWED · ${summary}`)];
}

function tabsLine(state: BoardRenderState, width: number): string {
  const chunks = BOARD_TABS.map((tab) => {
    const text = `[${tabName(tab)} ${state.model.tabCounts[tab]}]`;
    return tab === state.activeTab ? state.theme.fg('accent', state.theme.bold(text)) : text;
  });
  return truncateToWidth(chunks.join(width < 70 ? ' ' : '   '), width, '');
}

function renderRow(row: BoardListRow, selected: boolean, width: number, theme: Theme): string {
  const marker = selected ? '> ' : '  ';
  const label = `[${safe(row.statusLabel)}]`;
  const displayId = safe(row.displayId);
  const prefix = `${marker}${label} ${displayId}`;
  const styledPrefix = selected ? theme.fg('accent', prefix) : prefix;
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= width) return truncateToWidth(styledPrefix, width, '');
  const titleWidth = width - prefixWidth - 1;
  return `${styledPrefix} ${plainTruncate(row.title, titleWidth, '…')}`;
}

function detailLines(state: BoardRenderState, selected: BoardListRow, width: number): string[] {
  const header = `${safe(selected.displayId)} · revision ${selected.revision}`;
  const fallback = [
    state.theme.fg('accent', state.theme.bold(header)),
    `[${safe(selected.statusLabel)}]`,
    ...wrap(selected.title, width),
  ];

  switch (state.activeTab) {
    case 'inbox': {
      const detail = state.model.tabs.inbox.detailsById[selected.entityId];
      if (detail === undefined) return fallback;
      return questionDetail(detail.projection.item, selected.statusLabel, state.theme, width);
    }
    case 'updates': {
      const detail = state.model.tabs.updates.detailsById[selected.entityId];
      if (detail === undefined) return fallback;
      return updateDetail(detail.item, selected.statusLabel, state.theme, width);
    }
    case 'decisions': {
      const detail = state.model.tabs.decisions.detailsById[selected.entityId];
      if (detail === undefined) return fallback;
      const decision = detail.decision;
      return compactSections(
        [
          state.theme.fg(
            'accent',
            state.theme.bold(`${safe(decision.id)} · revision ${decision.questionRevision}`),
          ),
          `[${safe(selected.statusLabel)}]`,
          safe(decision.question),
          `Answer: ${safe(JSON.stringify(decision.answer))}`,
          ...(decision.recommendation === undefined
            ? []
            : [`Recommendation: ${safe(decision.recommendation)}`]),
          `Acknowledgement: ${safe(decision.acknowledgement.summary)}`,
          `Related updates: ${decision.acknowledgement.resultingUpdateIds.map(safe).join(', ') || 'none'}`,
          `Decided: ${safe(decision.decidedAt)}`,
        ],
        width,
      );
    }
    case 'history': {
      const detail = state.model.tabs.history.detailsById[selected.id];
      if (detail === undefined || historyEntityId(detail) !== selected.entityId) return fallback;
      return historyDetail(detail, selected.statusLabel, state.theme, width);
    }
  }
}

function questionDetail(item: QuestionItem, status: string, theme: Theme, width: number): string[] {
  const flags = `[${safe(status)}] [${safe(item.class.toUpperCase())}] [${safe(item.priority.toUpperCase())}]`;
  return compactSections(
    [
      theme.fg('accent', theme.bold(`${safe(item.displayId)} · revision ${item.revision}`)),
      flags,
      `Question: ${safe(item.question)}`,
      `Why: ${safe(item.reason)}`,
      ...(item.recommendation === undefined
        ? []
        : [`Recommendation: ${safe(item.recommendation)}`]),
      ...(item.temporaryDefault === undefined
        ? []
        : [`Temporary behavior: ${safe(item.temporaryDefault.disclosure)}`]),
      ...(item.response.options ?? []).map(
        (option, index) => `${index + 1}. ${safe(option.label)}`,
      ),
      ...item.affectedWork.map((entry) => `Affected: ${safe(entry)}`),
      ...item.continuingWork.map((entry) => `Continued: ${safe(entry)}`),
      ...item.attachments.map(formatAttachment),
    ],
    width,
  );
}

function updateDetail(item: UpdateItem, status: string, theme: Theme, width: number): string[] {
  return compactSections(
    [
      theme.fg('accent', theme.bold(`${safe(item.displayId)} · revision ${item.revision}`)),
      `[${safe(status)}]`,
      safe(item.title),
      ...(item.detail === undefined ? [] : [safe(item.detail)]),
      ...(item.stage === undefined ? [] : [`Stage: ${safe(item.stage)}`]),
      ...(item.progress === undefined
        ? []
        : [
            `Progress: ${item.progress.current}/${item.progress.total}${item.progress.unit === undefined ? '' : ` ${safe(item.progress.unit)}`}`,
          ]),
      ...item.attachments.map(formatAttachment),
    ],
    width,
  );
}

function historyDetail(
  detail: HistoryDetailModel,
  status: string,
  theme: Theme,
  width: number,
): string[] {
  const source =
    detail.entityType === 'update'
      ? updateDetail(detail.item, status, theme, width)
      : questionDetail(detail.projection.item, status, theme, width);
  return [...source, `Terminal: ${safe(detail.terminalKind)} at ${safe(detail.terminalAt)}`];
}

function contextualFooter(
  state: BoardRenderState,
  selected: BoardListRow | undefined,
  width: number,
): string[] {
  if (selected === undefined) return packLabels(['Enter details'], width);
  if (state.activeTab === 'inbox') {
    const row = state.model.tabs.inbox.rows[state.selectedIndex];
    if (row === undefined) return packLabels(['Enter details'], width);
    const actions = ['Enter details'];
    if (row.userAnswerable) actions.push('A answer');
    if (row.userAnswerable && state.recommendationAvailable) actions.push('R recommendation');
    if (row.userAnswerable) actions.push('X dismiss');
    if (row.retryableDelivery) actions.push('Y retry delivery');
    return packLabels(actions, width);
  }
  if (state.activeTab === 'updates') {
    const row = state.model.tabs.updates.rows[state.selectedIndex];
    return packLabels(
      row !== undefined && (row.kind === 'completed' || row.kind === 'failed')
        ? ['Enter details', 'H archive']
        : ['Enter details'],
      width,
    );
  }
  return packLabels(['Enter details', 'read-only'], width);
}

function globalFooter(width: number): string[] {
  return packLabels(['Tab/Shift+Tab view', '↑↓/jk move', '? help', 'Esc close'], width);
}

function packLabels(labels: readonly string[], width: number): string[] {
  const lines: string[] = [];
  for (const label of labels) {
    const safeLabel = safe(label);
    const current = lines.at(-1);
    if (current === undefined) {
      lines.push(safeLabel);
      continue;
    }
    const candidate = `${current} · ${safeLabel}`;
    if (visibleWidth(candidate) <= width) lines[lines.length - 1] = candidate;
    else lines.push(safeLabel);
  }
  return lines.flatMap((line) => (visibleWidth(line) <= width ? [line] : wrap(line, width)));
}

function visibleRows<T>(rows: readonly T[], selectedIndex: number): readonly T[] {
  if (rows.length <= MAX_VISIBLE_ROWS) return rows;
  const start = clamp(
    0,
    selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2),
    rows.length - MAX_VISIBLE_ROWS,
  );
  return rows.slice(start, start + MAX_VISIBLE_ROWS);
}

function compactSections(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => wrap(line, width));
}

function wrap(value: string, width: number): string[] {
  if (width <= 0) return [''];
  return wrapTextWithAnsi(safe(value), width).map((line) => safe(truncateToWidth(line, width, '')));
}

function safe(value: string): string {
  const result = sanitizeOneLine(value, SAFE_TEXT_LIMIT);
  return result.ok ? result.value : '';
}

function formatAttachment(attachment: Attachment): string {
  switch (attachment.kind) {
    case 'file':
      return `Attachment: ${safe(attachment.label)} — ${safe(attachment.path)}`;
    case 'line_range':
      return `Attachment: ${safe(attachment.label)} — ${safe(attachment.path)}:${attachment.startLine}-${attachment.endLine}`;
    case 'test_run':
    case 'command':
      return `Attachment: ${safe(attachment.label)} — ${safe(attachment.reference)}`;
    case 'url':
      return `Attachment: ${safe(attachment.label)} — ${safe(attachment.url)}`;
    case 'note':
      return `Attachment: ${safe(attachment.label)} — ${safe(attachment.text)}`;
  }
}

function historyEntityId(detail: HistoryDetailModel): string {
  return detail.entityType === 'update' ? detail.item.id : detail.projection.item.id;
}

function pad(value: string, width: number): string {
  const clipped = visibleWidth(value) <= width ? value : truncateToWidth(value, width, '');
  return `${clipped}${' '.repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function boundLine(value: string, width: number): string {
  return visibleWidth(value) <= width ? value : truncateToWidth(value, width, '');
}

function plainTruncate(value: string, width: number, ellipsis: string): string {
  return safe(truncateToWidth(safe(value), width, ellipsis));
}

function separator(width: number): string {
  return '─'.repeat(width);
}

function tabName(tab: BoardTab): string {
  return `${tab[0]?.toUpperCase() ?? ''}${tab.slice(1)}`;
}

function countLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
}

function clamp(minimum: number, value: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
