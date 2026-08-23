import type { EffectiveConfig } from '../../config/types.js';
import type { QuestionId } from '../../domain/ids.js';
import {
  type CatchUpProjection,
  type InboxQuestionProjection,
  type QuestionDetailProjection,
  selectActiveUpdates,
  selectCatchUp,
  selectDecisions,
  selectHistory,
  selectInboxQuestionProjections,
  selectQuestionDetail,
} from '../../domain/selectors.js';
import type {
  BoardState,
  DecisionRecord,
  QuestionItem,
  QuestionStatus,
  UpdateItem,
  UpdateKind,
} from '../../domain/types.js';

export const BOARD_TABS = ['inbox', 'updates', 'decisions', 'history'] as const;
export type BoardTab = (typeof BOARD_TABS)[number];

export type BoardModelAvailability =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'unavailable';
      readonly code: 'SB_CONFIG_DISABLED' | 'SB_UI_UNAVAILABLE';
      readonly message: string;
    }
  | { readonly kind: 'error'; readonly code: 'SB_INTERNAL'; readonly message: string };

export interface BoardEmptyState {
  readonly title: string;
  readonly detail?: string;
}

export interface BoardListRow {
  readonly id: string;
  readonly entityId: string;
  readonly displayId: string;
  readonly title: string;
  readonly statusLabel: string;
  readonly revision: number;
  readonly changedAt: string;
  readonly selected: boolean;
}

export interface InboxRow extends BoardListRow {
  readonly entityType: 'question';
  readonly category: InboxQuestionProjection['category'];
  readonly userAnswerable: boolean;
  readonly dismissible: boolean;
  readonly retryableDelivery: boolean;
  readonly awaitingAcknowledgement: boolean;
}

export interface UpdateRow extends BoardListRow {
  readonly entityType: 'update';
  readonly kind: UpdateKind;
  readonly recentTerminal: boolean;
}

export interface DecisionRow extends BoardListRow {
  readonly entityType: 'decision';
  readonly outcome: 'applied' | 'superseded';
}

export interface HistoryRow extends BoardListRow {
  readonly entityType: 'update' | 'question';
  readonly terminalAt: string;
  readonly terminalKind:
    | 'archived'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'dismissed'
    | 'stale'
    | 'resolved';
}

export interface InboxDetailModel {
  readonly entityType: 'question';
  readonly projection: InboxQuestionProjection;
}

export interface UpdateDetailModel {
  readonly entityType: 'update';
  readonly item: UpdateItem;
}

export interface DecisionDetailModel {
  readonly entityType: 'decision';
  readonly decision: DecisionRecord;
}

export type HistoryDetailModel =
  | {
      readonly entityType: 'update';
      readonly terminalAt: string;
      readonly terminalKind: HistoryRow['terminalKind'];
      readonly item: UpdateItem;
    }
  | {
      readonly entityType: 'question';
      readonly terminalAt: string;
      readonly terminalKind: HistoryRow['terminalKind'];
      readonly projection: QuestionDetailProjection;
    };

export interface BoardTabModel<Row, Detail> {
  readonly count: number;
  readonly visibleCount: number;
  readonly rows: readonly Row[];
  /** Complete immutable detail lookup for navigation inside this one board-open snapshot. */
  readonly detailsById: Readonly<Record<string, Detail>>;
  readonly selectedId?: string;
  readonly detail?: Detail;
  readonly empty: BoardEmptyState;
}

export interface HistoryTabModel extends BoardTabModel<HistoryRow, HistoryDetailModel> {
  readonly omittedCount: number;
  readonly truncated: boolean;
  readonly truncationNotice?: string;
}

export interface CatchUpItemModel {
  readonly entityType: 'update' | 'question';
  readonly entityId: string;
  readonly occurredAt: string;
  readonly eventId: string;
  readonly category: CatchUpProjection['items'][number]['category'];
  readonly changeKind: CatchUpProjection['items'][number]['change']['kind'];
  readonly displayId?: string;
  readonly title?: string;
}

