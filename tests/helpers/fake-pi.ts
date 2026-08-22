import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolResultEvent,
  TurnStartEvent,
} from '@earendil-works/pi-coding-agent';

import { createDeferred, type Deferred } from './deferred.js';
import { DeterministicIds, FakeClock, FakeTimers } from './deterministic.js';
import { FakeConfigReader } from './fake-config.js';

export const SYNTHETIC_CWD = '/workspace/signal-fixture';
export const SYNTHETIC_SESSION_FILE = '/sessions/signal-fixture/session.jsonl';

export type FakeExtensionMode = 'tui' | 'rpc' | 'json' | 'print';

export type HarnessLifecycleEvent =
  | 'session_start'
  | 'session_tree'
  | 'turn_start'
  | 'agent_settled'
  | 'session_shutdown'
  | 'tool_result';

interface HarnessLifecycleEventMap {
  session_start: SessionStartEvent;
  session_tree: SessionTreeEvent;
  turn_start: TurnStartEvent;
  agent_settled: AgentSettledEvent;
  session_shutdown: SessionShutdownEvent;
  tool_result: ToolResultEvent;
}

type HarnessHandler<K extends HarnessLifecycleEvent> = (
  event: HarnessLifecycleEventMap[K],
  context: ExtensionContext,
) => unknown | Promise<unknown>;

type UnknownHandler = (event: unknown, context: ExtensionContext) => unknown | Promise<unknown>;

export interface OrderedCall {
  readonly sequence: number;
  readonly area: string;
  readonly operation: string;
}

export interface AppendCall<T = unknown> {
  readonly customType: string;
  readonly data: T | undefined;
  readonly parentId: string | null;
}

export interface SendCall<T = unknown> {
  readonly message: {
    readonly customType: string;
    readonly content: unknown;
    readonly display: boolean;
    readonly details?: T;
  };
  readonly options:
    | {
        readonly triggerTurn?: boolean;
        readonly deliverAs?: 'steer' | 'followUp' | 'nextTurn';
      }
    | undefined;
}

export interface UiCall {
  readonly surface: string;
  readonly args: readonly unknown[];
}

export interface StaticRegistrations {
  readonly tools: unknown[];
  readonly commands: Array<{ readonly name: string; readonly options: unknown }>;
  readonly shortcuts: Array<{ readonly shortcut: string; readonly options: unknown }>;
  readonly messageRenderers: Array<{ readonly customType: string; readonly renderer: unknown }>;
  readonly entryRenderers: Array<{ readonly customType: string; readonly renderer: unknown }>;
  readonly markdownTransformers: unknown[];
}

export interface FakePiHarnessOptions {
  readonly mode?: FakeExtensionMode;
  readonly trusted?: boolean;
  readonly persistent?: boolean;
  readonly cwd?: string;
  readonly nodeVersion?: string;
  readonly piVersion?: string;
  readonly now?: string;
}

export function makeCustomEntry<T>(input: {
  id: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  data?: T;
}): SessionEntry {
  return {
    type: 'custom',
    id: input.id,
    parentId: input.parentId ?? null,
    timestamp: input.timestamp ?? '2026-01-02T03:04:05.000Z',
    customType: input.customType ?? 'pi-signal-board/event',
    data: input.data,
  };
}

export function makeCompactionEntry(input: {
  id: string;
  parentId?: string | null;
  timestamp?: string;
}): SessionEntry {
  return {
    type: 'compaction',
    id: input.id,
    parentId: input.parentId ?? null,
    timestamp: input.timestamp ?? '2026-01-02T03:04:05.000Z',
    summary: 'Synthetic compacted context.',
    firstKeptEntryId: input.id,
    tokensBefore: 100,
  };
}

function defaultEvent<K extends HarnessLifecycleEvent>(name: K): HarnessLifecycleEventMap[K] {
  const events: HarnessLifecycleEventMap = {
    session_start: { type: 'session_start', reason: 'startup' },
    session_tree: {
      type: 'session_tree',
      oldLeafId: null,
      newLeafId: null,
      fromExtension: false,
    },
    turn_start: { type: 'turn_start', turnIndex: 0, timestamp: 0 },
    agent_settled: { type: 'agent_settled' },
    session_shutdown: { type: 'session_shutdown', reason: 'quit' },
    tool_result: {
      type: 'tool_result',
      toolCallId: 'synthetic-tool-call',
      toolName: 'synthetic_tool',
      input: {},
      content: [{ type: 'text', text: 'synthetic result' }],
      details: undefined,
      isError: false,
    },
  };
  return events[name];
}

