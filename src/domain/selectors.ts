import type { QuestionId, UpdateId } from './ids.js';
import type {
  AnswerAcknowledgement,
  AnswerRecord,
  BoardState,
  DecisionRecord,
  DeliveryAttempt,
  ItemVisibleChange,
  QuestionItem,
  UpdateItem,
  VisibleChangeRecord,
} from './types.js';

export type HistoryItem =
  | { readonly entityType: 'update'; readonly terminalAt: string; readonly item: UpdateItem }
  | { readonly entityType: 'question'; readonly terminalAt: string; readonly item: QuestionItem };

export interface HistoryProjection {
  readonly items: readonly HistoryItem[];
  readonly total: number;
  readonly truncated: boolean;
}

export type WidgetCandidate =
  | {
      readonly entityType: 'update';
      readonly rank: number;
      readonly changedAt: string;
      readonly item: UpdateItem;
    }
  | {
      readonly entityType: 'question';
      readonly rank: number;
      readonly changedAt: string;
      readonly item: QuestionItem;
    };

export type UnreadCategory =
  | 'delivery_attention'
  | 'blocked_failed'
  | 'question'
  | 'completed_applied'
  | 'update';

export interface UnreadChange {
  readonly entityType: 'update' | 'question';
  readonly itemId: UpdateId | QuestionId;
  readonly occurredAt: string;
  readonly eventId: string;
  readonly category: UnreadCategory;
  readonly precedence: number;
  readonly change: ItemVisibleChange;
}

export interface CatchUpProjection {
  readonly items: readonly UnreadChange[];
  readonly counts: Readonly<Record<UnreadCategory, number>>;
}

export interface BoardCounts {
  readonly activeUpdates: number;
  readonly actionableQuestions: number;
  readonly inboxQuestions: number;
  readonly decisions: number;
  readonly history: number;
  readonly unread: number;
}

export type SummaryItem =
  | { readonly entityType: 'question'; readonly item: QuestionItem }
  | { readonly entityType: 'update'; readonly item: UpdateItem };

export interface SummaryProjection {
  readonly counts: BoardCounts;
  readonly items: readonly SummaryItem[];
  readonly totalItems: number;
  readonly omittedItems: number;
}

export type InboxQuestionCategory =
  | 'delivery_failed'
  | 'needs_attention'
  | 'blocking'
  | 'high_pending'
  | 'normal_pending'
  | 'sent';

export interface StaleQuestionDetail {
  readonly reason?: string;
  readonly originalExpiry?: string;
  readonly staleAt?: string;
}

/** Complete read-only question data needed by a later detail view model. */
export interface QuestionDetailProjection {
  readonly item: QuestionItem;
  readonly statusChangedAt: string;
  readonly userAnswerable: boolean;
  readonly dismissible: boolean;
  readonly retryableDelivery: boolean;
  readonly deliveryPending: boolean;
  readonly awaitingAcknowledgement: boolean;
  readonly attentionState?: 'delivery_failed' | 'needs_attention';
  readonly answer?: AnswerRecord;
  readonly acknowledgement?: AnswerAcknowledgement;
  readonly latestDeliveryAttempt?: DeliveryAttempt;
  readonly stale?: StaleQuestionDetail;
}

/** Inbox metadata keeps user-answerable and attention-only states distinct. */
export interface InboxQuestionProjection extends QuestionDetailProjection {
  readonly category: InboxQuestionCategory;
}

/** Select non-archived updates that have not reached a terminal kind. */
export function selectActiveUpdates(state: BoardState): readonly UpdateItem[] {
  return immutable(
    [...state.updates.values()]
      .filter((item) => !item.archived && item.kind !== 'completed' && item.kind !== 'failed')
      .sort(compareUpdatesNewest),
  );
}