export interface CatchUpHeaderModel {
  readonly visible: boolean;
  readonly total: number;
  readonly label: string;
  readonly counts: CatchUpProjection['counts'];
  readonly items: readonly CatchUpItemModel[];
}

export interface BoardViewSelections {
  readonly inbox?: string;
  readonly updates?: string;
  readonly decisions?: string;
  readonly history?: string;
}

export interface BoardViewModel {
  readonly availability: BoardModelAvailability;
  readonly openedAt: string;
  readonly initialTab: BoardTab;
  readonly activeTab: BoardTab;
  readonly tabCounts: Readonly<Record<BoardTab, number>>;
  readonly catchUp: CatchUpHeaderModel;
  readonly tabs: {
    readonly inbox: BoardTabModel<InboxRow, InboxDetailModel>;
    readonly updates: BoardTabModel<UpdateRow, UpdateDetailModel>;
    readonly decisions: BoardTabModel<DecisionRow, DecisionDetailModel>;
    readonly history: HistoryTabModel;
  };
  readonly metadata: {
    readonly historyLimit: number;
    readonly recentTerminalWindowMinutes: number;
    readonly minimumColumns: number;
    readonly wideLayoutMinimumColumns: number;
    readonly showRelativeTime: boolean;
  };
}

const EMPTY_STATES = {
  inbox: {
    title: 'No questions need attention.',
    detail: 'Agent questions that can wait without stopping independent work appear here.',
  },
  updates: {
    title: 'No active updates.',
    detail: 'Significant agent milestones, findings, warnings, and blockers appear here.',
  },
  decisions: { title: 'No applied decisions in this branch.' },
  history: { title: 'No archived or terminal items in this branch.' },
} as const;

/**
 * Create one immutable board-open snapshot. The function does not read time or mutate board state.
 * An explicit requested tab overrides only the active tab, not the automatic initial-tab result.
 */
