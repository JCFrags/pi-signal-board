import { describe, expect, it } from 'vitest';

import {
  decisionDisplayId,
  displaySequence,
  isAnswerId,
  isCommandId,
  isEventId,
  isQuestionId,
  isUpdateId,
  isUuid,
  isUuidV4,
  questionDisplayId,
  RuntimeIdGenerator,
  SequenceUuidSource,
  type UuidSource,
  updateDisplayId,
} from '../../src/domain/ids.js';

const UUIDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-9000-000000000002',
  '00000000-0000-4000-a000-000000000003',
  '00000000-0000-4000-b000-000000000004',
  '00000000-0000-4001-8000-000000000005',
] as const;

describe('runtime ID generation', () => {
  it('generates deterministic, exact prefixed UUIDv4 IDs for every kind', () => {
    const ids = new RuntimeIdGenerator(new SequenceUuidSource(UUIDS));

    const eventId = ids.event();
    const updateId = ids.update();
    const questionId = ids.question();
    const answerId = ids.answer();
    const commandId = ids.command();

    expect(eventId).toBe(`evt_${UUIDS[0]}`);
    expect(updateId).toBe(`upd_${UUIDS[1]}`);
    expect(questionId).toBe(`qst_${UUIDS[2]}`);
    expect(answerId).toBe(`ans_${UUIDS[3]}`);
    expect(commandId).toBe(`ui:${UUIDS[4]}`);
    expect(isEventId(eventId)).toBe(true);
    expect(isUpdateId(updateId)).toBe(true);
    expect(isQuestionId(questionId)).toBe(true);
    expect(isAnswerId(answerId)).toBe(true);
    expect(isCommandId(commandId)).toBe(true);
  });

  it('retries a same-kind collision and remains unique within the runtime', () => {
    const ids = new RuntimeIdGenerator(new SequenceUuidSource([UUIDS[0], UUIDS[0], UUIDS[1]]));

    expect(ids.event()).toBe(`evt_${UUIDS[0]}`);
    expect(ids.event()).toBe(`evt_${UUIDS[1]}`);
  });

  it('generates unique schema-valid production IDs in a large focused sample', () => {
    const ids = new RuntimeIdGenerator();
    const generated = Array.from({ length: 10_000 }, (_, index) => {
      switch (index % 5) {
        case 0:
          return ids.event();
        case 1:
          return ids.update();
        case 2:
          return ids.question();
        case 3:
          return ids.answer();
        default:
          return ids.command();
      }
    });

    expect(new Set(generated).size).toBe(generated.length);
    expect(
      generated.every(
        (id) =>
          isEventId(id) || isUpdateId(id) || isQuestionId(id) || isAnswerId(id) || isCommandId(id),
      ),
    ).toBe(true);
    expect(generated.every((id) => isUuidV4(id.replace(/^(?:evt_|upd_|qst_|ans_|ui:)/u, '')))).toBe(
      true,
    );
  });

  it('rejects an invalid, uppercase, or non-v4 injected UUID', () => {
    for (const value of [
      'not-a-uuid',
      '00000000-0000-4000-8000-00000000000A',
      '00000000-0000-1000-8000-000000000001',
      '00000000-0000-4000-7000-000000000001',
    ]) {
      const ids = new RuntimeIdGenerator(new SequenceUuidSource([value]));
      expect(() => ids.event()).toThrow(TypeError);
    }
  });

  it('fails closed when deterministic input is exhausted or cannot become unique', () => {
    const exhausted = new RuntimeIdGenerator(new SequenceUuidSource([]));
    const repeated: UuidSource = { nextUuid: () => UUIDS[0] };
    const colliding = new RuntimeIdGenerator(repeated);

    expect(() => exhausted.event()).toThrow('Deterministic UUID sequence is exhausted.');
    expect(colliding.event()).toBe(`evt_${UUIDS[0]}`);
    expect(() => colliding.event()).toThrow('UUID source could not provide a unique ID.');
  });
});

describe('ID validation and display counters', () => {
  it('matches schema patterns and length rules', () => {
    expect(isUuid(UUIDS[0])).toBe(true);
    expect(isUuidV4(UUIDS[0])).toBe(true);
    expect(isUpdateId(`upd_${UUIDS[0]}`)).toBe(true);
    expect(isQuestionId(`qst_${UUIDS[0]}`)).toBe(true);
    expect(isAnswerId(`ans_${UUIDS[0]}`)).toBe(true);
    expect(isEventId(`evt_${UUIDS[0]}`)).toBe(true);
    expect(isCommandId('tool:call_1')).toBe(true);
    expect(isCommandId('system:stale:qst_1:2')).toBe(true);
    expect(isCommandId(`ui:${UUIDS[0]}`)).toBe(true);

    expect(isUpdateId(`UPD_${UUIDS[0]}`)).toBe(false);
    expect(isQuestionId(`qst_${UUIDS[0]}extra`)).toBe(false);
    expect(isAnswerId('ans_not-a-uuid')).toBe(false);
    expect(isEventId(`evt_${UUIDS[2].toUpperCase()}`)).toBe(false);
    expect(isCommandId('cmd:value')).toBe(false);
    expect(isCommandId(`tool:${'a'.repeat(241)}`)).toBe(false);
  });

  it('formats and extracts branch-local monotonic display counters', () => {
    expect(updateDisplayId(1)).toBe('U-1');
    expect(questionDisplayId(42)).toBe('Q-42');
    expect(decisionDisplayId(Number.MAX_SAFE_INTEGER)).toBe(`D-${Number.MAX_SAFE_INTEGER}`);
    expect(displaySequence('U-1')).toBe(1);
    expect(displaySequence('Q-42')).toBe(42);
    expect(displaySequence(`D-${Number.MAX_SAFE_INTEGER}`)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects invalid display counter input and malformed display IDs', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => updateDisplayId(value)).toThrow(RangeError);
    }

    for (const value of ['U-0', 'Q-01', 'D--1', 'A-1', 'U-9007199254740992']) {
      expect(displaySequence(value)).toBeUndefined();
    }
  });
});