/** Select questions on which the user can take a useful action. */
export function selectActionableQuestions(state: BoardState): readonly QuestionItem[] {
  return immutable(
    [...state.questions.values()]
      .filter((item) =>
        ['pending', 'blocking', 'delivery_failed', 'needs_attention'].includes(item.status),
      )
      .sort(compareInboxQuestions),
  );
}

/** Select all Inbox states, including answers queued for acknowledgement. */
export function selectInboxQuestions(state: BoardState): readonly QuestionItem[] {
  return immutable(
    [...state.questions.values()].filter(isInboxQuestion).sort(compareInboxQuestions),
  );
}

/** Select rich projections for all questions that need a useful user action or attention. */
export function selectActionableQuestionProjections(
  state: BoardState,
): readonly InboxQuestionProjection[] {
  return immutable(
    [...state.questions.values()]
      .filter(isActionableQuestion)
      .sort(compareInboxQuestions)
      .map((item) => projectInboxQuestion(state, item)),
  );
}

/** Select rich projections for the complete Inbox, including sent answers. */
export function selectInboxQuestionProjections(
  state: BoardState,
): readonly InboxQuestionProjection[] {
  return immutable(
    [...state.questions.values()]
      .filter(isInboxQuestion)
      .sort(compareInboxQuestions)
      .map((item) => projectInboxQuestion(state, item)),
  );
}

/** Select one question detail without exposing state map or item aliases. */
export function selectQuestionDetail(
  state: BoardState,
  questionId: QuestionId,
): QuestionDetailProjection | undefined {
  const item = state.questions.get(questionId);
  return item === undefined ? undefined : immutable(projectQuestionDetail(state, item));
}

/** Select read-only terminal history, newest first, with deterministic truncation. */
export function selectHistory(
  state: BoardState,
  limit = Number.MAX_SAFE_INTEGER,
): HistoryProjection {
  const safeLimit = normalizeLimit(limit);
  const all: HistoryItem[] = [];
  for (const item of state.updates.values()) {
    const terminalAt = updateHistoryTime(item);
    if (terminalAt !== undefined) all.push({ entityType: 'update', terminalAt, item });
  }
  for (const item of state.questions.values()) {
    const terminalAt = questionHistoryTime(item);
    if (terminalAt !== undefined) all.push({ entityType: 'question', terminalAt, item });
  }
  all.sort(compareHistory);
  return immutable({
    items: all.slice(0, safeLimit),
    total: all.length,
    truncated: all.length > safeLimit,
  });
}

/** Derive applied and superseded decisions. No other acknowledgement creates a Decision. */
export function selectDecisions(state: BoardState): readonly DecisionRecord[] {
  const decisions: DecisionRecord[] = [];
  for (const acknowledgement of state.acknowledgements.values()) {
    if (acknowledgement.outcome !== 'applied' && acknowledgement.outcome !== 'superseded') continue;
    if (acknowledgement.decisionDisplayId === undefined) continue;
    const answer = state.answers.get(acknowledgement.answerId);
    const question = state.questions.get(acknowledgement.questionId);
    if (answer === undefined || question === undefined || question.resolvedAt === undefined)
      continue;
    decisions.push({
      id: acknowledgement.decisionDisplayId,
      questionId: question.id,
      answerId: answer.id,
      questionRevision: answer.questionRevision,
      question: question.question,
      answer: answer.value,
      ...(question.recommendation === undefined ? {} : { recommendation: question.recommendation }),
      actor: 'user',
      reason: question.reason,
      acknowledgement,
      decidedAt: acknowledgement.acknowledgedAt,
      resolvedAt: question.resolvedAt,
    });
  }
  decisions.sort(
    (left, right) =>
      compareNewest(left.decidedAt, right.decidedAt) ||
      compareDisplayId(left.id, right.id) ||
      asciiCompare(left.answerId, right.answerId),
  );
  return immutable(decisions);
}