export function buildBoardViewModel(
  state: BoardState,
  requestedTab: BoardTab | undefined,
  openedAt: string,
  config: EffectiveConfig,
  selections: BoardViewSelections = {},
): BoardViewModel {
  const inbox = selectInboxQuestionProjections(state);
  const updates = selectBoardUpdates(state, openedAt, config.widget.showCompletedForMinutes);
  const decisions = selectDecisions(state);
  const history = selectHistory(state, config.limits.visibleHistoryLimit);

  const initialTab = chooseInitialTab(inbox.length, updates.length, decisions.length);
  const inboxSelection = selectRow(inbox, selections, 'inbox', (entry) => entry.item.id);
  const updateSelection = selectRow(updates, selections, 'updates', (item) => item.id);
  const decisionSelection = selectRow(decisions, selections, 'decisions', (item) => item.id);
  const historySelection = selectRow(
    history.items,
    selections,
    'history',
    (entry) => `${entry.entityType}:${entry.item.id}`,
  );

  const inboxRows = inbox.map((entry) => inboxRow(entry, inboxSelection.id));
  const updateRows = updates.map((item) =>
    updateRow(item, updateSelection.id, isRecentTerminalUpdate(item)),
  );
  const decisionRows = decisions.map((decision) => decisionRow(decision, decisionSelection.id));
  const historyRows = history.items.map((entry) => historyRow(entry, historySelection.id));
  const inboxDetails = Object.fromEntries(
    inbox.map((entry) => [entry.item.id, { entityType: 'question', projection: entry }]),
  ) as Record<string, InboxDetailModel>;
  const updateDetails = Object.fromEntries(
    updates.map((item) => [item.id, { entityType: 'update', item }]),
  ) as Record<string, UpdateDetailModel>;
  const decisionDetails = Object.fromEntries(
    decisions.map((decision) => [decision.id, { entityType: 'decision', decision }]),
  ) as Record<string, DecisionDetailModel>;
  const historyDetails = Object.fromEntries(
    history.items.flatMap((entry) => {
      const detail = historyDetail(state, entry);
      return detail === undefined ? [] : [[`${entry.entityType}:${entry.item.id}`, detail]];
    }),
  ) as Record<string, HistoryDetailModel>;
  const historySelectedDetail =
    historySelection.id === undefined ? undefined : historyDetails[historySelection.id];
  const omittedCount = Math.max(0, history.total - history.items.length);

  return immutableCopy({
    availability: config.enabled
      ? { kind: 'ready' }
      : {
          kind: 'unavailable',
          code: 'SB_CONFIG_DISABLED',
          message: 'Signals is disabled by configuration.',
        },
    openedAt,
    initialTab,
    activeTab: requestedTab ?? initialTab,
    tabCounts: {
      inbox: inbox.length,
      updates: updates.length,
      decisions: decisions.length,
      history: history.total,
    },
    catchUp: catchUpModel(state, openedAt),
    tabs: {
      inbox: {
        count: inbox.length,
        visibleCount: inboxRows.length,
        rows: inboxRows,
        detailsById: inboxDetails,
        ...(inboxSelection.id === undefined ? {} : { selectedId: inboxSelection.id }),
        ...(inboxSelection.value === undefined
          ? {}
          : {
              detail: {
                entityType: 'question',
                projection: inboxSelection.value,
              },
            }),
        empty: EMPTY_STATES.inbox,
      },
      updates: {
        count: updates.length,
        visibleCount: updateRows.length,
        rows: updateRows,
        detailsById: updateDetails,
        ...(updateSelection.id === undefined ? {} : { selectedId: updateSelection.id }),
        ...(updateSelection.value === undefined
          ? {}
          : { detail: { entityType: 'update', item: updateSelection.value } }),
        empty: EMPTY_STATES.updates,
      },
      decisions: {
        count: decisions.length,
        visibleCount: decisionRows.length,
        rows: decisionRows,
        detailsById: decisionDetails,
        ...(decisionSelection.id === undefined ? {} : { selectedId: decisionSelection.id }),
        ...(decisionSelection.value === undefined
          ? {}
          : { detail: { entityType: 'decision', decision: decisionSelection.value } }),
        empty: EMPTY_STATES.decisions,
      },
      history: {
        count: history.total,
        visibleCount: historyRows.length,
        rows: historyRows,
        detailsById: historyDetails,
        ...(historySelection.id === undefined ? {} : { selectedId: historySelection.id }),
        ...(historySelectedDetail === undefined ? {} : { detail: historySelectedDetail }),
        empty: EMPTY_STATES.history,
        omittedCount,
        truncated: history.truncated,
        ...(history.truncated
          ? {
              truncationNotice: `Showing ${history.items.length} of ${history.total} history items. ${omittedCount} omitted by the configured history limit.`,
            }
          : {}),
      },
    },
    metadata: {
      historyLimit: normalizeLimit(config.limits.visibleHistoryLimit),
      recentTerminalWindowMinutes: config.widget.showCompletedForMinutes,
      minimumColumns: config.ui.minimumColumns,
      wideLayoutMinimumColumns: config.ui.wideLayoutMinimumColumns,
      showRelativeTime: config.ui.showRelativeTime,
    },
  });
}

/** Fixed content-only states let the next UI slice fail without exposing an exception. */
export function boardModelFailure(
  kind: 'ui_unavailable' | 'internal_error',
): BoardModelAvailability {
  return immutableCopy(
    kind === 'ui_unavailable'
      ? {
          kind: 'unavailable',
          code: 'SB_UI_UNAVAILABLE',
          message: 'Signals interactive UI is unavailable.',
        }
      : {
          kind: 'error',
          code: 'SB_INTERNAL',
          message: 'Signals could not build a safe view.',
        },
  );
}

