import { visibleWidth } from '@earendil-works/pi-tui';
import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { UPDATE_TOOL_NAME } from '../../src/constants.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import { decodeBoardEvent } from '../../src/persistence/event-codec.js';
import {
  PendingToolFailures,
  patchPendingToolFailure,
  UPDATE_TOOL_DESCRIPTION,
  UPDATE_TOOL_PARAMETERS,
  UPDATE_TOOL_PROMPT_GUIDELINES,
  UPDATE_TOOL_PROMPT_SNIPPET,
  type UpdateToolDetails,
  type UpdateToolInput,
} from '../../src/tools/update-tool.js';
import { FakePiHarness } from '../helpers/fake-pi.js';

const SUPPORTED = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' });
const PROVIDER_QUALIFIED_TOOL_CALL_ID =
  'call_Z6LPv0kJq22rXsNP67ojPhlg|fc_068d35c2414bddfc016a7c4fb7e8f4819881a1ba59d0364046';
const PROVIDER_QUALIFIED_COMMAND_ID = `tool:${PROVIDER_QUALIFIED_TOOL_CALL_ID}`;
const VALID = [
  { operation: 'upsert' },
  {
    operation: 'upsert',
    key: 'auth-refactor',
    kind: 'working',
    title: 'Refactoring authentication middleware',
    detail: 'Token parsing is complete; compatibility tests remain.',
    stage: 'testing',
    progress: { current: 8, total: 12, unit: 'tests' },
    attachments: [{ kind: 'file', label: 'Middleware', path: 'src/auth/middleware.ts' }],
  },
  { operation: 'archive', id: 'U-1' },
  { operation: 'archive', key: 'auth', expectedRevision: 1 },
  // Supplied INV-001 and INV-002 are structurally valid and fail only after state resolution.
  { operation: 'upsert', key: 'new-work', kind: 'working' },
  {
    operation: 'upsert',
    key: 'tests',
    kind: 'working',
    title: 'Run tests',
    progress: { current: 11, total: 10, unit: 'tests' },
  },
] as const;
const INVALID = [
  { operation: 'archive' },
  { operation: 'delete', id: 'U-1' },
  { operation: 'archive', id: 'bad' },
  { operation: 'upsert', unknown: true },
  { operation: 'upsert', attachments: new Array(11).fill({ kind: 'note', label: 'x', text: 'x' }) },
  { operation: 'upsert', progress: { current: -1, total: 1 } },
] as const;

