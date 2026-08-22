import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import type { EffectiveConfig } from '../../config/types.js';
import { sanitizeOneLine } from '../../domain/sanitization.js';
import { selectBoardCounts, selectWidgetCandidates } from '../../domain/selectors.js';
import type { BoardState, QuestionItem, UpdateItem } from '../../domain/types.js';

const MAX_WIDGET_LINE_WIDTH = 120;
const LONG_HEADER_MINIMUM_WIDTH = 80;
const SAFE_TEXT_LIMIT = 10_000;

export const WIDGET_NAMESPACE = 'pi-signal-board';

export interface WidgetRenderRequest {
  /** Exact cutoff used to decide whether completed updates remain visible. */
  readonly completedWindowCutoff: string;
  /** Exact current time used for the unread count. The renderer never reads a clock. */
  readonly currentTime: string;
  /** Effective invocation, including the leading slash and any collision suffix. */
  readonly effectiveCommand: string;
  readonly width: number;
}

/**
 * Project immutable board state into deterministic, no-color widget lines.
 * The caller owns Pi registration and placement.
 */
export function renderWidgetLines(
  state: BoardState,
  config: EffectiveConfig,
  request: WidgetRenderRequest,
): readonly string[] {
  const width = normalizeWidth(request.width);
  if (!config.enabled || !config.widget.enabled || width === 0) return Object.freeze([]);

  const candidates = selectWidgetCandidates(state, request.completedWindowCutoff);
  if (candidates.length === 0 && config.widget.hideWhenClear) return Object.freeze([]);

  const lineWidth = Math.min(width, MAX_WIDGET_LINE_WIDTH);
  const maximumItems = normalizeMaximumItems(config.widget.maxItems);
  const counts = countCandidates(candidates);
  const unread = selectBoardCounts(state, request.currentTime).unread;
  const lines = [
    renderHeader(counts.questions, counts.updates, unread, lineWidth),
    ...candidates
      .slice(0, maximumItems)
      .map((candidate) =>
        candidate.entityType === 'question'
          ? renderQuestion(candidate.item, lineWidth)
          : renderUpdate(candidate.item, lineWidth),
      ),
    renderHint(request.effectiveCommand, lineWidth),
  ];

  return Object.freeze(lines.map((line) => boundLine(line, lineWidth)));
}

function renderHeader(questions: number, updates: number, unread: number, width: number): string {
  if (questions === 0 && updates === 0) return 'SIGNAL · clear';
  if (width < LONG_HEADER_MINIMUM_WIDTH) {
    const counts = [`${questions}Q`, `${updates}U`];
    if (unread > 0) counts.push(`${unread} new`);
    return `SIGNAL · ${counts.join(' · ')}`;
  }

  const counts = [pluralCount(questions, 'question'), pluralCount(updates, 'update')];
  if (unread > 0) counts.push(`${unread} new`);
  return `SIGNAL · ${counts.join(' · ')}`;
}

function renderQuestion(item: QuestionItem, width: number): string {
  return renderItem(questionLabel(item), item.displayId, item.question, width);
}

function renderUpdate(item: UpdateItem, width: number): string {
  return renderItem(updateLabel(item), item.displayId, item.title, width);
}

function renderItem(label: string, displayId: string, title: string, width: number): string {
  const safeLabel = safeText(label, 'STATE');
  const safeDisplayId = safeText(displayId, '?');
  const prefix = `[${safeLabel}] ${safeDisplayId}`;
  if (visibleWidth(prefix) >= width) return boundLine(prefix, width);

  const remaining = width - visibleWidth(prefix) - 1;
  const safeTitle = safeText(title, 'Untitled');
  return `${prefix} ${plainTruncate(safeTitle, remaining, '…')}`;
}

function renderHint(effectiveCommand: string, width: number): string {
  const command = safeText(effectiveCommand, '/agentboard');
  return boundLine(`Open ${command}`, width);
}

function questionLabel(item: QuestionItem): string {
  switch (item.status) {
    case 'delivery_failed':
      return 'DELIVERY FAILED';
    case 'needs_attention':
      return 'NEEDS ATTENTION';
    case 'blocking':
      return 'BLOCKED';
    case 'pending':
      return 'PENDING';
    default:
      return 'QUESTION';
  }
}

function updateLabel(item: UpdateItem): string {
  switch (item.kind) {
    case 'working':
      return 'WORKING';
    case 'finding':
      return 'FOUND';
    case 'warning':
      return 'WARNING';
    case 'blocked':
      return 'BLOCKED';
    case 'completed':
      return 'DONE';
    case 'failed':
      return 'FAILED';
  }
}

function countCandidates(candidates: ReturnType<typeof selectWidgetCandidates>): {
  readonly questions: number;
  readonly updates: number;
} {
  let questions = 0;
  let updates = 0;
  for (const candidate of candidates) {
    if (candidate.entityType === 'question') questions += 1;
    else updates += 1;
  }
  return { questions, updates };
}

function safeText(value: string, fallback: string): string {
  const result = sanitizeOneLine(value, SAFE_TEXT_LIMIT);
  return result.ok ? result.value : fallback;
}

function boundLine(line: string, width: number): string {
  return plainTruncate(line, width, '');
}

function plainTruncate(line: string, width: number, ellipsis: string): string {
  const truncated = truncateToWidth(line, width, ellipsis);
  const plain = sanitizeOneLine(truncated, SAFE_TEXT_LIMIT);
  return plain.ok ? plain.value : '';
}

function pluralCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
}

function normalizeMaximumItems(maximumItems: number): number {
  return Number.isSafeInteger(maximumItems) && maximumItems > 0 ? maximumItems : 0;
}
