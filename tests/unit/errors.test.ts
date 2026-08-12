import { describe, expect, it, vi } from 'vitest';

import {
  convertUnexpectedError,
  ERROR_DEFINITIONS,
  fail,
  fieldError,
  SIGNAL_BOARD_ERROR_CODES,
  signalBoardError,
  succeed,
  type UnexpectedErrorDiagnosticSink,
} from '../../src/domain/errors.js';

describe('public error and result contract', () => {
  it('defines every stable public SB_* code exactly once', () => {
    expect(new Set(SIGNAL_BOARD_ERROR_CODES).size).toBe(15);
    expect(Object.keys(ERROR_DEFINITIONS)).toEqual([...SIGNAL_BOARD_ERROR_CODES]);
    expect(SIGNAL_BOARD_ERROR_CODES.every((code) => code.startsWith('SB_'))).toBe(true);
  });

  it.each(SIGNAL_BOARD_ERROR_CODES)('has stable safe public data for %s', (code) => {
    const definition = ERROR_DEFINITIONS[code];

    expect(definition.message).not.toMatch(/stack|exception|\/home\/|secret/iu);
    expect(typeof definition.retryable).toBe('boolean');
  });

  it('creates an expected error and safe field details', () => {
    const error = signalBoardError('SB_INVALID_ARGUMENT', [
      fieldError('response.options[2].label', 'required'),
      fieldError('/home/alice/private.txt', 'invalid_value'),
    ]);

    expect(error).toEqual({
      code: 'SB_INVALID_ARGUMENT',
      message: ERROR_DEFINITIONS.SB_INVALID_ARGUMENT.message,
      retryable: false,
      fieldErrors: [
        { path: 'response.options[2].label', message: 'This field is required.' },
        { path: 'input', message: 'This field has an invalid value.' },
      ],
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.fieldErrors)).toBe(true);
  });

  it('copies field details and replaces caller-provided content', () => {
    const source = {
      path: 'question',
      message: 'secret rejected value: hunter2',
    };
    const error = signalBoardError('SB_INVALID_ARGUMENT', [source]);
    source.path = 'changed';

    expect(error.fieldErrors).toEqual([
      { path: 'question', message: 'This field has an invalid value.' },
    ]);
    expect(JSON.stringify(error)).not.toContain('hunter2');
  });

  it('constructs discriminated success and failure results', () => {
    expect(succeed({ revision: 2 })).toEqual({ ok: true, value: { revision: 2 } });
    expect(fail(signalBoardError('SB_NOT_FOUND'))).toEqual({
      ok: false,
      error: {
        code: 'SB_NOT_FOUND',
        message: ERROR_DEFINITIONS.SB_NOT_FOUND.message,
        retryable: false,
      },
    });
  });
});

describe('unexpected exception boundary', () => {
  it('does not inspect or expose an exception, message, stack, or content', () => {
    const recordUnexpectedError = vi.fn<UnexpectedErrorDiagnosticSink['recordUnexpectedError']>();
    const cause = new Error('SECRET answer and /home/alice/project/file.ts');
    cause.stack = 'STACK_MARKER\nPRIVATE_CONTENT';

    const error = convertUnexpectedError(cause, {
      correlationIds: { nextCorrelationId: () => 'corr_test-123' },
      at: '2026-08-12T07:30:00.000Z',
      area: 'lifecycle',
      diagnostics: { recordUnexpectedError },
    });

    expect(error).toEqual({
      code: 'SB_INTERNAL',
      message: ERROR_DEFINITIONS.SB_INTERNAL.message,
      retryable: true,
      correlationId: 'corr_test-123',
    });
    expect(recordUnexpectedError).toHaveBeenCalledWith({
      at: '2026-08-12T07:30:00.000Z',
      correlationId: 'corr_test-123',
      area: 'lifecycle',
      category: 'unexpected',
    });
    expect(JSON.stringify([error, recordUnexpectedError.mock.calls])).not.toMatch(
      /SECRET|STACK_MARKER|PRIVATE_CONTENT|\/home\/alice/u,
    );
  });

  it('uses an injected generator and replaces unsafe or throwing generator output', () => {
    const unsafe = convertUnexpectedError('ignored', {
      correlationIds: { nextCorrelationId: () => 'secret answer\nstack' },
      at: '2026-08-12T07:30:00.000Z',
      area: 'ui',
    });
    const throwing = convertUnexpectedError('ignored', {
      correlationIds: {
        nextCorrelationId: () => {
          throw new Error('generator secret');
        },
      },
      at: '2026-08-12T07:30:00.000Z',
      area: 'ui',
    });

    expect(unsafe.correlationId).toBe('sb-invalid-correlation-id');
    expect(throwing.correlationId).toBe('sb-invalid-correlation-id');
  });

  it('normalizes diagnostic time and remains stable when the diagnostic sink throws', () => {
    const recordUnexpectedError = vi.fn(() => {
      throw new Error('diagnostic failure');
    });

    const error = convertUnexpectedError('ignored', {
      correlationIds: { nextCorrelationId: () => 'corr-safe' },
      at: 'PRIVATE question text',
      area: 'ui',
      diagnostics: { recordUnexpectedError },
    });

    expect(error.code).toBe('SB_INTERNAL');
    expect(recordUnexpectedError).toHaveBeenCalledWith({
      at: '1970-01-01T00:00:00.000Z',
      correlationId: 'corr-safe',
      area: 'ui',
      category: 'unexpected',
    });
  });
});
