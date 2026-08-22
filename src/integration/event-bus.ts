import type { AckOutcome, AnswerValue, Attachment } from '../domain/types.js';
import type { SignalBoardRuntime } from '../runtime/types.js';
import type { AgentBoardDeckSnapshot, AgentBoardProviderSnapshot } from './summary-api.js';
import { getAgentBoardDeckSnapshot, getAgentBoardProviderSnapshot } from './summary-api.js';

export const AGENT_BOARD_REQUEST_SUMMARY_EVENT = 'pi-agent-board:request-summary-v1';
export const AGENT_BOARD_SUMMARY_EVENT = 'pi-agent-board:summary-v1';
export const AGENT_BOARD_SUMMARY_CHANGED_EVENT = 'pi-agent-board:summary-changed-v1';
export const AGENT_BOARD_ACTION_REQUEST_EVENT = 'pi-agent-board:action-request-v1';
export const AGENT_BOARD_ACTION_RESPONSE_EVENT = 'pi-agent-board:action-response-v1';
export const AGENT_BOARD_VIEW_REQUEST_EVENT = 'pi-agent-board:view-request-v2';
export const AGENT_BOARD_VIEW_RESPONSE_EVENT = 'pi-agent-board:view-response-v2';
export const AGENT_BOARD_VIEW_CHANGED_EVENT = 'pi-agent-board:view-changed-v2';

export interface AgentBoardSummaryRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
}

export interface AgentBoardSummaryResponse {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly snapshot: AgentBoardDeckSnapshot;
}

export interface AgentBoardSummaryChanged {
  readonly schemaVersion: 1;
  readonly snapshot: AgentBoardDeckSnapshot;
}

export interface AgentBoardViewRequest {
  readonly schemaVersion: 2;
  readonly requestId: string;
  readonly openedAt?: string;
  readonly selections?: {
    readonly inbox?: string;
    readonly updates?: string;
    readonly decisions?: string;
    readonly history?: string;
  };
}
export interface AgentBoardViewResponse {
  readonly schemaVersion: 2;
  readonly requestId: string;
  readonly snapshot: AgentBoardProviderSnapshot;
}
export interface AgentBoardViewChanged {
  readonly schemaVersion: 2;
  readonly snapshot: AgentBoardProviderSnapshot;
}

export interface AgentBoardEventBus {
  readonly on: (channel: string, handler: (data: unknown) => void) => () => void;
  readonly emit: (channel: string, data: unknown) => void;
}

export type AgentBoardAnswerValue = AnswerValue;

export type AgentBoardActionRequest =
  | { readonly schemaVersion: 1; readonly requestId: string; readonly action: 'open-ui' }
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly action: 'answer-question';
      readonly questionId: string;
      readonly expectedRevision: number;
      readonly source: 'manual' | 'recommendation';
      readonly value: AgentBoardAnswerValue;
    }
  | { readonly schemaVersion: 2; readonly requestId: string; readonly action: 'open-ui' }
  | {
      readonly schemaVersion: 2;
      readonly requestId: string;
      readonly action: 'answer-question' | 'accept-recommendation' | 'dismiss-question';
      readonly questionId: string;
      readonly expectedRevision: number;
      readonly value?: AgentBoardAnswerValue;
    }
  | {
      readonly schemaVersion: 2;
      readonly requestId: string;
      readonly action: 'retry-delivery';
      readonly questionId: string;
      readonly expectedRevision: number;
      readonly answerId: string;
    }
  | {
      readonly schemaVersion: 2;
      readonly requestId: string;
      readonly action: 'archive-update';
      readonly updateId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly schemaVersion: 2;
      readonly requestId: string;
      readonly action: 'acknowledge-answer';
      readonly answerId: string;
      readonly outcome: AckOutcome;
      readonly summary: string;
      readonly resultingUpdateIds?: readonly string[];
      readonly attachments?: readonly Attachment[];
    };

