import { describe, expect, it } from 'vitest';
import {
  sanitizeMultiline,
  sanitizeOneLine,
  sanitizeText,
  TEXT_FIELD_POLICIES,
  validatePersistedText,
} from '../../src/domain/sanitization.js';

function resultValue(result: ReturnType<typeof sanitizeOneLine>): string {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Synthetic sanitizer fixture failed: ${result.reason}`);
  }
  return result.value;
}

describe('text sanitization', () => {
  it('normalizes line endings and preserves allowed multiline LF and tab', () => {
    expect(resultValue(sanitizeMultiline('  first\r\n\tsecond\rthird  ', 100))).toBe(
      'first\n\tsecond\nthird',
    );
    expect(resultValue(sanitizeOneLine('  first\r\n\tsecond\rthird  ', 100))).toBe(
      'firstsecondthird',
    );
  });

  it('removes all C0, DEL, and C1 controls under each field mode', () => {
    const c0 = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('');
    const stringIntroducers = new Set([0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f]);
    const c1 = Array.from({ length: 0x20 }, (_, offset) => 0x80 + offset)
      .filter((code) => !stringIntroducers.has(code))
      .map((code) => String.fromCharCode(code))
      .join('');
    const input = `left${c0}\u007fright${c1}end`;

    expect(resultValue(sanitizeOneLine(input, 100))).toBe('leftrightend');
    expect(resultValue(sanitizeMultiline(input, 100))).toBe('left\t\n\nrightend');
  });

  const terminalSequenceCases = [
    ['CSI SGR', '\u001b[31mred\u001b[0m', 'red'],
    ['CSI cursor', 'a\u001b[2J\u001b[Hdone', 'adone'],
    ['8-bit CSI', `a\u009b31mred\u009b0mz`, 'aredz'],
    ['OSC BEL', 'a\u001b]0;private title\u0007z', 'az'],
    ['OSC ST', 'a\u001b]8;;https://invalid.test\u001b\\label\u001b]8;;\u001b\\z', 'alabelz'],
    ['8-bit OSC/ST', 'a\u009d0;private title\u009cz', 'az'],
    ['DCS', 'a\u001bPprivate payload\u001b\\z', 'az'],
    ['8-bit DCS', 'a\u0090private payload\u009cz', 'az'],
    ['SOS', 'a\u001bXprivate payload\u001b\\z', 'az'],
    ['8-bit SOS', 'a\u0098private payload\u009cz', 'az'],
    ['PM', 'a\u001b^private payload\u001b\\z', 'az'],
    ['8-bit PM', 'a\u009eprivate payload\u009cz', 'az'],
    ['APC', 'a\u001b_private payload\u001b\\z', 'az'],
    ['8-bit APC', 'a\u009fprivate payload\u009cz', 'az'],
    ['ANSI reset', 'before\u001bcafter', 'beforeafter'],
    ['ANSI charset', 'before\u001b(0after', 'beforeafter'],
    ['unterminated CSI', 'safe\u001b[31', 'safe'],
    ['unterminated OSC', 'safe\u001b]0;private', 'safe'],
    ['unterminated DCS', 'safe\u001bPprivate', 'safe'],
    ['lone ESC', 'safe\u001b', 'safe'],
  ] as const;

  it.each(terminalSequenceCases)('removes %s terminal effects', (_name, input, expected) => {
    expect(resultValue(sanitizeMultiline(input, 100))).toBe(expected);
  });

  it('replaces lone surrogates without changing valid supplementary code points', () => {
    expect(resultValue(sanitizeOneLine('a\ud800b\udc00c😀', 10))).toBe('a�b�c😀');
  });

  it('trims outer whitespace and collapses one-line horizontal spacing only', () => {
    expect(resultValue(sanitizeOneLine(' \u00a0 alpha   beta \u2003 gamma ', 100))).toBe(
      'alpha beta gamma',
    );
    expect(resultValue(sanitizeMultiline(' \talpha   beta\n\t gamma\t ', 100))).toBe(
      'alpha   beta\n\t gamma',
    );
  });

  it('enforces limits after sanitization by Unicode code point', () => {
    expect(sanitizeOneLine('\u001b[31m😀😀\u001b[0m', 2)).toEqual({
      ok: true,
      value: '😀😀',
      codePointLength: 2,
    });
    expect(sanitizeOneLine('😀😀x', 2)).toEqual({
      ok: false,
      reason: 'too_long',
      codePointLength: 3,
      maxCodePoints: 2,
    });
  });

  it('rejects content that becomes empty and rejects invalid limits', () => {
    expect(sanitizeOneLine('\u001b[31m\u001b[0m', 10)).toEqual({
      ok: false,
      reason: 'empty',
      codePointLength: 0,
      maxCodePoints: 10,
    });
    expect(sanitizeOneLine('text', 0)).toEqual({
      ok: false,
      reason: 'invalid_limit',
      codePointLength: 0,
      maxCodePoints: 0,
    });
  });

  it('exposes stable field policies that match schema limits and newline rules', () => {
    expect(TEXT_FIELD_POLICIES.updateTitle).toEqual({ mode: 'one_line', maxCodePoints: 160 });
    expect(TEXT_FIELD_POLICIES.updateDetail).toEqual({ mode: 'multiline', maxCodePoints: 4000 });
    expect(TEXT_FIELD_POLICIES.question).toEqual({ mode: 'one_line', maxCodePoints: 160 });
    expect(TEXT_FIELD_POLICIES.answerText).toEqual({ mode: 'multiline', maxCodePoints: 4000 });
    expect(resultValue(sanitizeText('line one\r\nline two', TEXT_FIELD_POLICIES.answerText))).toBe(
      'line one\nline two',
    );
  });

  it('validates persisted text without rewriting non-canonical values', () => {
    expect(validatePersistedText('canonical text', 'one_line', 100)).toEqual({
      ok: true,
      value: 'canonical text',
      codePointLength: 14,
    });
    expect(validatePersistedText('not   canonical', 'one_line', 100)).toEqual({
      ok: false,
      reason: 'not_canonical',
      codePointLength: 13,
      maxCodePoints: 100,
    });
    expect(validatePersistedText('unsafe\u001b[31m', 'one_line', 100)).toEqual({
      ok: false,
      reason: 'not_canonical',
      codePointLength: 6,
      maxCodePoints: 100,
    });
  });

  it('is idempotent for the normative terminal security corpus', () => {
    const controls = Array.from({ length: 0xa0 }, (_, code) => String.fromCharCode(code));
    const corpus = [
      ...terminalSequenceCases.map(([, input]) => input),
      ...controls.map((control, index) => `fixture-${index}${control}tail`),
      'plain synthetic text',
      'line one\r\nline two\rline three',
      '\ud800lone high and lone low\udfff',
      '😀 supplementary code point',
    ];

    for (const input of corpus) {
      const once = sanitizeMultiline(input, 10_000);
      expect(once.ok).toBe(true);
      if (!once.ok) {
        continue;
      }
      expect(sanitizeMultiline(once.value, 10_000)).toEqual(once);
    }
  });

  it('is deterministic and idempotent for 1,000 generated Unicode/control fixtures', () => {
    let state = 0x6d2b79f5;
    const next = (): number => {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      return (state ^ (state >>> 14)) >>> 0;
    };

    for (let fixture = 0; fixture < 1_000; fixture += 1) {
      let input = `fixture-${fixture}:`;
      for (let index = 0; index < 32; index += 1) {
        const sample = next() % 8;
        if (sample === 0) input += '\u001b[31m';
        else if (sample === 1) input += '\u001b]8;;https://invalid.test\u0007';
        else if (sample === 2) input += String.fromCharCode(next() % 0xa0);
        else if (sample === 3) input += '\ud800';
        else input += String.fromCodePoint(0x20 + (next() % (0x10ffff - 0x20)));
      }

      const first = sanitizeMultiline(input, 10_000);
      const repeated = sanitizeMultiline(input, 10_000);
      expect(repeated).toEqual(first);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(sanitizeMultiline(first.value, 10_000)).toEqual(first);
      }
    }
  });
});
