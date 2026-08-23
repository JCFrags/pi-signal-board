import { visibleWidth } from '@earendil-works/pi-tui';
import { Value } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { QUESTION_TOOL_NAME } from '../../src/constants.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import type { RuntimeLifecycle } from '../../src/integration/lifecycle.js';
import { decodeBoardEvent } from '../../src/persistence/event-codec.js';
import {
  QUESTION_TOOL_DESCRIPTION,
  QUESTION_TOOL_PARAMETERS,
  QUESTION_TOOL_PROMPT_GUIDELINES,
  QUESTION_TOOL_PROMPT_SNIPPET,
  type QuestionToolDetails,
  type QuestionToolInput,
} from '../../src/tools/question-tool.js';
import { FakePiHarness } from '../helpers/fake-pi.js';

const SUPPORTED = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' });
const PROVIDER_QUALIFIED_TOOL_CALL_ID =
  'call_Z6LPv0kJq22rXsNP67ojPhlg|fc_068d35c2414bddfc016a7c4fb7e8f4819881a1ba59d0364046';
const PROVIDER_QUALIFIED_COMMAND_ID = `tool:${PROVIDER_QUALIFIED_TOOL_CALL_ID}`;

const OPTIONS = [
  { id: 'flat', label: 'Flat shape' },
  { id: 'nested', label: 'Nested shape', description: 'Use nested fields.' },
] as const;
const CREATE = {
  operation: 'create',
  question: 'Which local API shape should be used?',
  reason: 'Both implementations are local and reversible.',
  class: 'reversible',
  response: { kind: 'single', options: OPTIONS },
  recommendation: 'Use the flat shape.',
  recommendedOptionIds: ['flat'],
  priority: 'normal',
  blockingPolicy: 'when_agent_settles',
  deliveryMode: 'steer',
  affectedWork: ['Final API implementation'],
  continuingWork: ['Parser tests'],
  temporaryDefault: {
    optionIds: ['flat'],
    disclosure: 'The flat shape remains in local tests while waiting.',
  },
  attachments: [{ kind: 'file', label: 'API types', path: 'src/api/types.ts' }],
} as const;
const REVISE = {
  ...CREATE,
  operation: 'revise',
  id: 'Q-1',
  expectedRevision: 1,
  revisionSummary: 'Added test evidence.',
  priority: 'high',
} as const;
const CANCEL = {
  operation: 'cancel',
  id: 'Q-1',
  expectedRevision: 2,
  reason: 'The implementation now determines the shape.',
} as const;

const RESPONSE_CASES = [
  { kind: 'text' },
  { kind: 'single', options: OPTIONS },
  { kind: 'multiple', options: OPTIONS },
  { kind: 'single_or_text', options: OPTIONS },
  { kind: 'multiple_or_text', options: OPTIONS },
] as const;