export interface AgentBoardActionResponse {
  readonly schemaVersion: 1 | 2;
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: {
    readonly action: AgentBoardActionRequest['action'];
    readonly answerId?: string;
  };
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export interface AgentBoardEventBusActions {
  readonly openUi: () => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly error: AgentBoardActionResponse['error'] }
  >;
  readonly answerQuestion: (
    request: Extract<AgentBoardActionRequest, { schemaVersion: 1; action: 'answer-question' }>,
  ) => Promise<
    | { readonly ok: true; readonly answerId: string }
    | { readonly ok: false; readonly error: AgentBoardActionResponse['error'] }
  >;
  readonly providerAction?: (
    request: Extract<
      AgentBoardActionRequest,
      {
        schemaVersion: 2;
        action:
          | Exclude<AgentBoardActionRequest['action'], 'open-ui' | 'answer-question'>
          | 'answer-question';
      }
    >,
  ) => Promise<
    | { readonly ok: true; readonly value?: Record<string, unknown> }
    | { readonly ok: false; readonly error: AgentBoardActionResponse['error'] }
  >;
  readonly now?: () => string;
}

export interface AgentBoardEventBusRegistration {
  readonly start: () => void;
  readonly notifyCommittedChange: () => void;
  readonly shutdown: () => void;
}

/**
 * Register the independent, same-process deck contract. Pi event listeners do
 * not have reply callbacks, so requests carry requestId and receive a paired
 * response event.
 */
export function registerAgentBoardEventBus(
  events: AgentBoardEventBus,
  getRuntime: () => SignalBoardRuntime | undefined,
  actions?: AgentBoardEventBusActions,
): AgentBoardEventBusRegistration {
  let started = false;
  let lastSnapshotJson: string | undefined;
  let lastViewJson: string | undefined;
  const removeActionListener = events.on(AGENT_BOARD_ACTION_REQUEST_EVENT, (data) => {
    if (!started || !isActionRequest(data) || actions === undefined) return;
    void (async () => {
      const result =
        data.schemaVersion === 1
          ? data.action === 'open-ui'
            ? await actions.openUi()
            : await actions.answerQuestion(data)
          : data.action === 'open-ui'
            ? await actions.openUi()
            : actions.providerAction === undefined
              ? {
                  ok: false as const,
                  error: {
                    code: 'SB_UI_UNAVAILABLE',
                    message: 'Provider action is unavailable.',
                    retryable: true,
                  },
                }
              : await actions.providerAction(data as never);
      const response: AgentBoardActionResponse = result.ok
        ? {
            schemaVersion: data.schemaVersion,
            requestId: data.requestId,
            ok: true,
            value: {
              action: data.action,
              ...('value' in result && result.value !== undefined ? result.value : {}),
              ...(data.action === 'answer-question' && 'answerId' in result
                ? { answerId: result.answerId as string }
                : {}),
            },
          }
        : result.error === undefined
          ? { schemaVersion: data.schemaVersion, requestId: data.requestId, ok: false }
          : {
              schemaVersion: data.schemaVersion,
              requestId: data.requestId,
              ok: false,
              error: result.error,
            };
      events.emit(AGENT_BOARD_ACTION_RESPONSE_EVENT, Object.freeze(response));
    })();
  });
  const removeViewListener = events.on(AGENT_BOARD_VIEW_REQUEST_EVENT, (data) => {
    if (!started || !isViewRequest(data)) return;
    const runtime = getRuntime();
    if (runtime === undefined) return;
    let openedAt: string;
    try {
      openedAt = data.openedAt ?? actions?.now?.() ?? new Date().toISOString();
    } catch {
      return;
    }
    events.emit(
      AGENT_BOARD_VIEW_RESPONSE_EVENT,
      Object.freeze({
        schemaVersion: 2,
        requestId: data.requestId,
        snapshot: getAgentBoardProviderSnapshot(runtime, openedAt, data.selections),
      } satisfies AgentBoardViewResponse),
    );
  });
  const removeRequestListener = events.on(AGENT_BOARD_REQUEST_SUMMARY_EVENT, (data) => {
    if (!started || !isSummaryRequest(data)) return;
    const runtime = getRuntime();
    if (runtime === undefined) return;
    events.emit(
      AGENT_BOARD_SUMMARY_EVENT,
      Object.freeze({
        schemaVersion: 1,
        requestId: data.requestId,
        snapshot: getAgentBoardDeckSnapshot(runtime),
      } satisfies AgentBoardSummaryResponse),
    );
  });

  return {
    start() {
      started = true;
      lastSnapshotJson = undefined;
    },
    notifyCommittedChange() {
      if (!started) return;
      const runtime = getRuntime();
      if (runtime === undefined) return;
      const snapshot = getAgentBoardDeckSnapshot(runtime);
      const snapshotJson = JSON.stringify(snapshot);
      if (snapshotJson !== lastSnapshotJson) {
        lastSnapshotJson = snapshotJson;
        events.emit(
          AGENT_BOARD_SUMMARY_CHANGED_EVENT,
          Object.freeze({ schemaVersion: 1, snapshot } satisfies AgentBoardSummaryChanged),
        );
      }
      try {
        const openedAt = actions?.now?.() ?? new Date().toISOString();
        const view = getAgentBoardProviderSnapshot(runtime, openedAt);
        const viewJson = JSON.stringify(view);
        if (viewJson !== lastViewJson) {
          lastViewJson = viewJson;
          events.emit(
            AGENT_BOARD_VIEW_CHANGED_EVENT,
            Object.freeze({ schemaVersion: 2, snapshot: view } satisfies AgentBoardViewChanged),
          );
        }
      } catch {
        // Compatibility summary remains available to runtimes without provider config.
      }
    },
    shutdown() {
      started = false;
      lastSnapshotJson = undefined;
      lastViewJson = undefined;
      removeRequestListener();
      removeViewListener();
      removeActionListener();
    },
  };
}

