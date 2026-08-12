export type TextMode = 'one_line' | 'multiline';

export interface TextPolicy {
  readonly mode: TextMode;
  readonly maxCodePoints: number;
}

export type TextFailureReason = 'empty' | 'too_long' | 'not_canonical' | 'invalid_limit';

export type TextResult =
  | {
      readonly ok: true;
      readonly value: string;
      readonly codePointLength: number;
    }
  | {
      readonly ok: false;
      readonly reason: TextFailureReason;
      readonly codePointLength: number;
      readonly maxCodePoints: number;
    };

/**
 * Text policies mirror the schema limits. Services use these named policies so
 * newline handling and code-point limits do not vary between call sites.
 */
export const TEXT_FIELD_POLICIES = Object.freeze({
  updateKey: policy('one_line', 80),
  updateTitle: policy('one_line', 160),
  updateDetail: policy('multiline', 4000),
  question: policy('one_line', 160),
  questionReason: policy('multiline', 4000),
  recommendation: policy('one_line', 1000),
  recommendedText: policy('multiline', 4000),
  workItem: policy('one_line', 240),
  optionId: policy('one_line', 32),
  optionLabel: policy('one_line', 160),
  optionDescription: policy('one_line', 500),
  temporaryDefaultDisclosure: policy('one_line', 1000),
  attachmentLabel: policy('one_line', 160),
  attachmentPath: policy('one_line', 1000),
  attachmentReference: policy('one_line', 1000),
  attachmentUrl: policy('one_line', 2000),
  attachmentNote: policy('multiline', 4000),
  progressUnit: policy('one_line', 32),
  answerText: policy('multiline', 4000),
  acknowledgementSummary: policy('one_line', 2000),
  revisionSummary: policy('one_line', 1000),
  transitionReason: policy('one_line', 1000),
  answerInstruction: policy('one_line', 1000),
} as const);

const ESCAPE = 0x1b;
const DELETE = 0x7f;
const C1_START = 0x80;
const C1_END = 0x9f;
const C1_DCS = 0x90;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;
const C1_SOS = 0x98;

/** Sanitize a field that must not contain newline or tab. */
export function sanitizeOneLine(value: string, maxCodePoints: number): TextResult {
  return sanitize(value, 'one_line', maxCodePoints);
}

/** Sanitize a field that permits normalized LF and tab inside its content. */
export function sanitizeMultiline(value: string, maxCodePoints: number): TextResult {
  return sanitize(value, 'multiline', maxCodePoints);
}

/** Apply a named policy to command text. */
export function sanitizeText(value: string, textPolicy: TextPolicy): TextResult {
  return sanitize(value, textPolicy.mode, textPolicy.maxCodePoints);
}

/**
 * Validate durable text without rewriting it. Replay must skip non-canonical
 * historical text rather than silently changing accepted event data.
 */
export function validatePersistedText(
  value: string,
  mode: TextMode,
  maxCodePoints: number,
): TextResult {
  const result = sanitize(value, mode, maxCodePoints);
  if (!result.ok || result.value === value) {
    return result;
  }

  return failure('not_canonical', result.codePointLength, maxCodePoints);
}

function policy(mode: TextMode, maxCodePoints: number): TextPolicy {
  return Object.freeze({ mode, maxCodePoints });
}

function sanitize(value: string, mode: TextMode, maxCodePoints: number): TextResult {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
    return failure('invalid_limit', 0, maxCodePoints);
  }

  const normalized = replaceLoneSurrogates(value.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
  const withoutEffects = stripTerminalEffects(normalized, mode);
  const trimmed = withoutEffects.trim();
  const sanitized = mode === 'one_line' ? trimmed.replace(/[\p{Zs}]+/gu, ' ') : trimmed;
  const codePointLength = countCodePoints(sanitized);

  if (codePointLength === 0) {
    return failure('empty', 0, maxCodePoints);
  }
  if (codePointLength > maxCodePoints) {
    return failure('too_long', codePointLength, maxCodePoints);
  }

  return Object.freeze({ ok: true, value: sanitized, codePointLength });
}

function stripTerminalEffects(value: string, mode: TextMode): string {
  let output = '';
  let index = 0;

  while (index < value.length) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit === ESCAPE) {
      index = consumeEscape(value, index);
      continue;
    }
    if (codeUnit === C1_CSI) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (codeUnit === C1_OSC) {
      index = consumeControlString(value, index + 1, true);
      continue;
    }
    if (codeUnit === C1_DCS || codeUnit === C1_SOS || codeUnit === C1_PM || codeUnit === C1_APC) {
      index = consumeControlString(value, index + 1, false);
      continue;
    }
    if (isForbiddenControl(codeUnit, mode)) {
      index += 1;
      continue;
    }

    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    output += String.fromCodePoint(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }

  return output;
}

function consumeEscape(value: string, escapeIndex: number): number {
  const introducer = value.charCodeAt(escapeIndex + 1);
  if (Number.isNaN(introducer)) {
    return escapeIndex + 1;
  }

  if (introducer === 0x5b) {
    return consumeCsi(value, escapeIndex + 2);
  }
  if (introducer === 0x5d) {
    return consumeControlString(value, escapeIndex + 2, true);
  }
  if (introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) {
    return consumeControlString(value, escapeIndex + 2, false);
  }

  let index = escapeIndex + 1;
  while (index < value.length && isEscapeIntermediate(value.charCodeAt(index))) {
    index += 1;
  }
  if (index < value.length && isEscapeFinal(value.charCodeAt(index))) {
    return index + 1;
  }
  return escapeIndex + 1;
}

function consumeCsi(value: string, contentIndex: number): number {
  let index = contentIndex;
  while (index < value.length) {
    const codeUnit = value.charCodeAt(index);
    index += 1;
    if (codeUnit >= 0x40 && codeUnit <= 0x7e) {
      return index;
    }
  }
  return value.length;
}

function consumeControlString(
  value: string,
  contentIndex: number,
  bellTerminates: boolean,
): number {
  let index = contentIndex;
  while (index < value.length) {
    const codeUnit = value.charCodeAt(index);
    if (bellTerminates && codeUnit === 0x07) {
      return index + 1;
    }
    if (codeUnit === C1_ST) {
      return index + 1;
    }
    if (codeUnit === ESCAPE && value.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
    index += 1;
  }
  return value.length;
}

function isForbiddenControl(codeUnit: number, mode: TextMode): boolean {
  if (codeUnit < 0x20) {
    return mode !== 'multiline' || (codeUnit !== 0x09 && codeUnit !== 0x0a);
  }
  return codeUnit === DELETE || (codeUnit >= C1_START && codeUnit <= C1_END);
}

function isEscapeIntermediate(codeUnit: number): boolean {
  return codeUnit >= 0x20 && codeUnit <= 0x2f;
}

function isEscapeFinal(codeUnit: number): boolean {
  return codeUnit >= 0x30 && codeUnit <= 0x7e;
}

function replaceLoneSurrogates(value: string): string {
  let output = '';
  let index = 0;
  while (index < value.length) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value.slice(index, index + 2);
        index += 2;
        continue;
      }
      output += '\ufffd';
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      output += '\ufffd';
      index += 1;
      continue;
    }
    output += value[index];
    index += 1;
  }
  return output;
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
  }
  return count;
}

function failure(
  reason: TextFailureReason,
  codePointLength: number,
  maxCodePoints: number,
): TextResult {
  return Object.freeze({ ok: false, reason, codePointLength, maxCodePoints });
}
