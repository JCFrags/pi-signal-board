import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { QuestionId } from '../domain/ids.js';
import { validAnswerValue } from '../domain/invariants.js';
import { sanitizeText, TEXT_FIELD_POLICIES } from '../domain/sanitization.js';
import type { AnswerValue, OptionId, QuestionItem } from '../domain/types.js';
import { projectRecommendationAnswer } from '../questions/validation/index.js';
import {
  MultipleAnswerComponent,
  type MultipleAnswerSelectionResult,
} from '../ui/board/multiple-answer-component.js';

const WRITE_ANOTHER_ANSWER = 'Write another answer…';
const INVALID_ANSWER_NOTICE =
  'Answer is empty or exceeds the supported limit. No answer was saved.';
const COMBINED_CONFIRMATION =
  'Submit both the selected options and the written answer? Cancel returns to selection.';

export interface ManualAnswerIntent {
  readonly questionId: QuestionId;
  readonly expectedRevision: number;
  readonly source: 'manual';
  readonly value: AnswerValue;
}

export type AnswerInteractionResult =
  | { readonly kind: 'intent'; readonly intent: ManualAnswerIntent }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'unavailable';
      readonly code: 'SB_UI_UNAVAILABLE' | 'SB_NOT_FOUND' | 'SB_REVISION_MISMATCH';
    }
  | { readonly kind: 'invalid'; readonly code: 'SB_INVALID_ARGUMENT' };

/** Collect one manual answer without clock, persistence, message, runtime, or service access. */
export async function collectAnswerIntent(
  context: ExtensionContext,
  question: QuestionItem | undefined,
  openedRevision: number,
): Promise<AnswerInteractionResult> {
  if (question === undefined) return unavailable('SB_NOT_FOUND');
  if (question.revision !== openedRevision || !isAnswerable(question)) {
    return unavailable('SB_REVISION_MISMATCH');
  }

  try {
    switch (question.response.kind) {
      case 'single':
      case 'single_or_text':
        if (!hasUi(context, ['select', 'editor'])) return unavailable('SB_UI_UNAVAILABLE');
        return await collectSingle(context, question, openedRevision);
      case 'text':
        if (!hasUi(context, ['editor'])) return unavailable('SB_UI_UNAVAILABLE');
        return await collectText(context, question, openedRevision);
      case 'multiple':
        if (!hasUi(context, ['custom'])) return unavailable('SB_UI_UNAVAILABLE');
        return await collectMultiple(context, question, openedRevision);
      case 'multiple_or_text':
        if (!hasUi(context, ['custom', 'editor', 'confirm'])) {
          return unavailable('SB_UI_UNAVAILABLE');
        }
        return await collectMultiple(context, question, openedRevision);
    }
  } catch {
    return unavailable('SB_UI_UNAVAILABLE');
  }
}

/** Compatibility name retained for the accepted SB-031 caller and tests. */
export const collectSingleTextAnswerIntent = collectAnswerIntent;

/** Focused multiple-answer entry point with the same stable result contract. */
export const collectMultipleAnswerIntent = collectAnswerIntent;

async function collectSingle(
  context: ExtensionContext,
  question: QuestionItem,
  openedRevision: number,
): Promise<AnswerInteractionResult> {
  const options = question.response.options ?? [];
  if (!validOptions(options)) return invalid();

  const recommendation = projectRecommendationAnswer(question);
  const optionEntries = options.map((option) => {
    const recommended =
      recommendation?.kind === question.response.kind &&
      'optionId' in recommendation &&
      recommendation.optionId === option.id &&
      (!('text' in recommendation) || recommendation.text === undefined);
    return {
      option,
      baseLabel: `${option.label}${recommended ? ' — Agent recommendation' : ''}`,
    };
  });
  const reserved = new Set<string>(
    question.response.kind === 'single_or_text' ? [WRITE_ANOTHER_ANSWER] : [],
  );
  const labels = optionEntries.map(({ option, baseLabel }) => {
    let label = baseLabel;
    if (reserved.has(label)) label = `${baseLabel} [${option.id}]`;
    reserved.add(label);
    return label;
  });
  const choices =
    question.response.kind === 'single_or_text' ? [...labels, WRITE_ANOTHER_ANSWER] : labels;
  const selected: unknown = await context.ui.select(answerTitle(question), choices);
  if (selected === undefined) return cancelled();
  if (typeof selected !== 'string') return invalid();

  if (question.response.kind === 'single_or_text' && selected === WRITE_ANOTHER_ANSWER) {
    return collectText(context, question, openedRevision);
  }
  const index = labels.indexOf(selected);
  const option = index < 0 ? undefined : options[index];
  if (option === undefined) return invalid();
  const value: AnswerValue =
    question.response.kind === 'single'
      ? { kind: 'single', optionId: option.id }
      : { kind: 'single_or_text', optionId: option.id };
  return validatedIntent(question, openedRevision, value);
}