export class FakePiHarness {
  readonly clock: FakeClock;
  readonly ids = new DeterministicIds();
  readonly timers: FakeTimers;
  readonly configReader = new FakeConfigReader();
  readonly orderedCalls: OrderedCall[] = [];
  readonly appendCalls: AppendCall[] = [];
  readonly sendCalls: SendCall[] = [];
  readonly uiCalls: UiCall[] = [];
  readonly registrations: StaticRegistrations = {
    tools: [],
    commands: [],
    shortcuts: [],
    messageRenderers: [],
    entryRenderers: [],
    markdownTransformers: [],
  };
  readonly versions: { node: string; pi: string | undefined };

  readonly api: ExtensionAPI;

  mode: FakeExtensionMode;
  trusted: boolean;
  persistent: boolean;
  cwd: string;
  generation = 1;
  branchReads = 0;
  entriesReads = 0;
  trustReads = 0;

  private sequence = 0;
  private entryCounter = 1;
  private readonly entries = new Map<string, SessionEntry>();
  private entryOrder: string[] = [];
  private leafId: string | null = null;
  private sessionId = 'session-synthetic-0001';
  private readonly handlers = new Map<string, UnknownHandler[]>();
  private readonly appendFailures: unknown[] = [];
  private readonly sendFailures: unknown[] = [];
  private readonly uiFailures = new Map<string, unknown[]>();
  private readonly shortcutRegistrationFailures: unknown[] = [];
  private readonly dialogResults = new Map<string, unknown[]>();
  private getEntriesFailure: unknown;
  private commandsOverride: unknown[] | undefined;

  constructor(options: FakePiHarnessOptions = {}) {
    this.mode = options.mode ?? 'tui';
    this.trusted = options.trusted ?? true;
    this.persistent = options.persistent ?? true;
    this.cwd = options.cwd ?? SYNTHETIC_CWD;
    this.versions = { node: options.nodeVersion ?? '22.19.0', pi: options.piVersion ?? '0.84.1' };
    this.clock = new FakeClock(options.now);
    this.timers = new FakeTimers(this.clock);
    this.api = this.createApi();
  }

  context(mode = this.mode): ExtensionContext {
    const ui = this.createUi(mode);
    const sessionManager = {
      getCwd: () => this.cwd,
      getSessionDir: () => '/sessions/signal-fixture',
      getSessionId: () => this.sessionId,
      getSessionFile: () => (this.persistent ? SYNTHETIC_SESSION_FILE : undefined),
      getLeafId: () => this.leafId,
      getLeafEntry: () => (this.leafId === null ? undefined : this.entries.get(this.leafId)),
      getEntry: (id: string) => this.entries.get(id),
      getLabel: () => undefined,
      getBranch: (fromId?: string) => this.getBranch(fromId),
      buildContextEntries: () => this.getBranch(),
      getHeader: () => ({
        type: 'session' as const,
        version: 3,
        id: this.sessionId,
        timestamp: this.clock.now().toISOString(),
        cwd: this.cwd,
      }),
      getEntries: () => this.getEntries(),
      getTree: () => [],
      getSessionName: () => undefined,
    };

    // The harness supplies only the documented members used by Agent Board. The cast is the
    // validated Pi API boundary; tests fail when product code reaches an unmodelled member.
    return {
      ui,
      mode,
      hasUI: mode === 'tui' || mode === 'rpc',
      cwd: this.cwd,
      sessionManager,
      modelRegistry: undefined,
      model: undefined,
      scopedModels: [],
      isIdle: () => true,
      isProjectTrusted: () => {
        this.trustReads += 1;
        this.record('context', 'isProjectTrusted');
        return this.trusted;
      },
      signal: undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => '',
    } as unknown as ExtensionContext;
  }

  replaceBranch(entries: readonly SessionEntry[]): void {
    this.replaceTree(entries, entries.at(-1)?.id ?? null);
  }

  replaceTree(entries: readonly SessionEntry[], leafId: string | null): void {
    this.entries.clear();
    this.entryOrder = [];
    for (const entry of entries) {
      this.entries.set(entry.id, structuredClone(entry));
      this.entryOrder.push(entry.id);
    }
    if (leafId !== null && !this.entries.has(leafId)) {
      throw new Error(`Unknown synthetic leaf: ${leafId}`);
    }
    this.leafId = leafId;
    this.generation += 1;
    this.record('session', 'replaceTree');
  }

