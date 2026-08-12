import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { QuestionId } from '../domain/ids.js';
import { validAnswerValue } from '../domain/invariants.js';
import { sanitizeText, TEXT_FIELD_POLICIES } from '../domain/sanitization.js';
import type { AnswerValue, QuestionItem } from '../domain/types.js';
import { projectRecommendationAnswer } from '../questions/validation/index.js';

const WRITE_ANOTHER_ANSWER = 'Write another answer…';
const INVALID_ANSWER_NOTICE =
  'Answer is empty or exceeds the supported limit. No answer was saved.';

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

/**
 * Collect one manual single-choice or text answer. This boundary has no clock,
 * persistence, message, runtime, or service access.
 */
export async function collectSingleTextAnswerIntent(
  context: ExtensionContext,
  question: QuestionItem | undefined,
  openedRevision: number,
): Promise<AnswerInteractionResult> {
  if (question === undefined) return unavailable('SB_NOT_FOUND');
  if (question.revision !== openedRevision || !isAnswerable(question)) {
    return unavailable('SB_REVISION_MISMATCH');
  }
  if (!hasDialogUi(context)) return unavailable('SB_UI_UNAVAILABLE');

  try {
    switch (question.response.kind) {
      case 'single':
      case 'single_or_text':
        return await collectSingle(context, question, openedRevision);
      case 'text':
        return await collectText(context, question, openedRevision);
      case 'multiple':
      case 'multiple_or_text':
        return unavailable('SB_UI_UNAVAILABLE');
    }
  } catch {
    return unavailable('SB_UI_UNAVAILABLE');
  }
}

async function collectSingle(
  context: ExtensionContext,
  question: QuestionItem,
  openedRevision: number,
): Promise<AnswerInteractionResult> {
  const options = question.response.options;
  if (!Array.isArray(options) || options.length < 2) return invalid();

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
  return Object.freeze({
    kind: 'intent',
    intent: Object.freeze({
      questionId: question.id,
      expectedRevision: openedRevision,
      source: 'manual',
      value: Object.freeze({ ...value }),
    }),
  });
}

function answerTitle(question: QuestionItem): string {
  return `Answer ${question.displayId} (revision ${question.revision})`;
}

function isAnswerable(question: QuestionItem): boolean {
  return question.status === 'pending' || question.status === 'blocking';
}

function hasDialogUi(context: ExtensionContext): boolean {
  try {
    return (
      context.mode === 'tui' &&
      context.hasUI &&
      typeof context.ui.select === 'function' &&
      typeof context.ui.editor === 'function'
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
