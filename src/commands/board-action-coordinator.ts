import {
  ERROR_DEFINITIONS,
  fail,
  type Result,
  signalBoardError,
  succeed,
} from '../domain/errors.js';
import type { AnswerId } from '../domain/ids.js';
import type { QuestionItem, UpdateItem } from '../domain/types.js';
import type { RuntimeLifecycle } from '../integration/lifecycle.js';
import type { SignalBoardRuntime } from '../runtime/types.js';

export type BoardMutationIntent =
  | 'answer'
  | 'accept_recommendation'
  | 'dismiss'
  | 'retry_delivery'
  | 'archive_update';

export interface BoardActionRuntimeCapture {
  readonly generation: number;
  readonly identityToken: string;
  readonly treeRevision: number;
}

export type BoardActionCapture =
  | {
      readonly intent: 'answer' | 'accept_recommendation' | 'dismiss';
      readonly entityType: 'question';
      readonly entityId: string;
      readonly expectedRevision: number;
      readonly runtime: BoardActionRuntimeCapture;
    }
  | {
      readonly intent: 'retry_delivery';
      readonly entityType: 'question';
      readonly entityId: string;
      readonly expectedRevision: number;
      readonly answerId: AnswerId;
      readonly runtime: BoardActionRuntimeCapture;
    }
  | {
      readonly intent: 'archive_update';
      readonly entityType: 'update';
      readonly entityId: string;
      readonly expectedRevision: number;
      readonly runtime: BoardActionRuntimeCapture;
    };

export type BoardActionEntity = QuestionItem | UpdateItem;

/** Copy the complete immutable writer identity when a board action opens. */
export function captureBoardAction(
  runtime: BoardActionRuntimeCapture,
  action: {
    readonly type: BoardMutationIntent;
    readonly entityId: string;
    readonly expectedRevision: number;
    readonly answerId?: AnswerId;
  },
): BoardActionCapture {
  const capturedRuntime = Object.freeze({ ...runtime });
  if (action.type === 'archive_update') {
    return Object.freeze({
      intent: action.type,
      entityType: 'update',
      entityId: action.entityId,
      expectedRevision: action.expectedRevision,
      runtime: capturedRuntime,
    });
  }
  if (action.type === 'retry_delivery') {
    if (action.answerId === undefined) throw new Error('Retry action has no answer identity.');
    return Object.freeze({
      intent: action.type,
      entityType: 'question',
      entityId: action.entityId,
      expectedRevision: action.expectedRevision,
      answerId: action.answerId,
      runtime: capturedRuntime,
    });
  }
  return Object.freeze({
    intent: action.type,
    entityType: 'question',
    entityId: action.entityId,
    expectedRevision: action.expectedRevision,
    runtime: capturedRuntime,
  });
}

/**
 * One writer boundary for every board mutation intent.
 *
 * Dialogs run before this boundary. The final preflight and accepted locked
 * service call run in the lifecycle queue as one operation.
 */
export class BoardActionCoordinator {
  readonly #lifecycle: RuntimeLifecycle;

  constructor(lifecycle: RuntimeLifecycle) {
    this.#lifecycle = lifecycle;
  }

  run<T>(
    capture: BoardActionCapture,
    mutationLocked: (
      runtime: SignalBoardRuntime,
      entity: BoardActionEntity,
    ) => Result<T> | Promise<Result<T>>,
  ): Promise<Result<T>> {
    return this.#lifecycle.queue.run(async () => {
      const runtime = this.#lifecycle.slot.current();
      if (!sameRuntime(runtime, capture.runtime)) {
        return fail(signalBoardError('SB_STATE_CONFLICT'));
      }

      const entity =
        capture.entityType === 'question'
          ? runtime.state.questions.get(capture.entityId as QuestionItem['id'])
          : runtime.state.updates.get(capture.entityId as UpdateItem['id']);
      if (entity === undefined) return fail(signalBoardError('SB_NOT_FOUND'));
      if (entity.revision !== capture.expectedRevision) {
        return fail(signalBoardError('SB_REVISION_MISMATCH'));
      }
      if (!statePermits(capture, entity)) return fail(signalBoardError('SB_STATE_CONFLICT'));

      try {
        return await mutationLocked(runtime, entity);
      } catch {
        return fail(
          Object.freeze({
            code: 'SB_INTERNAL',
            message: ERROR_DEFINITIONS.SB_INTERNAL.message,
            retryable: ERROR_DEFINITIONS.SB_INTERNAL.retryable,
          }),
        );
      }
    });
  }

  /** Run the same preflight for an intent whose mutation service is not in this slice. */
  preflight(capture: BoardActionCapture): Promise<Result<void>> {
    return this.run(capture, () => succeed(undefined));
  }
}

function sameRuntime(
  runtime: SignalBoardRuntime | undefined,
  captured: BoardActionRuntimeCapture,
): runtime is SignalBoardRuntime {
  return (
    runtime !== undefined &&
    !runtime.disposed &&
    runtime.status === 'healthy' &&
    runtime.compatibility.supported &&
    runtime.generation === captured.generation &&
    runtime.identity.token === captured.identityToken &&
    runtime.treeRevision === captured.treeRevision
  );
}

function statePermits(capture: BoardActionCapture, entity: BoardActionEntity): boolean {
  if (capture.entityType === 'update') {
    const update = entity as UpdateItem;
    return !update.archived && (update.kind === 'completed' || update.kind === 'failed');
  }

  const question = entity as QuestionItem;
  if (capture.intent === 'retry_delivery') {
    return question.status === 'delivery_failed' && question.answerId === capture.answerId;
  }
  return (
    (question.status === 'pending' || question.status === 'blocking') &&
    question.answerId === undefined
  );
}