function chooseInitialTab(inbox: number, updates: number, decisions: number): BoardTab {
  if (inbox > 0) return 'inbox';
  if (updates > 0) return 'updates';
  if (decisions > 0) return 'decisions';
  return 'inbox';
}

function selectBoardUpdates(
  state: BoardState,
  openedAt: string,
  recentMinutes: number,
): readonly UpdateItem[] {
  const active = selectActiveUpdates(state);
  const cutoff = timestampMinusMinutes(openedAt, recentMinutes);
  const recentTerminal = [...state.updates.values()].filter(
    (item) =>
      !item.archived &&
      (item.kind === 'completed' || item.kind === 'failed') &&
      (item.completedAt ?? item.updatedAt) >= cutoff &&
      (item.completedAt ?? item.updatedAt) <= openedAt,
  );
  return [...active, ...recentTerminal].sort(compareUpdateRows);
}

function timestampMinusMinutes(timestamp: string, minutes: number): string {
  const value = Date.parse(timestamp);
  const duration = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
  return new Date(value - duration).toISOString();
}

function compareUpdateRows(left: UpdateItem, right: UpdateItem): number {
  return (
    asciiCompare(right.updatedAt, left.updatedAt) ||
    compareDisplayId(left.displayId, right.displayId) ||
    asciiCompare(left.id, right.id)
  );
}

function inboxRow(entry: InboxQuestionProjection, selectedId: string | undefined): InboxRow {
  return {
    id: entry.item.id,
    entityId: entry.item.id,
    displayId: entry.item.displayId,
    entityType: 'question',
    title: entry.item.question,
    statusLabel: questionStatusLabel(entry.item.status),
    revision: entry.item.revision,
    changedAt: entry.statusChangedAt,
    selected: entry.item.id === selectedId,
    category: entry.category,
    userAnswerable: entry.userAnswerable,
    dismissible: entry.dismissible,
    retryableDelivery: entry.retryableDelivery,
    awaitingAcknowledgement: entry.awaitingAcknowledgement,
  };
}

function updateRow(
  item: UpdateItem,
  selectedId: string | undefined,
  recentTerminal: boolean,
): UpdateRow {
  return {
    id: item.id,
    entityId: item.id,
    displayId: item.displayId,
    entityType: 'update',
    title: item.title,
    statusLabel: updateStatusLabel(item.kind, item.archived),
    revision: item.revision,
    changedAt: item.updatedAt,
    selected: item.id === selectedId,
    kind: item.kind,
    recentTerminal,
  };
}

function decisionRow(decision: DecisionRecord, selectedId: string | undefined): DecisionRow {
  return {
    id: decision.id,
    entityId: decision.id,
    displayId: decision.id,
    entityType: 'decision',
    title: decision.question,
    statusLabel: decision.acknowledgement.outcome.toUpperCase(),
    revision: decision.questionRevision,
    changedAt: decision.decidedAt,
    selected: decision.id === selectedId,
    outcome: decision.acknowledgement.outcome as 'applied' | 'superseded',
  };
}

function historyRow(
  entry: ReturnType<typeof selectHistory>['items'][number],
  selectedId: string | undefined,
): HistoryRow {
  const id = `${entry.entityType}:${entry.item.id}`;
  return {
    id,
    entityId: entry.item.id,
    displayId: entry.item.displayId,
    entityType: entry.entityType,
    title: entry.entityType === 'update' ? entry.item.title : entry.item.question,
    statusLabel:
      entry.entityType === 'update'
        ? updateStatusLabel(entry.item.kind, entry.item.archived)
        : questionStatusLabel(entry.item.status),
    revision: entry.item.revision,
    changedAt: entry.terminalAt,
    selected: id === selectedId,
    terminalAt: entry.terminalAt,
    terminalKind: terminalKind(entry),
  };
}

