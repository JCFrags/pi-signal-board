import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import type { EffectiveConfig } from '../../../src/config/types.js';
import type { QuestionId, UpdateId } from '../../../src/domain/ids.js';
import { createEmptyBoardState } from '../../../src/domain/reducer.js';
import type {
  BoardState,
  QuestionItem,
  QuestionStatus,
  UpdateItem,
  UpdateKind,
  VisibleChangeRecord,
} from '../../../src/domain/types.js';

export const time = (minute: number): string =>
  `2026-08-12T10:${minute.toString().padStart(2, '0')}:00.000Z`;

export function widgetConfig(
  widget: Partial<EffectiveConfig['widget']> = {},
  root: Partial<Pick<EffectiveConfig, 'enabled'>> = {},
): EffectiveConfig {
  return {
    ...DEFAULT_CONFIG,
    ...root,
    widget: { ...DEFAULT_CONFIG.widget, ...widget },
  };
}

export function widgetState(
  input: {
    readonly updates?: readonly UpdateItem[];
    readonly questions?: readonly QuestionItem[];
    readonly visibleChanges?: readonly VisibleChangeRecord[];
  } = {},
): BoardState {
  return {
    ...createEmptyBoardState(),
    updates: new Map((input.updates ?? []).map((item) => [item.id, item])),
    questions: new Map((input.questions ?? []).map((item) => [item.id, item])),
    visibleChanges: input.visibleChanges ?? [],
  };
}

export function widgetUpdate(
  sequence: number,
  kind: UpdateKind,
  changedMinute: number,
  overrides: Partial<UpdateItem> = {},
): UpdateItem {
  return {
    id: `upd_10000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}` as UpdateId,
    displayId: `U-${sequence}`,
    revision: 1,
    kind,
    title: `Update ${sequence}`,
    attachments: [],
    createdAt: time(0),
    updatedAt: time(changedMinute),
    ...(kind === 'completed' || kind === 'failed' ? { completedAt: time(changedMinute) } : {}),
    archived: false,
    lastEventId: `evt_update-${sequence}`,
    lastCommandId: `tool:update-${sequence}`,
    ...overrides,
  } as UpdateItem;
}

export function widgetQuestion(
  sequence: number,
  status: QuestionStatus,
  changedMinute: number,
  overrides: Partial<QuestionItem> = {},
): QuestionItem {
  const id = `qst_20000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}` as QuestionId;
  return {
    id,
    displayId: `Q-${sequence}`,
    revision: 1,
    question: `Question ${sequence}?`,
    reason: `Reason ${sequence}.`,
    class: 'reversible',
    response: {
      kind: 'single',
      options: [
        { id: 'one', label: 'One' },
        { id: 'two', label: 'Two' },
      ],
    },
    recommendedOptionIds: [],
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'steer',
    affectedWork: [],
    continuingWork: [],
    attachments: [],
    status,
    createdAt: time(sequence),
    updatedAt: time(changedMinute),
    lastEventId: `evt_question-${sequence}`,
    lastCommandId: `tool:question-${sequence}`,
    ...overrides,
  } as QuestionItem;
}