  selectLeaf(leafId: string | null): void {
    if (leafId !== null && !this.entries.has(leafId)) {
      throw new Error(`Unknown synthetic leaf: ${leafId}`);
    }
    this.leafId = leafId;
    this.generation += 1;
    this.record('session', 'selectLeaf');
  }

  getBranch(fromId = this.leafId ?? undefined): SessionEntry[] {
    this.branchReads += 1;
    this.record('session', 'getBranch');
    if (fromId === undefined) return [];

    const branch: SessionEntry[] = [];
    const visited = new Set<string>();
    let current: string | null = fromId;
    while (current !== null) {
      if (visited.has(current)) throw new Error('Synthetic session tree contains a cycle.');
      visited.add(current);
      const entry = this.entries.get(current);
      if (!entry) throw new Error(`Synthetic session tree has missing entry: ${current}`);
      branch.push(structuredClone(entry));
      current = entry.parentId;
    }
    return branch.reverse();
  }

  getEntries(): SessionEntry[] {
    this.entriesReads += 1;
    this.record('session', 'getEntries');
    if (this.getEntriesFailure !== undefined) throw this.getEntriesFailure;
    return this.entryOrder.map((id) => structuredClone(this.entries.get(id) as SessionEntry));
  }

  forbidGetEntries(reason: unknown = new Error('Production replay must use getBranch().')): void {
    this.getEntriesFailure = reason;
  }

  failNextAppend(reason: unknown = new Error('Synthetic append failure.')): void {
    this.appendFailures.push(reason);
  }

  failNextSend(reason: unknown = new Error('Synthetic send failure.')): void {
    this.sendFailures.push(reason);
  }

  failNextShortcutRegistration(
    reason: unknown = new Error('Synthetic shortcut registration failure.'),
  ): void {
    this.shortcutRegistrationFailures.push(reason);
  }

  failNextUi(surface: string, reason: unknown = new Error(`Synthetic ${surface} failure.`)): void {
    const failures = this.uiFailures.get(surface) ?? [];
    failures.push(reason);
    this.uiFailures.set(surface, failures);
  }

  queueUiResult(
    surface: 'select' | 'confirm' | 'input' | 'editor' | 'custom',
    value: unknown,
  ): void {
    const values = this.dialogResults.get(surface) ?? [];
    values.push(value);
    this.dialogResults.set(surface, values);
  }

  setCommands(commands: readonly unknown[]): void {
    this.commandsOverride = [...commands];
  }