async function collectMultiple(
  context: ExtensionContext,
  question: QuestionItem,
  openedRevision: number,
): Promise<AnswerInteractionResult> {
  const options = question.response.options ?? [];
  if (!validOptions(options)) return invalid();
  const hybrid = question.response.kind === 'multiple_or_text';
  let selectedOptionIds: readonly OptionId[] = Object.freeze([]);
  let text: string | undefined;

  while (true) {
    let component: MultipleAnswerComponent | undefined;
    let hostResult: unknown;
    try {
      hostResult = await context.ui.custom<MultipleAnswerSelectionResult | undefined>(
        (tui, _theme, _keybindings, done) => {
          component = new MultipleAnswerComponent({
            tui,
            displayId: question.displayId,
            options,
            selectedOptionIds,
            textSupported: hybrid,
            textPresent: text !== undefined,
            done,
          });
          return component;
        },
      );
    } finally {
      component?.dispose();
      component = undefined;
    }

    if (hostResult === undefined) return cancelled();
    if (!isSelectionResult(hostResult)) return invalid();
    if (hostResult.kind === 'cancelled') return cancelled();
    const normalizedIds = normalizeSelectedIds(hostResult.optionIds, options);
    if (normalizedIds === undefined) return invalid();
    selectedOptionIds = normalizedIds;

    if (hostResult.kind === 'text') {
      if (!hybrid) return invalid();
      const editorResult: unknown = await context.ui.editor(answerTitle(question), text ?? '');
      if (editorResult === undefined) continue;
      if (typeof editorResult !== 'string') return invalid();
      const normalized = sanitizeText(editorResult, TEXT_FIELD_POLICIES.answerText);
      if (!normalized.ok) {
        safeNotify(context, INVALID_ANSWER_NOTICE);
        return invalid();
      }
      text = normalized.value;
    }

    if (selectedOptionIds.length === 0 && text === undefined) return invalid();
    if (selectedOptionIds.length > 0 && text !== undefined) {
      const confirmed: unknown = await context.ui.confirm(
        `Submit combined answer for ${question.displayId}?`,
        COMBINED_CONFIRMATION,
      );
      if (typeof confirmed !== 'boolean') return invalid();
      if (!confirmed) continue;
    }

    const value: AnswerValue = hybrid
      ? ({
          kind: 'multiple_or_text',
          optionIds: selectedOptionIds,
          ...(text === undefined ? {} : { text }),
        } as AnswerValue)
      : ({ kind: 'multiple', optionIds: selectedOptionIds } as AnswerValue);
    return validatedIntent(question, openedRevision, value);
  }
}

async function collectText(
  context: ExtensionContext,
  question: QuestionItem,
  openedRevision: number,
): Promise<AnswerInteractionResult> {
  const result: unknown = await context.ui.editor(answerTitle(question), '');
  if (result === undefined) return cancelled();
  if (typeof result !== 'string') return invalid();

  const normalized = sanitizeText(result, TEXT_FIELD_POLICIES.answerText);
  if (!normalized.ok) {
    safeNotify(context, INVALID_ANSWER_NOTICE);
    return invalid();
  }
  const value: AnswerValue =
    question.response.kind === 'text'
      ? { kind: 'text', text: normalized.value }
      : { kind: 'single_or_text', text: normalized.value };
  return validatedIntent(question, openedRevision, value);
}

function validatedIntent(
  question: QuestionItem,
  openedRevision: number,
  value: AnswerValue,
): AnswerInteractionResult {
  if (!validAnswerValue(value, question)) return invalid();
  const frozenValue = freezeAnswerValue(value);
  return Object.freeze({
    kind: 'intent',
    intent: Object.freeze({
      questionId: question.id,
      expectedRevision: openedRevision,
      source: 'manual',
      value: frozenValue,
    }),
  });
}

function validOptions(options: readonly { readonly id: OptionId }[]): boolean {
  return options.length >= 2 && new Set(options.map((option) => option.id)).size === options.length;
}

function normalizeSelectedIds(
  value: unknown,
  options: readonly { readonly id: OptionId }[],
): readonly OptionId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const supplied = new Set<OptionId>();
  for (const id of value) {
    if (typeof id !== 'string' || supplied.has(id as OptionId)) return undefined;
    supplied.add(id as OptionId);
  }
  const known = new Set(options.map((option) => option.id));
  if ([...supplied].some((id) => !known.has(id))) return undefined;
  return Object.freeze(
    options.filter((option) => supplied.has(option.id)).map((option) => option.id),
  );
}

function isSelectionResult(value: unknown): value is MultipleAnswerSelectionResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as { readonly kind?: unknown; readonly optionIds?: unknown };
  if (candidate.kind === 'cancelled') return true;
  return (
    (candidate.kind === 'submit' || candidate.kind === 'text') && Array.isArray(candidate.optionIds)
  );
}

function freezeAnswerValue(value: AnswerValue): AnswerValue {
  if ('optionIds' in value) {
    return Object.freeze({
      ...value,
      optionIds: Object.freeze([...value.optionIds]),
    }) as AnswerValue;
  }
  return Object.freeze({ ...value });
}

function answerTitle(question: QuestionItem): string {
  return `Answer ${question.displayId} (revision ${question.revision})`;
}

function isAnswerable(question: QuestionItem): boolean {
  return question.status === 'pending' || question.status === 'blocking';
}

function hasUi(
  context: ExtensionContext,
  methods: readonly ('select' | 'editor' | 'custom' | 'confirm')[],
): boolean {
  try {
    return (
      context.mode === 'tui' &&
      context.hasUI &&
      methods.every((method) => typeof context.ui[method] === 'function')
    );
  } catch {
    return false;
  }
}

function safeNotify(context: ExtensionContext, message: string): void {
  try {
    context.ui.notify(message, 'warning');
  } catch {
    // Notification failure cannot turn invalid input into an answer.
  }
}

function cancelled(): AnswerInteractionResult {
  return Object.freeze({ kind: 'cancelled' });
}

function invalid(): AnswerInteractionResult {
  return Object.freeze({ kind: 'invalid', code: 'SB_INVALID_ARGUMENT' });
}

function unavailable(
  code: Extract<AnswerInteractionResult, { kind: 'unavailable' }>['code'],
): AnswerInteractionResult {
  return Object.freeze({ kind: 'unavailable', code });
}