interface RegisteredQuestionTool {
  readonly name: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: string[];
  readonly parameters: typeof QUESTION_TOOL_PARAMETERS;
  execute(
    id: string,
    input: QuestionToolInput,
    signal?: AbortSignal,
    onUpdate?: (result: unknown) => void,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: QuestionToolDetails }>;
  renderCall(input: unknown, theme: TestTheme, context: RenderContext): Rendered;
  renderResult(
    result: { content: unknown[]; details?: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: TestTheme,
    context: RenderContext,
  ): Rendered;
}
interface Rendered {
  render(width: number): string[];
}
interface RenderContext {
  lastComponent?: Rendered;
}
interface TestTheme {
  fg(_name: string, text: string): string;
  bold(text: string): string;
}
const theme: TestTheme = { fg: (_name, text) => text, bold: (text) => text };

function setup(
  options: {
    mode?: 'tui' | 'json' | 'print';
    enabled?: boolean;
    compatibility?: ReturnType<typeof evaluateHostCompatibility>;
    replayFailure?: boolean;
    refreshUi?: boolean;
  } = {},
) {
  const harness = new FakePiHarness({ mode: options.mode ?? 'tui' });
  let lifecycle: RuntimeLifecycle | undefined;
  createSignalBoardExtension({
    captureLifecycle(value) {
      lifecycle = value;
    },
    evaluateCompatibility: () => options.compatibility ?? SUPPORTED,
    loadConfig: async () => ({
      config: { ...DEFAULT_CONFIG, enabled: options.enabled ?? true },
      sources: { global: 'absent', project: 'absent' },
      warnings: [],
    }),
    ...(options.replayFailure
      ? {
          replay: () => {
            throw new Error('private replay failure');
          },
        }
      : {}),
    now: () => new Date('2026-08-12T10:00:00.000Z'),
    writePrint: () => undefined,
    hooks: options.refreshUi
      ? {
          refreshLocked(runtime) {
            runtime.context.ui.setWidget('pi-signal-board', ['updated']);
          },
        }
      : {},
  })(harness.api);
  const tool = (harness.registrations.tools as RegisteredQuestionTool[]).find(
    (value) => value.name === QUESTION_TOOL_NAME,
  );
  if (!tool || !lifecycle) throw new Error('Missing question tool registration or lifecycle.');
  return { harness, tool, lifecycle };
}

async function failureDetails(
  test: ReturnType<typeof setup>,
  id: string,
  input: QuestionToolInput,
): Promise<{ details: QuestionToolDetails; text: string }> {
  await expect(test.tool.execute(id, input)).rejects.toThrow(/^Signals tool failed \(SB_/u);
  const [patch] = await test.harness.dispatch('tool_result', {
    type: 'tool_result',
    toolCallId: id,
    toolName: QUESTION_TOOL_NAME,
    input: input as Record<string, unknown>,
    content: [{ type: 'text', text: 'host leaked private failure stack' }],
    details: { raw: 'host leaked private failure stack' },
    isError: true,
  });
  const result = patch as { details: QuestionToolDetails; content: Array<{ text: string }> };
  return { details: result.details, text: result.content[0]?.text ?? '' };
}

async function create(test: ReturnType<typeof setup>, id = 'create') {
  await test.harness.dispatch('session_start');
  return test.tool.execute(id, CREATE);
}

describe('signal_board_question schema and prompt metadata', () => {
  it.each(RESPONSE_CASES)('accepts authoritative create response kind $kind', (response) => {
    expect(
      Value.Check(QUESTION_TOOL_PARAMETERS, {
        operation: 'create',
        question: 'Which shape should be used?',
        reason: 'A local choice is needed.',
        class: 'preference',
        response,
      }),
    ).toBe(true);
  });

  it('accepts representative create, full revise, cancel, and attachment fields', () => {
    const createWithAllAttachments = {
      ...CREATE,
      attachments: [
        { kind: 'file', label: 'File', path: 'src/a.ts', external: false },
        { kind: 'line_range', label: 'Range', path: 'src/a.ts', startLine: 1, endLine: 2 },
        { kind: 'test_run', label: 'Tests', reference: 'run-1' },
        { kind: 'command', label: 'Command', reference: 'npm test' },
        { kind: 'url', label: 'Reference', url: 'https://example.test/docs' },
        { kind: 'note', label: 'Note', text: 'Local note' },
      ],
      expiresAt: '2026-08-13T10:00:00.000Z',
    };
    expect(Value.Check(QUESTION_TOOL_PARAMETERS, createWithAllAttachments)).toBe(true);
    expect(Value.Check(QUESTION_TOOL_PARAMETERS, REVISE)).toBe(true);
    expect(Value.Check(QUESTION_TOOL_PARAMETERS, CANCEL)).toBe(true);
  });

  it('requires every authoritative full-revise field', () => {
    for (const field of [
      'operation',
      'id',
      'expectedRevision',
      'revisionSummary',
      'question',
      'reason',
      'class',
      'response',
      'recommendedOptionIds',
      'priority',
      'blockingPolicy',
      'deliveryMode',
      'affectedWork',
      'continuingWork',
      'attachments',
    ] as const) {
      const input: Record<string, unknown> = { ...REVISE };
      delete input[field];
      expect(Value.Check(QUESTION_TOOL_PARAMETERS, input), field).toBe(false);
    }
  });

  it.each([
    { operation: 'create', question: 'Missing fields' },
    { ...CREATE, operation: 'delete' },
    { ...CREATE, unknown: true },
    { ...CREATE, response: { kind: 'text', options: OPTIONS } },
    { ...CREATE, response: { kind: 'single', options: [OPTIONS[0]] } },
    { ...CREATE, recommendedOptionIds: ['Flat'] },
    { ...CREATE, affectedWork: new Array(21).fill('work') },
    { ...CREATE, attachments: new Array(11).fill({ kind: 'note', label: 'x', text: 'x' }) },
    { operation: 'cancel', id: 'bad', expectedRevision: 1, reason: 'x' },
    { operation: 'cancel', id: 'Q-1', expectedRevision: 0, reason: 'x' },
  ])('rejects authoritative invalid structure %#', (input) => {
    expect(Value.Check(QUESTION_TOOL_PARAMETERS, input)).toBe(false);
  });

  it('keeps semantic invalid corpus structurally representable for stable runtime errors', () => {
    const unsafeAuthorization = {
      operation: 'create',
      question: 'May I deploy this to production?',
      reason: 'The code is ready.',
      class: 'authorization',
      response: {
        kind: 'single',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
    };
    const missingRecommendation = { ...CREATE, recommendedOptionIds: ['missing'] };
    const invalidTemporaryDefault = { ...CREATE, class: 'preference' };
    expect(Value.Check(QUESTION_TOOL_PARAMETERS, unsafeAuthorization)).toBe(true);
    expect(Value.Check(QUESTION_TOOL_PARAMETERS, missingRecommendation)).toBe(true);
    expect(Value.Check(QUESTION_TOOL_PARAMETERS, invalidTemporaryDefault)).toBe(true);
  });

  it('publishes bounded exact metadata with the tool name in every guideline', () => {
    const { tool } = setup();
    expect(tool.description).toBe(QUESTION_TOOL_DESCRIPTION);
    expect(tool.promptSnippet).toBe(QUESTION_TOOL_PROMPT_SNIPPET);
    expect(tool.promptGuidelines).toEqual(QUESTION_TOOL_PROMPT_GUIDELINES);
    expect(tool.promptGuidelines?.every((line) => line.includes(QUESTION_TOOL_NAME))).toBe(true);
    expect(
      JSON.stringify([tool.description, tool.promptSnippet, tool.promptGuidelines]).length,
    ).toBeLessThan(1400);
  });

  it('registers exactly once at extension load and not again across runtime reloads', async () => {
    const test = setup();
    expect(
      test.harness.registrations.tools.map((value) => (value as { name: string }).name),
    ).toEqual(['signal_board_update', 'signal_board_question', 'signal_board_ack']);
    await test.harness.dispatch('session_start');
    await test.harness.dispatch('session_shutdown', { type: 'session_shutdown', reason: 'reload' });
    await test.harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    expect(test.harness.registrationCount('tools')).toBe(3);
  });
});

describe('signal_board_question execution', () => {
  it('dispatches create, full revise, and cancel and returns exact required guidance', async () => {
    const test = setup();
    const created = await create(test);
    expect(created.content[0]?.text).toBe(
      "Queued Q-1 revision 1. Continue only work that does not depend on this answer; do not assume the recommendation or temporary default is the user's choice.",
    );
    expect(created.details).toMatchObject({
      ok: true,
      operation: 'create',
      value: { item: { displayId: 'Q-1', revision: 1, status: 'pending' } },
      event: { eventType: 'question.created' },
      noOp: false,
    });
    if (!created.details.ok) throw new Error('Expected create success.');
    expect(created.details.event).toEqual(test.harness.appendCalls[0]?.data);

    const revised = await test.tool.execute('revise', REVISE);
    expect(revised.content[0]?.text).toBe(
      "Queued Q-1 revision 2. Continue only work that does not depend on this answer; do not assume the recommendation or temporary default is the user's choice.",
    );
    expect(revised.details).toMatchObject({
      ok: true,
      operation: 'revise',
      value: { item: { displayId: 'Q-1', revision: 2, status: 'pending' } },
      event: { eventType: 'question.revised' },
      noOp: false,
    });

    const cancelled = await test.tool.execute('cancel', CANCEL);
    expect(cancelled.content[0]?.text).toBe('Cancelled Q-1 revision 3. No answer was sent.');
    expect(cancelled.details).toMatchObject({
      ok: true,
      operation: 'cancel',
      value: { item: { displayId: 'Q-1', revision: 3, status: 'cancelled' } },
      event: { eventType: 'question.cancelled' },
      noOp: false,
    });
    expect(test.harness.appendCalls).toHaveLength(3);
    expect(test.harness.sendCalls).toEqual([]);
  });

  it('dispatches every response kind without answer or delivery calls', async () => {
    for (const [index, response] of RESPONSE_CASES.entries()) {
      const test = setup();
      await test.harness.dispatch('session_start');
      const result = await test.tool.execute(`response-${index}`, {
        operation: 'create',
        question: `Which response shape ${index} should be used?`,
        reason: 'Useful independent work can continue.',
        class: 'preference',
        response,
      });
      expect(result.details).toMatchObject({ ok: true, event: { eventType: 'question.created' } });
      expect(test.harness.sendCalls).toEqual([]);
    }
  });

  it('returns deeply immutable success details and uses the current runtime after replacement', async () => {
    const test = setup();
    const first = await create(test);
    if (!first.details.ok) throw new Error('Expected create success.');
    expect(Object.isFrozen(first.details)).toBe(true);
    expect(Object.isFrozen(first.details.value)).toBe(true);
    expect(Object.isFrozen(first.details.value.item)).toBe(true);
    const immutableItem = first.details.value.item;
    expect(() => {
      (immutableItem as { status: string }).status = 'changed';
    }).toThrow();

    await test.harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    const second = await test.tool.execute('current-runtime', {
      ...CREATE,
      question: 'Which replacement-runtime shape should be used?',
    });
    expect(second.details).toMatchObject({
      ok: true,
      value: { item: { displayId: 'Q-2', revision: 1 } },
    });
  });

  it('preserves an exact provider-qualified tool call ID through event, codec, replay, and retry', async () => {
    const test = setup();
    const first = await create(test, PROVIDER_QUALIFIED_TOOL_CALL_ID);
    if (!first.details.ok) throw new Error('Expected create success.');
    expect(first.details.event.commandId).toBe(PROVIDER_QUALIFIED_COMMAND_ID);
    expect(decodeBoardEvent(test.harness.appendCalls[0]?.data)).toMatchObject({
      ok: true,
      event: { commandId: PROVIDER_QUALIFIED_COMMAND_ID },
    });

    const retry = await test.tool.execute(PROVIDER_QUALIFIED_TOOL_CALL_ID, CREATE);
    expect(retry.details).toMatchObject({ ok: true, noOp: true });
    if (!retry.details.ok) throw new Error('Expected retry success.');
    expect(retry.details.event).toEqual(first.details.event);
    expect(test.harness.appendCalls).toHaveLength(1);

    await test.harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    const replayed = await test.tool.execute(PROVIDER_QUALIFIED_TOOL_CALL_ID, CREATE);
    expect(replayed.details).toMatchObject({ ok: true, noOp: true });
    if (!replayed.details.ok) throw new Error('Expected replayed retry success.');
    expect(replayed.details.event).toEqual(first.details.event);
    expect(test.harness.appendCalls).toHaveLength(1);
  });

  it('returns stable semantic, unsafe, revision, persistence, and refresh failures with redaction', async () => {
    const semantic = setup();
    await semantic.harness.dispatch('session_start');
    const semanticFailure = await failureDetails(semantic, 'semantic', {
      ...CREATE,
      recommendedOptionIds: ['missing'],
    });
    expect(semanticFailure.details).toMatchObject({
      ok: false,
      error: { code: 'SB_INVALID_ARGUMENT' },
    });

    const secret = 'PRIVATE-QUESTION-REASON-7f2e';
    const unsafe = setup();
    await unsafe.harness.dispatch('session_start');
    const { temporaryDefault: _unsafeDefault, ...withoutTemporaryDefault } = CREATE;
    const unsafeFailure = await failureDetails(unsafe, 'unsafe', {
      ...withoutTemporaryDefault,
      question: 'May I publish the secret token?',
      reason: secret,
      class: 'authorization',
    });
    expect(unsafeFailure.details).toMatchObject({
      ok: false,
      error: { code: 'SB_UNSAFE_QUESTION' },
    });
    expect(JSON.stringify(unsafeFailure)).not.toContain(secret);
    expect(JSON.stringify(unsafeFailure)).not.toContain('stack');

    const stale = setup();
    await create(stale);
    const staleFailure = await failureDetails(stale, 'stale', { ...REVISE, expectedRevision: 2 });
    expect(staleFailure.details).toMatchObject({
      ok: false,
      error: { code: 'SB_REVISION_MISMATCH' },
    });

    const persistence = setup();
    await persistence.harness.dispatch('session_start');
    persistence.harness.failNextAppend(new Error(`${secret} stack`));
    const persistenceFailure = await failureDetails(persistence, 'persistence', CREATE);
    expect(persistenceFailure.details).toMatchObject({
      ok: false,
      error: { code: 'SB_PERSISTENCE_FAILED' },
    });
    expect(JSON.stringify(persistenceFailure)).not.toContain(secret);

    const ui = setup({ refreshUi: true });
    await ui.harness.dispatch('session_start');
    ui.harness.failNextUi('setWidget', new Error(`${secret} stack`));
    const uiFailure = await failureDetails(ui, 'ui', CREATE);
    expect(uiFailure.details).toMatchObject({ ok: false, error: { code: 'SB_UI_UNAVAILABLE' } });
    expect(ui.harness.appendCalls).toHaveLength(1);
    expect(JSON.stringify(uiFailure)).not.toContain(secret);
  });

  it('requires a healthy current runtime in uninitialized, disabled, unsupported, and degraded states', async () => {
    const cases = [
      { test: setup(), code: 'SB_NOT_INITIALIZED', start: false },
      { test: setup({ enabled: false }), code: 'SB_CONFIG_DISABLED', start: true },
      {
        test: setup({
          compatibility: evaluateHostCompatibility({ nodeVersion: '21.0.0', piVersion: '0.84.1' }),
        }),
        code: 'SB_UNSUPPORTED_HOST',
        start: true,
      },
      { test: setup({ replayFailure: true }), code: 'SB_INTERNAL', start: true },
    ];
    for (const { test, code, start } of cases) {
      if (start) await test.harness.dispatch('session_start');
      const failure = await failureDetails(test, `runtime-${code}`, CREATE);
      expect(failure.details).toMatchObject({ ok: false, error: { code } });
      expect(test.harness.appendCalls).toEqual([]);
    }
  });

  it('contains a missing service and an unexpected thrown service failure', async () => {
    const missing = setup();
    await missing.harness.dispatch('session_start');
    const missingRuntime = missing.lifecycle.slot.current();
    if (!missingRuntime) throw new Error('Expected runtime.');
    delete missingRuntime.questionService;
    const missingFailure = await failureDetails(missing, 'missing-service', CREATE);
    expect(missingFailure.details).toMatchObject({
      ok: false,
      error: { code: 'SB_NOT_INITIALIZED' },
    });

    const unexpected = setup();
    await unexpected.harness.dispatch('session_start');
    const service = unexpected.lifecycle.slot.current()?.questionService;
    if (!service) throw new Error('Expected question service.');
    service.createQuestion = (() => {
      throw new Error('PRIVATE unexpected stack and question content');
    }) as typeof service.createQuestion;
    const unexpectedFailure = await failureDetails(unexpected, 'unexpected', CREATE);
    expect(unexpectedFailure.details).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });
    expect(JSON.stringify(unexpectedFailure)).not.toContain('PRIVATE');
    expect(JSON.stringify(unexpectedFailure)).not.toContain('stack');
  });

  it.each(['json', 'print'] as const)(
    'persists in %s mode without dialogs, answers, or delivery',
    async (mode) => {
      const test = setup({ mode });
      const result = await create(test);
      expect(result.details).toMatchObject({ ok: true });
      expect(test.harness.sendCalls).toEqual([]);
      expect(test.harness.uiCalls).toEqual([]);
    },
  );

  it('does not stream onUpdate and resets the question rate on turn_start', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    const onUpdate = vi.fn();
    const {
      recommendation: _recommendation,
      temporaryDefault: _temporaryDefault,
      ...createWithoutRecommendation
    } = CREATE;
    for (let index = 0; index < 5; index += 1) {
      await test.tool.execute(
        `rate-${index}`,
        {
          ...createWithoutRecommendation,
          question: `Which local shape ${index} should be used?`,
          recommendedOptionIds: [],
        },
        undefined,
        onUpdate,
      );
    }
    expect(onUpdate).not.toHaveBeenCalled();
    const overLimit = await failureDetails(test, 'over-limit', {
      ...CREATE,
      question: 'Which sixth local shape should be used?',
    });
    expect(overLimit.details).toMatchObject({ ok: false, error: { code: 'SB_LIMIT_EXCEEDED' } });
    await test.harness.dispatch('turn_start');
    await expect(
      test.tool.execute('after-reset', {
        ...CREATE,
        question: 'Which post-reset local shape should be used?',
      }),
    ).resolves.toMatchObject({ details: { ok: true } });
    expect(test.harness.sendCalls).toEqual([]);
  });
});

