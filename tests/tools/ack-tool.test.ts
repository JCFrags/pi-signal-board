import { visibleWidth } from '@earendil-works/pi-tui';
import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { ACK_TOOL_NAME } from '../../src/constants.js';
import type { BoardEvent } from '../../src/domain/events.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import {
  ACK_TOOL_PARAMETERS,
  type AckToolDetails,
  type AckToolInput,
} from '../../src/tools/ack-tool.js';
import { FakePiHarness, makeCustomEntry } from '../helpers/fake-pi.js';

const SUPPORTED = evaluateHostCompatibility({ nodeVersion: '24.18.0', piVersion: '0.84.1' });
const QUESTION = 'qst_71000000-0000-4000-8000-000000000001' as const;
const ANSWER = 'ans_71000000-0000-4000-8000-000000000001' as const;
const UNKNOWN = 'ans_71000000-0000-4000-8000-000000000099' as const;
const CREATED = 'evt_71000000-0000-4000-8000-000000000001' as const;
const ANSWERED = 'evt_71000000-0000-4000-8000-000000000002' as const;
const QUEUED = 'evt_71000000-0000-4000-8000-000000000003' as const;
const AT = '2026-08-12T10:00:00.000Z';

const EVENTS: readonly BoardEvent[] = [
  {
    schemaVersion: 1,
    eventId: CREATED,
    eventType: 'question.created',
    occurredAt: AT,
    actor: 'agent',
    commandId: 'tool:create-question',
    payload: {
      questionId: QUESTION,
      displayId: 'Q-1',
      revision: 1,
      createdAt: AT,
      spec: {
        question: 'Use the flat API?',
        reason: 'The local implementation needs one reversible choice.',
        class: 'reversible',
        response: {
          kind: 'single',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
        recommendedOptionIds: ['yes'],
        priority: 'normal',
        blockingPolicy: 'never',
        deliveryMode: 'steer',
        affectedWork: [],
        continuingWork: [],
        attachments: [],
      },
    },
  },
  {
    schemaVersion: 1,
    eventId: ANSWERED,
    eventType: 'question.answered',
    occurredAt: AT,
    actor: 'user',
    commandId: 'ui:answer-question',
    payload: {
      questionId: QUESTION,
      expectedRevision: 1,
      answer: {
        id: ANSWER,
        questionId: QUESTION,
        questionDisplayId: 'Q-1',
        questionRevision: 1,
        source: 'manual',
        value: { kind: 'single', optionId: 'yes' },
        answeredAt: AT,
      },
    },
  },
  {
    schemaVersion: 1,
    eventId: QUEUED,
    eventType: 'answer.delivery_queued',
    occurredAt: AT,
    actor: 'system',
    commandId: `system:delivery:${ANSWER}:1`,
    payload: {
      answerId: ANSWER,
      questionId: QUESTION,
      attempt: 1,
      at: AT,
      mode: 'steer',
    },
  },
];

interface Rendered {
  render(width: number): string[];
}
interface RegisteredAckTool {
  readonly parameters: typeof ACK_TOOL_PARAMETERS;
  execute(
    id: string,
    input: AckToolInput,
  ): Promise<{ content: unknown[]; details: AckToolDetails }>;
  renderCall(
    input: AckToolInput,
    theme: TestTheme,
    context: { lastComponent?: Rendered },
  ): Rendered;
  renderResult(
    result: { content: unknown[]; details?: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: TestTheme,
    context: { lastComponent?: Rendered },
  ): Rendered;
}
interface TestTheme {
  fg(_name: string, text: string): string;
  bold(text: string): string;
}
const theme: TestTheme = { fg: (_name, text) => text, bold: (text) => text };

function setup(options: { empty?: boolean; max?: number } = {}) {
  const harness = new FakePiHarness();
  if (!options.empty) {
    harness.replaceBranch(
      EVENTS.map((event, index) =>
        makeCustomEntry({
          id: `entry-${index + 1}`,
          parentId: index === 0 ? null : `entry-${index}`,
          data: event,
        }),
      ),
    );
  }
  createSignalBoardExtension({
    evaluateCompatibility: () => SUPPORTED,
    loadConfig: async () => ({
      config: {
        ...DEFAULT_CONFIG,
        limits: {
          ...DEFAULT_CONFIG.limits,
          maxAcknowledgementsPerTurn:
            options.max ?? DEFAULT_CONFIG.limits.maxAcknowledgementsPerTurn,
        },
      },
      sources: { global: 'absent', project: 'absent' },
      warnings: [],
    }),
    now: () => new Date('2026-08-12T11:00:00.000Z'),
  })(harness.api);
  const tool = (harness.registrations.tools as Array<RegisteredAckTool & { name: string }>).find(
    (candidate) => candidate.name === ACK_TOOL_NAME,
  );
  if (!tool) throw new Error('Missing acknowledgement tool.');
  return { harness, tool };
}

const input = (outcome: AckToolInput['outcome'] = 'applied'): AckToolInput => ({
  answerId: ANSWER,
  outcome,
  summary: `The answer was ${outcome}.`,
});

async function failure(test: ReturnType<typeof setup>, id: string, value: AckToolInput) {
  await expect(test.tool.execute(id, value)).rejects.toThrow(/^Signals tool failed \(SB_/u);
  const [patch] = await test.harness.dispatch('tool_result', {
    type: 'tool_result',
    toolCallId: id,
    toolName: ACK_TOOL_NAME,
    input: value as Record<string, unknown>,
    content: [{ type: 'text', text: 'host error' }],
    details: undefined,
    isError: true,
  });
  return (patch as { details: AckToolDetails }).details;
}

describe('signal_board_ack schema', () => {
  it('accepts the real acknowledgement shape and rejects unknown fields and malformed IDs', () => {
    expect(Value.Check(ACK_TOOL_PARAMETERS, input())).toBe(true);
    expect(
      Value.Check(ACK_TOOL_PARAMETERS, {
        ...input('cannot_apply'),
        resultingUpdateIds: [],
        attachments: [{ kind: 'note', label: 'Reason', text: 'More input is needed.' }],
      }),
    ).toBe(true);
    expect(Value.Check(ACK_TOOL_PARAMETERS, { ...input(), answerId: 'A-1' })).toBe(false);
    expect(Value.Check(ACK_TOOL_PARAMETERS, { ...input(), extra: true })).toBe(false);
  });
});

describe('signal_board_ack execution', () => {
  it.each(['applied', 'cannot_apply', 'superseded', 'duplicate'] as const)(
    'persists and projects the %s outcome',
    async (outcome) => {
      const test = setup();
      await test.harness.dispatch('session_start');
      const result = await test.tool.execute(`ack-${outcome}`, input(outcome));
      expect(result.details).toMatchObject({
        ok: true,
        value: { answerId: ANSWER, questionId: QUESTION, outcome },
        event: { eventType: 'answer.acknowledged', actor: 'agent' },
        noOp: false,
      });
      if (!result.details.ok) throw new Error('Expected success.');
      expect(result.details.event).toEqual(test.harness.appendCalls.at(-1)?.data);
      if (outcome === 'applied' || outcome === 'superseded') {
        expect(result.details.value.decisionDisplayId).toBe('D-1');
      } else {
        expect(result.details.value.decisionDisplayId).toBeUndefined();
      }
    },
  );

  it('returns not found for an unknown answer', async () => {
    const unknown = setup();
    await unknown.harness.dispatch('session_start');
    expect(await failure(unknown, 'unknown', { ...input(), answerId: UNKNOWN })).toMatchObject({
      ok: false,
      error: { code: 'SB_NOT_FOUND' },
    });
  });

  it('deduplicates an exact command retry and an exact repeated answer ID', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    const first = await test.tool.execute('same', input());
    const commandRetry = await test.tool.execute('same', input());
    const answerRetry = await test.tool.execute('other', input());
    expect(first.details).toMatchObject({ ok: true, noOp: false });
    expect(commandRetry.details).toMatchObject({ ok: true, noOp: true });
    expect(answerRetry.details).toMatchObject({ ok: true, noOp: true });
    expect(test.harness.appendCalls).toHaveLength(1);
  });

  it('rejects a repeated answer ID with different acknowledgement semantics', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    await test.tool.execute('first', input('applied'));
    expect(await failure(test, 'second', input('cannot_apply'))).toMatchObject({
      ok: false,
      error: { code: 'SB_STATE_CONFLICT' },
    });
    expect(test.harness.appendCalls).toHaveLength(1);
  });

  it('maps persistence failure without swapping state and succeeds after retry', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    test.harness.failNextAppend(new Error('PRIVATE persistence stack'));
    expect(await failure(test, 'persist', input())).toMatchObject({
      ok: false,
      error: { code: 'SB_PERSISTENCE_FAILED' },
    });
    expect(test.harness.appendCalls).toHaveLength(0);
    await expect(test.tool.execute('retry', input())).resolves.toMatchObject({
      details: { ok: true, noOp: false },
    });
  });

  it('replays the acknowledgement after runtime replacement and retains idempotency', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    const first = await test.tool.execute('reload-safe', input('superseded'));
    await test.harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    const replayed = await test.tool.execute('reload-safe', input('superseded'));
    expect(first.details).toMatchObject({ ok: true, noOp: false });
    expect(replayed.details).toMatchObject({ ok: true, noOp: true });
    expect(test.harness.appendCalls).toHaveLength(1);
  });

  it('enforces and resets the declared per-turn acknowledgement limit', async () => {
    const firstAnswer = setup({ max: 1 });
    await firstAnswer.harness.dispatch('session_start');
    await firstAnswer.tool.execute('first', input());
    await firstAnswer.harness.dispatch('turn_start');
    const repeated = await firstAnswer.tool.execute('after-reset', input());
    expect(repeated.details).toMatchObject({ ok: true, noOp: true });
  });
});

describe('signal_board_ack rendering', () => {
  it('renders bounded useful success, expanded detail, and safe errors', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    const result = await test.tool.execute('render', input());
    const components = [
      test.tool.renderCall(input(), theme, {}),
      test.tool.renderResult(result, { expanded: false, isPartial: false }, theme, {}),
      test.tool.renderResult(result, { expanded: true, isPartial: false }, theme, {}),
      test.tool.renderResult(
        { content: [], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        {},
      ),
    ];
    for (const width of [50, 80, 120]) {
      for (const component of components) {
        expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
    expect(components[1]?.render(80).join('\n')).toContain('OK applied');
    expect(components[2]?.render(80).join('\n')).toContain('question qst_');
    expect(components[3]?.render(80).join('\n')).toContain('ERROR SB_INTERNAL');
  });
});