  registrationCount(kind: keyof StaticRegistrations): number {
    return this.registrations[kind].length;
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  deferred<T>(label: string): Deferred<T> {
    this.record('deferred', `create:${label}`);
    return createDeferred<T>(label);
  }

  async dispatch<K extends HarnessLifecycleEvent>(
    name: K,
    event: HarnessLifecycleEventMap[K] = defaultEvent(name),
    context: ExtensionContext = this.context(),
  ): Promise<readonly unknown[]> {
    this.record('lifecycle', name);
    const results: unknown[] = [];
    for (const handler of this.handlers.get(name) ?? []) {
      results.push(await handler(event, context));
    }
    return results;
  }

  private record(area: string, operation: string): void {
    this.orderedCalls.push({ sequence: ++this.sequence, area, operation });
  }

  private nextEntryId(): string {
    return (this.entryCounter++).toString(16).padStart(8, '0');
  }

  private consumeFailure(queue: unknown[]): void {
    if (queue.length === 0) return;
    throw queue.shift();
  }

  private consumeUiFailure(surface: string): void {
    this.consumeFailure(this.uiFailures.get(surface) ?? []);
  }

  private consumeResult<T>(surface: string, fallback: T): T {
    const values = this.dialogResults.get(surface);
    return (values?.length ? values.shift() : fallback) as T;
  }

  private createApi(): ExtensionAPI {
    const api = {
      on: (event: string, handler: UnknownHandler) => {
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
        this.record('registration', `handler:${event}`);
      },
      registerTool: (tool: unknown) => {
        this.registrations.tools.push(tool);
        this.record('registration', 'tool');
      },
      registerCommand: (name: string, options: unknown) => {
        this.registrations.commands.push({ name, options });
        this.record('registration', 'command');
      },
      registerShortcut: (shortcut: string, options: unknown) => {
        this.consumeFailure(this.shortcutRegistrationFailures);
        this.registrations.shortcuts.push({ shortcut, options });
        this.record('registration', 'shortcut');
      },
      registerMessageRenderer: (customType: string, renderer: unknown) => {
        this.registrations.messageRenderers.push({ customType, renderer });
        this.record('registration', 'messageRenderer');
      },
      registerEntryRenderer: (customType: string, renderer: unknown) => {
        this.registrations.entryRenderers.push({ customType, renderer });
        this.record('registration', 'entryRenderer');
      },
      registerMarkdownTransformer: (transformer: unknown) => {
        this.registrations.markdownTransformers.push(transformer);
        this.record('registration', 'markdownTransformer');
      },
      appendEntry: (customType: string, data?: unknown) => {
        this.record('pi', 'appendEntry:attempt');
        this.consumeFailure(this.appendFailures);
        const parentId = this.leafId;
        this.appendCalls.push({ customType, data: structuredClone(data), parentId });
        const entry = makeCustomEntry({
          id: this.nextEntryId(),
          parentId,
          timestamp: this.clock.now().toISOString(),
          customType,
          data: structuredClone(data),
        });
        this.entries.set(entry.id, entry);
        this.entryOrder.push(entry.id);
        this.leafId = entry.id;
        this.record('pi', 'appendEntry:recorded');
      },
      sendMessage: (message: SendCall['message'], options?: SendCall['options']) => {
        this.record('pi', 'sendMessage:attempt');
        this.consumeFailure(this.sendFailures);
        this.sendCalls.push({
          message: structuredClone(message),
          options: options === undefined ? undefined : structuredClone(options),
        });
        this.record('pi', 'sendMessage:recorded');
      },
      getCommands: () => {
        if (this.commandsOverride) return structuredClone(this.commandsOverride);
        return this.registrations.commands.map(({ name }) => ({
          name,
          description: undefined,
          source: 'extension',
          sourceInfo: {
            path: '/packages/pi-signal-board/dist/index.js',
            source: 'pi-signal-board',
            scope: 'temporary',
            origin: 'package',
          },
        }));
      },
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => undefined,
      getThinkingLevel: () => 'medium',
      setThinkingLevel: () => undefined,
      getFlag: () => undefined,
      registerFlag: () => undefined,
      setSessionName: () => undefined,
      getSessionName: () => undefined,
      setLabel: () => undefined,
      sendUserMessage: () => undefined,
      events: { on: () => () => undefined, emit: () => undefined },
    };

    // This is the single fake host boundary. Product calls not represented above fail at runtime.
    return api as unknown as ExtensionAPI;
  }

  private createUi(mode: FakeExtensionMode): ExtensionContext['ui'] {
    const call = (surface: string, args: readonly unknown[]) => {
      this.uiCalls.push({ surface, args });
      this.record('ui', surface);
      this.consumeUiFailure(surface);
    };

    const ui = {
      select: async (...args: readonly unknown[]) => {
        call('select', args);
        return this.consumeResult<string | undefined>('select', undefined);
      },
      confirm: async (...args: readonly unknown[]) => {
        call('confirm', args);
        return this.consumeResult('confirm', false);
      },
      input: async (...args: readonly unknown[]) => {
        call('input', args);
        return this.consumeResult<string | undefined>('input', undefined);
      },
      editor: async (...args: readonly unknown[]) => {
        call('editor', args);
        return this.consumeResult<string | undefined>('editor', undefined);
      },
      custom: async (...args: readonly unknown[]) => {
        call('custom', args);
        if (mode !== 'tui') return undefined;
        return this.consumeResult<unknown>('custom', undefined);
      },
      notify: (...args: readonly unknown[]) => call('notify', args),
      setStatus: (...args: readonly unknown[]) => call('setStatus', args),
      setWidget: (...args: readonly unknown[]) => call('setWidget', args),
      setTitle: (...args: readonly unknown[]) => call('setTitle', args),
      setEditorText: (...args: readonly unknown[]) => call('setEditorText', args),
      pasteToEditor: (...args: readonly unknown[]) => call('pasteToEditor', args),
      getEditorText: () => '',
      onTerminalInput: () => () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: true }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
      theme: {},
    };
    return ui as unknown as ExtensionContext['ui'];
  }
}

export function asLifecycleHandler<K extends HarnessLifecycleEvent>(
  handler: HarnessHandler<K>,
): HarnessHandler<K> {
  return handler;
}