function isActionRequest(data: unknown): data is AgentBoardActionRequest {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as Record<string, unknown>;
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0
  )
    return false;
  if (value.schemaVersion === 1) {
    if (value.action === 'open-ui') return true;
    if (
      value.action !== 'answer-question' ||
      typeof value.questionId !== 'string' ||
      typeof value.expectedRevision !== 'number' ||
      !Number.isInteger(value.expectedRevision)
    )
      return false;
    if (value.source !== 'manual' && value.source !== 'recommendation') return false;
    const answer = value.value as Record<string, unknown> | undefined;
    return (
      answer !== undefined &&
      typeof answer.kind === 'string' &&
      ['text', 'single', 'multiple', 'single_or_text', 'multiple_or_text'].includes(answer.kind)
    );
  }
  if (value.action === 'open-ui') return true;
  if (
    value.action === 'answer-question' ||
    value.action === 'accept-recommendation' ||
    value.action === 'dismiss-question'
  )
    return typeof value.questionId === 'string' && Number.isSafeInteger(value.expectedRevision);
  if (value.action === 'retry-delivery')
    return (
      typeof value.questionId === 'string' &&
      typeof value.answerId === 'string' &&
      Number.isSafeInteger(value.expectedRevision)
    );
  if (value.action === 'archive-update')
    return typeof value.updateId === 'string' && Number.isSafeInteger(value.expectedRevision);
  if (value.action === 'acknowledge-answer')
    return (
      typeof value.answerId === 'string' &&
      typeof value.summary === 'string' &&
      typeof value.outcome === 'string'
    );
  return false;
}

function isViewRequest(data: unknown): data is AgentBoardViewRequest {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as Record<string, unknown>;
  return (
    value.schemaVersion === 2 && typeof value.requestId === 'string' && value.requestId.length > 0
  );
}

function isSummaryRequest(data: unknown): data is AgentBoardSummaryRequest {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as Record<string, unknown>;
  return (
    value.schemaVersion === 1 && typeof value.requestId === 'string' && value.requestId.length > 0
  );
}