describe('signal_board_question renderers', () => {
  it('renders width-safe color-neutral calls and collapsed results at 50, 80, and 120 columns', async () => {
    const test = setup();
    const success = await create(test);
    const calls = [CREATE, REVISE, CANCEL].map((input) => test.tool.renderCall(input, theme, {}));
    const collapsed = test.tool.renderResult(
      success,
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const expanded = test.tool.renderResult(
      success,
      { expanded: true, isPartial: false },
      theme,
      {},
    );

    for (const width of [50, 80, 120]) {
      for (const component of [...calls, collapsed, expanded]) {
        const lines = component.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      expect(collapsed.render(width).length).toBeLessThanOrEqual(6);
    }
    expect(
      Object.fromEntries(
        [50, 80, 120].map((width) => [
          width,
          {
            calls: calls.map((call) => call.render(width).map((line) => line.trimEnd())),
            result: collapsed.render(width).map((line) => line.trimEnd()),
          },
        ]),
      ),
    ).toMatchInlineSnapshot(`
      {
        "120": {
          "calls": [
            [
              "signal_board_question create Which local API shape shoul…",
            ],
            [
              "signal_board_question revise Q-1",
            ],
            [
              "signal_board_question cancel Q-1",
            ],
          ],
          "result": [
            "OK create Q-1 rev 1 status pending",
            "Continue only independent work; do not assume an answer.",
          ],
        },
        "50": {
          "calls": [
            [
              "signal_board_question create Which local API shape",
              "shoul…",
            ],
            [
              "signal_board_question revise Q-1",
            ],
            [
              "signal_board_question cancel Q-1",
            ],
          ],
          "result": [
            "OK create Q-1 rev 1 status pending",
            "Continue only independent work; do not assume an",
            "answer.",
          ],
        },
        "80": {
          "calls": [
            [
              "signal_board_question create Which local API shape shoul…",
            ],
            [
              "signal_board_question revise Q-1",
            ],
            [
              "signal_board_question cancel Q-1",
            ],
          ],
          "result": [
            "OK create Q-1 rev 1 status pending",
            "Continue only independent work; do not assume an answer.",
          ],
        },
      }
    `);
    expect(
      calls.map((call) =>
        call
          .render(80)
          .map((line) => line.trimEnd())
          .join('\n'),
      ),
    ).toEqual([
      'signal_board_question create Which local API shape shoul…',
      'signal_board_question revise Q-1',
      'signal_board_question cancel Q-1',
    ]);
    expect(collapsed.render(80).map((line) => line.trimEnd())).toEqual([
      'OK create Q-1 rev 1 status pending',
      'Continue only independent work; do not assume an answer.',
    ]);
    expect(expanded.render(80).map((line) => line.trimEnd())).toEqual([
      'OK create Q-1 rev 1 status pending',
      'Continue only independent work; do not assume an answer.',
      expect.stringMatching(/^id qst_/u),
      'event question.created',
    ]);
  });

  it('renders cancel guidance and malformed, partial, and unknown details without throwing or leaking raw content', () => {
    const test = setup();
    const cancel = test.tool.renderResult(
      {
        content: [{ type: 'text', text: 'PRIVATE RAW RESULT stack' }],
        details: {
          ok: true,
          operation: 'cancel',
          value: { item: { id: 'qst_bad', displayId: 'Q-9', revision: 2, status: 'cancelled' } },
          event: { eventType: 'question.cancelled' },
          noOp: false,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    expect(cancel.render(50).join('\n')).toContain('No answer was sent.');

    for (const details of [
      undefined,
      null,
      {},
      { ok: true },
      { ok: false },
      { ok: false, error: { code: 'PRIVATE', message: 'PRIVATE RAW RESULT stack' } },
      { ok: true, operation: 'unknown', value: { item: {} } },
    ]) {
      expect(() =>
        test.tool
          .renderResult(
            { content: [{ type: 'text', text: 'PRIVATE RAW RESULT stack' }], details },
            { expanded: true, isPartial: true },
            theme,
            {},
          )
          .render(50),
      ).not.toThrow();
      const text = test.tool
        .renderResult(
          { content: [{ type: 'text', text: 'PRIVATE RAW RESULT stack' }], details },
          { expanded: true, isPartial: true },
          theme,
          {},
        )
        .render(50)
        .join('\n');
      expect(text).not.toContain('PRIVATE RAW RESULT');
      expect(text).not.toContain('stack');
      expect(text.split('\n').length).toBeLessThanOrEqual(6);
    }
  });
});