interface RegisteredUpdateTool {
  readonly name: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: string[];
  readonly parameters: typeof UPDATE_TOOL_PARAMETERS;
  execute(
    id: string,
    input: UpdateToolInput,
  ): Promise<{ content: unknown[]; details: UpdateToolDetails }>;
  renderCall(input: UpdateToolInput, theme: TestTheme, context: RenderContext): Rendered;
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
  mode: 'tui' | 'json' | 'print' = 'tui',
  options: { enabled?: boolean; refreshUi?: boolean } = {},
) {
  const harness = new FakePiHarness({ mode });
  createSignalBoardExtension({
    evaluateCompatibility: () => SUPPORTED,
    loadConfig: async () => ({
      config: { ...DEFAULT_CONFIG, enabled: options.enabled ?? true },
      sources: { global: 'absent', project: 'absent' },
      warnings: [],
    }),
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
  const tool = (harness.registrations.tools as RegisteredUpdateTool[]).find(
    (value) => value.name === UPDATE_TOOL_NAME,
  );
  if (!tool) throw new Error('Missing update tool registration.');
  return { harness, tool };
}

async function startAndCreate(test: ReturnType<typeof setup>, id = 'create') {
  await test.harness.dispatch('session_start');
  return test.tool.execute(id, {
    operation: 'upsert',
    key: 'work',
    kind: 'working',
    title: 'Work item',
  });
}

async function failureDetails(
  test: ReturnType<typeof setup>,
  id: string,
  input: UpdateToolInput,
): Promise<UpdateToolDetails> {
  await expect(test.tool.execute(id, input)).rejects.toThrow(/^Agent Board tool failed \(SB_/u);
  const [patch] = await test.harness.dispatch('tool_result', {
    type: 'tool_result',
    toolCallId: id,
    toolName: UPDATE_TOOL_NAME,
    input: input as Record<string, unknown>,
    content: [{ type: 'text', text: 'host error' }],
    details: undefined,
    isError: true,
  });
  return (patch as { details: UpdateToolDetails }).details;
}

describe('signal_board_update schema and metadata', () => {
  it.each(VALID)('accepts valid structural fixture %#', (input) => {
    expect(Value.Check(UPDATE_TOOL_PARAMETERS, input)).toBe(true);
  });
  it.each(INVALID)('rejects invalid structural fixture %#', (input) => {
    expect(Value.Check(UPDATE_TOOL_PARAMETERS, input)).toBe(false);
  });
  it('preserves top-level oneOf, branch closure, enum schemas, and archive anyOf', () => {
    const schema = UPDATE_TOOL_PARAMETERS as unknown as { oneOf: Array<Record<string, unknown>> };
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.oneOf.every((branch) => branch.additionalProperties === false)).toBe(true);
    expect(schema.oneOf[1]?.anyOf).toEqual([{ required: ['id'] }, { required: ['key'] }]);
    expect(JSON.stringify(schema)).not.toContain('"const"');
  });
  it('registers exactly three static tools and does not duplicate them on session reload', async () => {
    const test = setup();
    expect(
      test.harness.registrations.tools.map((value) => (value as { name: string }).name),
    ).toEqual(['signal_board_update', 'signal_board_question', 'signal_board_ack']);
    await test.harness.dispatch('session_start');
    await test.harness.dispatch('session_shutdown', { type: 'session_shutdown', reason: 'reload' });
    await test.harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    expect(test.harness.registrationCount('tools')).toBe(3);
  });
  it('publishes the exact description, snippet, and named guidance', () => {
    const { tool } = setup();
    expect(tool.description).toBe(UPDATE_TOOL_DESCRIPTION);
    expect(tool.promptSnippet).toBe(UPDATE_TOOL_PROMPT_SNIPPET);
    expect(tool.promptGuidelines).toEqual(UPDATE_TOOL_PROMPT_GUIDELINES);
    expect(tool.promptGuidelines?.every((line) => line.includes(UPDATE_TOOL_NAME))).toBe(true);
  });
});

describe('signal_board_update execution', () => {
  it('creates, revises, archives, and returns exact accepted events and no-ops', async () => {
    const test = setup();
    const created = await startAndCreate(test);
    expect(created.details).toMatchObject({
      ok: true,
      operation: 'upsert',
      value: { item: { displayId: 'U-1', revision: 1 } },
      noOp: false,
    });
    if (!created.details.ok) throw new Error('Expected create success.');
    expect(created.details.event).toEqual(test.harness.appendCalls[0]?.data);

    const revised = await test.tool.execute('revise', {
      operation: 'upsert',
      key: 'work',
      kind: 'finding',
      title: 'Finding',
    });
    expect(revised.details).toMatchObject({
      ok: true,
      value: { item: { revision: 2, kind: 'finding' } },
    });
    const noOp = await test.tool.execute('noop', {
      operation: 'upsert',
      key: 'work',
      kind: 'finding',
      title: 'Finding',
    });
    expect(noOp.details).toMatchObject({ ok: true, noOp: true });
    expect(test.harness.appendCalls).toHaveLength(2);
    const archived = await test.tool.execute('archive', { operation: 'archive', key: 'work' });
    expect(archived.details).toMatchObject({
      ok: true,
      operation: 'archive',
      value: { item: { revision: 3 } },
    });
    expect(test.harness.appendCalls).toHaveLength(3);
  });

  it('returns the original event for an exact command retry', async () => {
    const test = setup();
    const first = await startAndCreate(test, 'same');
    const retry = await test.tool.execute('same', {
      operation: 'upsert',
      key: 'work',
      kind: 'working',
      title: 'Work item',
    });
    expect(retry.details).toMatchObject({ ok: true, noOp: true });
    if (!first.details.ok || !retry.details.ok) throw new Error('Expected retry success.');
    expect(retry.details.event).toEqual(first.details.event);
    expect(test.harness.appendCalls).toHaveLength(1);
  });

  it('preserves a Pi provider-qualified call ID through append, codec, replay, and idempotency', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    const input = {
      operation: 'upsert',
      key: 'provider-call',
      kind: 'working',
      title: 'Provider-qualified call',
    } as const;

    const first = await test.tool.execute(PROVIDER_QUALIFIED_TOOL_CALL_ID, input);
    expect(first.details).toMatchObject({ ok: true, noOp: false });
    if (!first.details.ok) throw new Error('Expected provider-qualified call success.');
    expect(first.details.event?.commandId).toBe(PROVIDER_QUALIFIED_COMMAND_ID);
    expect(test.harness.appendCalls[0]?.data).toMatchObject({
      commandId: PROVIDER_QUALIFIED_COMMAND_ID,
    });
    expect(decodeBoardEvent(test.harness.appendCalls[0]?.data)).toMatchObject({
      ok: true,
      event: { commandId: PROVIDER_QUALIFIED_COMMAND_ID },
    });

    const retry = await test.tool.execute(PROVIDER_QUALIFIED_TOOL_CALL_ID, input);
    expect(retry.details).toMatchObject({ ok: true, noOp: true });
    if (!retry.details.ok) throw new Error('Expected same-call retry success.');
    expect(retry.details.event).toEqual(first.details.event);
    expect(test.harness.appendCalls).toHaveLength(1);

    expect(
      await failureDetails(test, PROVIDER_QUALIFIED_TOOL_CALL_ID, {
        ...input,
        title: 'Conflicting provider-qualified call',
      }),
    ).toMatchObject({ ok: false, error: { code: 'SB_STATE_CONFLICT' } });
    expect(test.harness.appendCalls).toHaveLength(1);

    await test.harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    const replayedRetry = await test.tool.execute(PROVIDER_QUALIFIED_TOOL_CALL_ID, input);
    expect(replayedRetry.details).toMatchObject({ ok: true, noOp: true });
    if (!replayedRetry.details.ok) throw new Error('Expected replayed same-call retry success.');
    expect(replayedRetry.details.event).toEqual(first.details.event);
    expect(test.harness.appendCalls).toHaveLength(1);
  });

  it('serializes parallel same-key calls and resets its runtime counter on turn_start', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    const calls = Array.from({ length: 12 }, (_, index) =>
      test.tool.execute(`rate-${index}`, {
        operation: 'upsert',
        key: 'work',
        kind: 'working',
        title: `Work ${index}`,
      }),
    );
    const results = await Promise.all(calls);
    expect(
      results.map((result) => result.details.ok && result.details.value.item.revision),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    await expect(
      test.tool.execute('rate-fail', { operation: 'upsert', key: 'work', title: 'Over limit' }),
    ).rejects.toThrow('SB_LIMIT_EXCEEDED');
    await test.harness.dispatch('turn_start');
    await expect(
      test.tool.execute('rate-reset', { operation: 'upsert', key: 'work', title: 'After reset' }),
    ).resolves.toMatchObject({ details: { ok: true } });
  });

  it('returns stable runtime, config, semantic, persistence, and UI failures', async () => {
    const uninitialized = setup();
    expect(
      await failureDetails(uninitialized, 'uninitialized', {
        operation: 'upsert',
        key: 'work',
        kind: 'working',
        title: 'Work',
      }),
    ).toMatchObject({ ok: false, error: { code: 'SB_NOT_INITIALIZED' } });

    const disabled = setup('tui', { enabled: false });
    await disabled.harness.dispatch('session_start');
    expect(
      await failureDetails(disabled, 'disabled', {
        operation: 'upsert',
        key: 'work',
        kind: 'working',
        title: 'Work',
      }),
    ).toMatchObject({ ok: false, error: { code: 'SB_CONFIG_DISABLED' } });

    const semantic = setup();
    await semantic.harness.dispatch('session_start');
    expect(
      await failureDetails(semantic, 'semantic', {
        operation: 'upsert',
        key: 'work',
        kind: 'working',
        title: 'Work',
        progress: { current: 2, total: 1 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'SB_INVALID_ARGUMENT' } });

    const persistence = setup();
    await persistence.harness.dispatch('session_start');
    persistence.harness.failNextAppend();
    expect(
      await failureDetails(persistence, 'persistence', {
        operation: 'upsert',
        key: 'work',
        kind: 'working',
        title: 'Work',
      }),
    ).toMatchObject({ ok: false, error: { code: 'SB_PERSISTENCE_FAILED' } });
    expect(persistence.harness.appendCalls).toHaveLength(0);

    const ui = setup('tui', { refreshUi: true });
    await ui.harness.dispatch('session_start');
    ui.harness.failNextUi('setWidget');
    expect(
      await failureDetails(ui, 'ui', {
        operation: 'upsert',
        key: 'work',
        kind: 'working',
        title: 'Persisted',
      }),
    ).toMatchObject({ ok: false, error: { code: 'SB_UI_UNAVAILABLE' } });
    expect(ui.harness.appendCalls).toHaveLength(1);
    await expect(
      ui.tool.execute('after-ui', { operation: 'upsert', key: 'work', title: 'Still durable' }),
    ).resolves.toMatchObject({ details: { ok: true, value: { item: { revision: 2 } } } });
  });

  it.each(['json', 'print'] as const)('works in %s mode without a UI call', async (mode) => {
    const test = setup(mode);
    const result = await startAndCreate(test);
    expect(result.details).toMatchObject({ ok: true });
    expect(test.harness.uiCalls).toEqual([]);
  });

  it('rejects stale runtime service use after replacement', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    const first = await test.tool.execute('first', {
      operation: 'upsert',
      key: 'old',
      kind: 'working',
      title: 'Old',
    });
    expect(first.details).toMatchObject({ ok: true });
    await test.harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    const next = await test.tool.execute('next', {
      operation: 'upsert',
      key: 'new',
      kind: 'working',
      title: 'New',
    });
    expect(next.details).toMatchObject({
      ok: true,
      value: { item: { displayId: 'U-2', revision: 1 } },
    });
  });
});

describe('failure adapter and renderers', () => {
  it('clears pending failures on runtime replacement and shutdown', async () => {
    const replacement = setup();
    await expect(
      replacement.tool.execute('pending-replace', {
        operation: 'upsert',
        key: 'work',
        kind: 'working',
        title: 'Work',
      }),
    ).rejects.toThrow('SB_NOT_INITIALIZED');
    await replacement.harness.dispatch('session_start');
    const replacedPatch = await replacement.harness.dispatch('tool_result', {
      type: 'tool_result',
      toolCallId: 'pending-replace',
      toolName: UPDATE_TOOL_NAME,
      input: {},
      content: [{ type: 'text', text: 'host' }],
      details: undefined,
      isError: true,
    });
    expect(replacedPatch).toEqual([undefined]);

    await expect(
      replacement.tool.execute('pending-shutdown', {
        operation: 'upsert',
        progress: { current: 2, total: 1 },
      }),
    ).rejects.toThrow('SB_INVALID_ARGUMENT');
    await replacement.harness.dispatch('session_shutdown');
    const shutdownPatch = await replacement.harness.dispatch('tool_result', {
      type: 'tool_result',
      toolCallId: 'pending-shutdown',
      toolName: UPDATE_TOOL_NAME,
      input: {},
      content: [{ type: 'text', text: 'host' }],
      details: undefined,
      isError: true,
    });
    expect(shutdownPatch).toEqual([undefined]);
  });

  it('patches parallel failures by toolCallId, deletes each, and leaves unmapped failures unchanged', () => {
    const pending = new PendingToolFailures();
    const failure = (code: 'SB_NOT_INITIALIZED' | 'SB_INTERNAL') => ({
      ok: false as const,
      error: { code, message: code, retryable: true },
    });
    pending.set('a', failure('SB_NOT_INITIALIZED'));
    pending.set('b', failure('SB_INTERNAL'));
    const event = (id: string): Parameters<typeof patchPendingToolFailure>[0] => ({
      type: 'tool_result',
      toolCallId: id,
      toolName: UPDATE_TOOL_NAME,
      input: {},
      content: [{ type: 'text', text: 'host' }],
      details: undefined,
      isError: true,
    });
    expect(patchPendingToolFailure(event('b'), pending)?.details).toEqual(failure('SB_INTERNAL'));
    expect(patchPendingToolFailure(event('a'), pending)?.details).toEqual(
      failure('SB_NOT_INITIALIZED'),
    );
    expect(pending.size).toBe(0);
    expect(patchPendingToolFailure(event('unmapped'), pending)).toBeUndefined();
    expect(
      patchPendingToolFailure({ ...event('other'), toolName: 'bash' }, pending),
    ).toBeUndefined();
  });

  it('renders bounded explicit collapsed and expanded output at supported widths with safe fallback', async () => {
    const test = setup();
    const success = await startAndCreate(test);
    const contexts: RenderContext[] = [{}, {}];
    const call = test.tool.renderCall(
      { operation: 'upsert', key: 'work', title: 'Title' },
      theme,
      contexts[0] ?? {},
    );
    const collapsed = test.tool.renderResult(
      success,
      { expanded: false, isPartial: false },
      theme,
      contexts[1] ?? {},
    );
    const expanded = test.tool.renderResult(
      success,
      { expanded: true, isPartial: false },
      theme,
      {},
    );
    const fallback = test.tool.renderResult(
      { content: [], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    for (const width of [50, 80, 120, 240]) {
      for (const component of [call, collapsed, expanded, fallback]) {
        const lines = component.render(width);
        expect(lines.length).toBeLessThanOrEqual(6);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      expect(call.render(width)).toHaveLength(1);
      expect(collapsed.render(width).length).toBeLessThanOrEqual(2);
      expect(fallback.render(width).length).toBeLessThanOrEqual(2);
    }
    expect(collapsed.render(80).join('\n')).toContain('OK upsert');
    expect(fallback.render(80).join('\n')).toContain('ERROR SB_INTERNAL');
  });
});