/** Rank compact-widget candidates. Completed items require an explicit recency cutoff. */
export function selectWidgetCandidates(
  state: BoardState,
  completedWindowCutoff: string,
): readonly WidgetCandidate[] {
  const candidates: WidgetCandidate[] = [];
  for (const item of state.questions.values()) {
    const rank = widgetQuestionRank(item);
    if (rank !== undefined) {
      candidates.push({ entityType: 'question', rank, changedAt: item.updatedAt, item });
    }
  }
  for (const item of state.updates.values()) {
    if (item.archived) continue;
    const rank = widgetUpdateRank(item, completedWindowCutoff);
    if (rank !== undefined) {
      candidates.push({ entityType: 'update', rank, changedAt: item.updatedAt, item });
    }
  }
  candidates.sort(compareWidget);
  return immutable(candidates);
}

/** Select and coalesce semantic unread changes in `(lastViewedAt, openedAt]`. */
export function selectUnreadChanges(state: BoardState, openedAt: string): readonly UnreadChange[] {
  return selectCatchUp(state, openedAt).items;
}

/** Build the catch-up projection without reconstructing persisted events. */
export function selectCatchUp(state: BoardState, openedAt: string): CatchUpProjection {
  const selected = new Map<string, UnreadChange>();
  for (const record of state.visibleChanges) {
    if (!insideWindow(record, state.lastViewedAt, openedAt)) continue;
    const candidate = unreadFromRecord(record);
    const key = `${candidate.entityType}:${candidate.itemId}`;
    const prior = selected.get(key);
    if (prior === undefined || compareUnreadConsequence(candidate, prior) < 0) {
      selected.set(key, candidate);
    }
  }
  const items = [...selected.values()].sort(compareUnreadOutput);
  const counts: Record<UnreadCategory, number> = {
    delivery_attention: 0,
    blocked_failed: 0,
    question: 0,
    completed_applied: 0,
    update: 0,
  };
  for (const item of items) counts[item.category] += 1;
  return immutable({ items, counts });
}

export function selectBoardCounts(state: BoardState, openedAt?: string): BoardCounts {
  return immutable({
    activeUpdates: selectActiveUpdates(state).length,
    actionableQuestions: selectActionableQuestions(state).length,
    inboxQuestions: selectInboxQuestions(state).length,
    decisions: selectDecisions(state).length,
    history: selectHistory(state).total,
    unread: openedAt === undefined ? 0 : selectUnreadChanges(state, openedAt).length,
  });
}

/** Build a deterministic content projection for plain summaries. */
export function selectSummary(state: BoardState, limit = 10, openedAt?: string): SummaryProjection {
  const safeLimit = normalizeLimit(limit);
  const questions: SummaryItem[] = selectActionableQuestions(state).map((item) => ({
    entityType: 'question',
    item,
  }));
  const updates: SummaryItem[] = selectActiveUpdates(state).map((item) => ({
    entityType: 'update',
    item,
  }));
  const all = [...questions, ...updates];
  return immutable({
    counts: selectBoardCounts(state, openedAt),
    items: all.slice(0, safeLimit),
    totalItems: all.length,
    omittedItems: Math.max(0, all.length - safeLimit),
  });
}

function widgetQuestionRank(item: QuestionItem): number | undefined {
  if (item.status === 'delivery_failed' || item.status === 'needs_attention') return 0;
  if (item.status === 'blocking') return 1;
  if (item.status === 'pending' && item.priority === 'high') return 2;
  if (item.status === 'pending') return 5;
  return undefined;
}

function widgetUpdateRank(item: UpdateItem, completedCutoff: string): number | undefined {
  if (item.kind === 'blocked' || item.kind === 'failed') return 3;
  if (item.kind === 'working' || item.kind === 'warning' || item.kind === 'finding') return 4;
  if (item.kind === 'completed' && (item.completedAt ?? item.updatedAt) >= completedCutoff)
    return 6;
  return undefined;
}