function historyDetail(
  state: BoardState,
  entry: ReturnType<typeof selectHistory>['items'][number],
): HistoryDetailModel | undefined {
  if (entry.entityType === 'update') {
    return {
      entityType: 'update',
      terminalAt: entry.terminalAt,
      terminalKind: terminalKind(entry),
      item: entry.item,
    };
  }
  const projection = selectQuestionDetail(state, entry.item.id as QuestionId);
  return projection === undefined
    ? undefined
    : {
        entityType: 'question',
        terminalAt: entry.terminalAt,
        terminalKind: terminalKind(entry),
        projection,
      };
}

function terminalKind(
  entry: ReturnType<typeof selectHistory>['items'][number],
): HistoryRow['terminalKind'] {
  if (entry.entityType === 'update') {
    if (entry.item.archived) return 'archived';
    return entry.item.kind === 'failed' ? 'failed' : 'completed';
  }
  return entry.item.status as Extract<
    QuestionStatus,
    'cancelled' | 'dismissed' | 'stale' | 'resolved'
  >;
}

function catchUpModel(state: BoardState, openedAt: string): CatchUpHeaderModel {
  const projection = selectCatchUp(state, openedAt);
  const items = projection.items.map((entry) => {
    const source =
      entry.entityType === 'update'
        ? state.updates.get(entry.itemId as UpdateItem['id'])
        : state.questions.get(entry.itemId as QuestionItem['id']);
    return {
      entityType: entry.entityType,
      entityId: entry.itemId,
      occurredAt: entry.occurredAt,
      eventId: entry.eventId,
      category: entry.category,
      changeKind: entry.change.kind,
      ...(source === undefined ? {} : { displayId: source.displayId }),
      ...(source === undefined
        ? {}
        : {
            title:
              entry.entityType === 'update'
                ? (source as UpdateItem).title
                : (source as QuestionItem).question,
          }),
    };
  });
  return {
    visible: items.length > 0,
    total: items.length,
    label:
      items.length === 0
        ? 'No changes since last viewed.'
        : `Since last viewed: ${items.length} ${items.length === 1 ? 'change' : 'changes'}.`,
    counts: projection.counts,
    items,
  };
}

function questionStatusLabel(status: QuestionStatus): string {
  switch (status) {
    case 'pending':
      return 'PENDING';
    case 'blocking':
      return 'BLOCKED';
    case 'answered':
    case 'delivery_queued':
      return 'SENT';
    case 'delivery_failed':
      return 'DELIVERY FAILED';
    case 'needs_attention':
      return 'NEEDS ATTENTION';
    case 'resolved':
      return 'RESOLVED';
    case 'stale':
      return 'STALE';
    case 'cancelled':
      return 'CANCELLED';
    case 'dismissed':
      return 'DISMISSED';
  }
}

function updateStatusLabel(kind: UpdateKind, archived: boolean): string {
  if (archived) return 'ARCHIVED';
  switch (kind) {
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

function isRecentTerminalUpdate(item: UpdateItem): boolean {
  return !item.archived && (item.kind === 'completed' || item.kind === 'failed');
}

function selectRow<T>(
  values: readonly T[],
  selections: BoardViewSelections,
  tab: BoardTab,
  idOf: (value: T) => string,
): { readonly id?: string; readonly value?: T } {
  const explicitlySelected = Object.hasOwn(selections, tab);
  const requestedId = selections[tab];
  if (explicitlySelected) {
    const value = values.find((entry) => idOf(entry) === requestedId);
    return value === undefined ? {} : { id: idOf(value), value };
  }
  const value = values[0];
  return value === undefined ? {} : { id: idOf(value), value };
}

function compareDisplayId(left: string, right: string): number {
  const leftNumber = Number(left.slice(2));
  const rightNumber = Number(right.slice(2));
  return leftNumber - rightNumber || asciiCompare(left, right);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeLimit(limit: number): number {
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
}

function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => immutableCopy(item))) as T;
  if (typeof value !== 'object' || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = immutableCopy(child);
  return Object.freeze(copy) as T;
}