function isActionableQuestion(item: QuestionItem): boolean {
  return (
    item.status === 'pending' ||
    item.status === 'blocking' ||
    item.status === 'delivery_failed' ||
    item.status === 'needs_attention'
  );
}

function isInboxQuestion(item: QuestionItem): boolean {
  return (
    isActionableQuestion(item) || item.status === 'answered' || item.status === 'delivery_queued'
  );
}

function projectInboxQuestion(state: BoardState, item: QuestionItem): InboxQuestionProjection {
  return {
    ...projectQuestionDetail(state, item),
    category: inboxCategory(item),
  };
}

function projectQuestionDetail(state: BoardState, item: QuestionItem): QuestionDetailProjection {
  const answer = item.answerId === undefined ? undefined : state.answers.get(item.answerId);
  const acknowledgement =
    item.answerId === undefined ? undefined : state.acknowledgements.get(item.answerId);
  const latestDeliveryAttempt = answer?.deliveryAttempts.reduce<DeliveryAttempt | undefined>(
    (latest, attempt) =>
      latest === undefined || compareDeliveryAttempt(latest, attempt) < 0 ? attempt : latest,
    undefined,
  );
  const userAnswerable = item.status === 'pending' || item.status === 'blocking';
  return {
    item,
    statusChangedAt: item.updatedAt,
    userAnswerable,
    dismissible: userAnswerable,
    retryableDelivery: item.status === 'delivery_failed',
    deliveryPending: item.status === 'answered',
    awaitingAcknowledgement: item.status === 'delivery_queued',
    ...(item.status === 'delivery_failed' || item.status === 'needs_attention'
      ? { attentionState: item.status }
      : {}),
    ...(answer === undefined ? {} : { answer }),
    ...(acknowledgement === undefined ? {} : { acknowledgement }),
    ...(latestDeliveryAttempt === undefined ? {} : { latestDeliveryAttempt }),
    ...(item.status === 'stale'
      ? {
          stale: {
            ...(item.staleReason === undefined ? {} : { reason: item.staleReason }),
            ...(item.expiresAt === undefined ? {} : { originalExpiry: item.expiresAt }),
            ...(item.staleAt === undefined ? {} : { staleAt: item.staleAt }),
          },
        }
      : {}),
  };
}

function compareDeliveryAttempt(left: DeliveryAttempt, right: DeliveryAttempt): number {
  return (
    left.attempt - right.attempt ||
    asciiCompare(left.at, right.at) ||
    asciiCompare(left.mode, right.mode) ||
    asciiCompare(left.outcome, right.outcome)
  );
}

function inboxCategory(item: QuestionItem): InboxQuestionCategory {
  switch (item.status) {
    case 'delivery_failed':
      return 'delivery_failed';
    case 'needs_attention':
      return 'needs_attention';
    case 'blocking':
      return 'blocking';
    case 'pending':
      return item.priority === 'high' ? 'high_pending' : 'normal_pending';
    case 'answered':
    case 'delivery_queued':
      return 'sent';
    default:
      throw new TypeError('Question is not in the Inbox.');
  }
}

function inboxRank(item: QuestionItem): number {
  switch (item.status) {
    case 'delivery_failed':
      return 0;
    case 'needs_attention':
      return 1;
    case 'blocking':
      return 2;
    case 'pending':
      return item.priority === 'high' ? 3 : 4;
    case 'answered':
    case 'delivery_queued':
      return 5;
    default:
      return 6;
  }
}

function compareInboxQuestions(left: QuestionItem, right: QuestionItem): number {
  return (
    inboxRank(left) - inboxRank(right) ||
    asciiCompare(left.createdAt, right.createdAt) ||
    compareDisplayId(left.displayId, right.displayId) ||
    asciiCompare(left.id, right.id)
  );
}

function compareUpdatesNewest(left: UpdateItem, right: UpdateItem): number {
  return (
    compareNewest(left.updatedAt, right.updatedAt) ||
    compareDisplayId(left.displayId, right.displayId) ||
    asciiCompare(left.id, right.id)
  );
}

function compareHistory(left: HistoryItem, right: HistoryItem): number {
  return (
    compareNewest(left.terminalAt, right.terminalAt) ||
    compareDisplayId(left.item.displayId, right.item.displayId) ||
    asciiCompare(left.item.id, right.item.id)
  );
}

function compareWidget(left: WidgetCandidate, right: WidgetCandidate): number {
  return (
    left.rank - right.rank ||
    compareNewest(left.changedAt, right.changedAt) ||
    compareDisplayId(left.item.displayId, right.item.displayId) ||
    asciiCompare(left.item.id, right.item.id)
  );
}

function updateHistoryTime(item: UpdateItem): string | undefined {
  if (item.archived) return item.archivedAt ?? item.updatedAt;
  if (item.kind === 'completed' || item.kind === 'failed')
    return item.completedAt ?? item.updatedAt;
  return undefined;
}

function questionHistoryTime(item: QuestionItem): string | undefined {
  switch (item.status) {
    case 'cancelled':
      return item.cancelledAt ?? item.updatedAt;
    case 'dismissed':
      return item.dismissedAt ?? item.updatedAt;
    case 'stale':
      return item.staleAt ?? item.updatedAt;
    case 'resolved':
      return item.resolvedAt ?? item.updatedAt;
    default:
      return undefined;
  }
}

function insideWindow(
  record: VisibleChangeRecord,
  lastViewedAt: string | undefined,
  openedAt: string,
): boolean {
  return (
    (lastViewedAt === undefined || record.occurredAt > lastViewedAt) &&
    record.occurredAt <= openedAt
  );
}

function unreadFromRecord(record: VisibleChangeRecord): UnreadChange {
  const category = unreadCategory(record.change);
  return {
    entityType: record.change.itemId.startsWith('upd_') ? 'update' : 'question',
    itemId: record.change.itemId,
    occurredAt: record.occurredAt,
    eventId: record.eventId,
    category,
    precedence: unreadPrecedence(category),
    change: record.change,
  };
}

function unreadCategory(change: ItemVisibleChange): UnreadCategory {
  if (change.kind === 'delivery_failed' || change.kind === 'answer_needs_attention') {
    return 'delivery_attention';
  }
  if (
    change.kind === 'update_failed' ||
    change.kind === 'question_blocking' ||
    ('updateKind' in change && change.updateKind === 'blocked')
  )
    return 'blocked_failed';
  if (change.kind.startsWith('question_')) return 'question';
  if (change.kind === 'update_completed' || change.kind === 'answer_applied') {
    return 'completed_applied';
  }
  return 'update';
}

function unreadPrecedence(category: UnreadCategory): number {
  switch (category) {
    case 'delivery_attention':
      return 0;
    case 'blocked_failed':
      return 1;
    case 'question':
      return 2;
    case 'completed_applied':
      return 3;
    case 'update':
      return 4;
  }
}

function compareUnreadConsequence(left: UnreadChange, right: UnreadChange): number {
  return (
    left.precedence - right.precedence ||
    compareNewest(left.occurredAt, right.occurredAt) ||
    asciiCompare(left.eventId, right.eventId)
  );
}

function compareUnreadOutput(left: UnreadChange, right: UnreadChange): number {
  return (
    left.precedence - right.precedence ||
    compareNewest(left.occurredAt, right.occurredAt) ||
    asciiCompare(left.entityType, right.entityType) ||
    asciiCompare(left.itemId, right.itemId) ||
    asciiCompare(left.eventId, right.eventId)
  );
}

function compareNewest(left: string, right: string): number {
  return asciiCompare(right, left);
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

function immutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => immutable(item))) as T;
  if (typeof value !== 'object' || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = immutable(child);
  return Object.freeze(copy) as T;
}
