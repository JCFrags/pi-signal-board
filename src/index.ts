import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import type { ConfigLoadContext, FixedConfigReader } from './config/loader.js';
import { loadConfiguration } from './config/loader.js';
import type { ConfigLoadResult } from './config/types.js';
import {
  ACK_TOOL_NAME,
  ANSWER_CUSTOM_TYPE,
  COMMAND_INVOCATION,
  COMMAND_NAME,
  SHORTCUT,
} from './constants.js';
import { RuntimeIdGenerator } from './domain/ids.js';
import type { CompatibilityResult } from './integration/compatibility.js';
import { evaluateCurrentHostCompatibility } from './integration/compatibility.js';
import { formatDoctorReport, formatM0Usage } from './integration/doctor.js';
import {
  DEFAULT_REPLAY_ADAPTER,
  RuntimeLifecycle,
  type RuntimeLifecycleAdapters,
} from './integration/lifecycle.js';
import { createPiSessionStore } from './persistence/pi-session-store.js';
import type { RuntimeLifecycleHooks, SignalBoardRuntime } from './runtime/types.js';
import { ExpiryService, type ExpiryTimerAdapter } from './services/expiry-service.js';
import { QuestionEscalationService } from './services/question-escalation-service.js';
import { TurnQuestionRateCounter } from './services/question-rate-counter.js';
import { QuestionService } from './services/question-service.js';
import { TurnUpdateRateCounter } from './services/update-rate-counter.js';
import { UpdateService } from './services/update-service.js';
import { registerQuestionTool } from './tools/question-tool.js';
import {
  PendingToolFailures,
  patchPendingToolFailure,
  registerUpdateTool,
} from './tools/update-tool.js';
import { completionWindowCutoff, createSignalBoardUiAdapter } from './ui/adapter.js';

export interface SignalBoardExtensionAdapters {
  readonly evaluateCompatibility: () => CompatibilityResult;
  readonly loadConfig: (context: ConfigLoadContext) => Promise<ConfigLoadResult>;
  readonly now: () => Date;
  readonly effectiveCommand: (runtime: SignalBoardRuntime) => string;
  readonly writePrint: (text: string) => void;
  readonly replay: RuntimeLifecycleAdapters['replay'];
  readonly hooks: RuntimeLifecycleHooks;
  readonly expiryTimers: ExpiryTimerAdapter;
  readonly captureLifecycle?: (lifecycle: RuntimeLifecycle) => void;
}

const DEFAULT_ADAPTERS: SignalBoardExtensionAdapters = {
  evaluateCompatibility: evaluateCurrentHostCompatibility,
  loadConfig: loadConfiguration,
  now: () => new Date(),
  effectiveCommand: () => COMMAND_INVOCATION,
  writePrint: (text) => process.stdout.write(`${text}\n`),
  replay: DEFAULT_REPLAY_ADAPTER,
  hooks: Object.freeze({}),
  expiryTimers: {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
};

function safeEmit(
  context: ExtensionContext,
  text: string,
  writePrint: SignalBoardExtensionAdapters['writePrint'],
): void {
  if (context.mode === 'print') {
    try {
      writePrint(text);
    } catch {
      // A failed print stream must not escape the command boundary.
    }
  }
  try {
    context.ui.notify(text, 'info');
  } catch {
    // A failed UI surface must not escape the command boundary.
  }
}

function runtimeErrorText(code: string): string {
  return `Signal Board runtime unavailable (${code}). No state changed.`;
}

/** Build the extension factory with deterministic host and lifecycle adapters. */
export function createSignalBoardExtension(
  overrides: Partial<SignalBoardExtensionAdapters> = {},
): (pi: ExtensionAPI) => void {
  const adapters: SignalBoardExtensionAdapters = { ...DEFAULT_ADAPTERS, ...overrides };

  return (pi: ExtensionAPI): void => {
    let lifecycle: RuntimeLifecycle;
    const hooks: RuntimeLifecycleHooks = {
      ...adapters.hooks,
      async evaluateExpiryLocked(runtime) {
        constructRuntimeServices(runtime, pi, lifecycle, adapters);
        await runtime.expiryService?.evaluateExpiryLocked(adapters.now());
        await adapters.hooks.evaluateExpiryLocked?.(runtime);
      },
      async resetTurnRateCountersLocked(runtime) {
        runtime.updateRateCounter?.reset();
        runtime.questionRateCounter?.reset();
        await adapters.hooks.resetTurnRateCountersLocked?.(runtime);
      },
      async onTimerLocked(runtime) {
        await runtime.expiryService?.evaluateExpiryLocked(adapters.now());
        await adapters.hooks.onTimerLocked?.(runtime);
      },
      armTimerLocked(runtime, callback) {
        if (adapters.hooks.armTimerLocked !== undefined) {
          return adapters.hooks.armTimerLocked(runtime, callback);
        }
        return runtime.expiryService?.armNearestTimerLocked(callback);
      },
      clearTimer(handle) {
        if (adapters.hooks.armTimerLocked !== undefined) {
          if (adapters.hooks.clearTimer !== undefined) {
            adapters.hooks.clearTimer(handle);
          } else {
            safeClearExpiryHandle(adapters.expiryTimers, handle);
          }
          return;
        }
        const current = lifecycle.slot.current();
        if (
          current !== undefined &&
          current.timer === handle &&
          current.expiryService !== undefined
        ) {
          current.expiryService.clearTimerLocked();
          return;
        }
        safeClearExpiryHandle(adapters.expiryTimers, handle);
      },
      async escalateConditionalQuestionsLocked(runtime) {
        constructRuntimeServices(runtime, pi, lifecycle, adapters);
        const result = await runtime.questionEscalationService?.escalateConditionalQuestionsLocked(
          safeAdapterTimestamp(adapters.now),
        );
        if (result !== undefined && !result.ok) {
          runtime.diagnostics.record({
            at: safeAdapterTimestamp(adapters.now),
            code: result.error.code,
            severity: 'error',
            area: result.error.code === 'SB_PERSISTENCE_FAILED' ? 'persistence' : 'lifecycle',
            category:
              result.error.code === 'SB_PERSISTENCE_FAILED' ? 'append_rejected' : 'unexpected',
          });
        }
        await adapters.hooks.escalateConditionalQuestionsLocked?.(runtime);
      },
      async refreshLocked(runtime) {
        await adapters.hooks.refreshLocked?.(runtime);
        refreshRuntimeUi(runtime, adapters);
      },
    };
    lifecycle = new RuntimeLifecycle({
      evaluateCompatibility: adapters.evaluateCompatibility,
      loadConfig: adapters.loadConfig,
      replay: adapters.replay,
      now: adapters.now,
      hooks,
    });
    adapters.captureLifecycle?.(lifecycle);

    registerStaticRenderers(pi);
    const pendingFailures = new PendingToolFailures();
    registerStaticTools(pi, lifecycle, pendingFailures);
    pi.on('tool_result', (event) => patchPendingToolFailure(event, pendingFailures));
    pi.on('session_start', () => pendingFailures.clear());
    pi.on('session_shutdown', () => pendingFailures.clear());

    pi.registerCommand(COMMAND_NAME, {
      description: 'Show Pi Signal Board diagnostics.',
      handler: async (args, context) => {
        const text =
          args.trim() === 'doctor'
            ? formatDoctorReport(lifecycle.doctorSnapshot(context))
            : formatM0Usage();
        safeEmit(context, text, adapters.writePrint);
      },
    });

    pi.registerShortcut(SHORTCUT, {
      description: 'Open Pi Signal Board',
      handler: async (context) => {
        const access = await lifecycle.runHealthy(() => undefined);
        const code = access.ok ? 'SB_UI_UNAVAILABLE' : access.error.code;
        safeEmit(context, runtimeErrorText(code), adapters.writePrint);
      },
    });

    lifecycle.register(pi);
  };
}

function registerStaticTools(
  pi: ExtensionAPI,
  lifecycle: RuntimeLifecycle,
  pendingFailures: PendingToolFailures,
): void {
  registerUpdateTool(pi, lifecycle, pendingFailures);
  registerQuestionTool(pi, lifecycle, pendingFailures);
  for (const [name, label] of [[ACK_TOOL_NAME, 'Signal Board Acknowledgement']] as const) {
    pi.registerTool({
      name,
      label,
      description: `${label} runtime shell. Product mutations are added in a later slice.`,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const access = await lifecycle.runHealthy(() => undefined);
        const code = access.ok ? 'SB_NOT_INITIALIZED' : access.error.code;
        return {
          content: [{ type: 'text', text: runtimeErrorText(code) }],
          details: { ok: false, error: { code } },
        };
      },
    });
  }
}

function constructRuntimeServices(
  runtime: SignalBoardRuntime,
  pi: ExtensionAPI,
  lifecycle: RuntimeLifecycle,
  adapters: SignalBoardExtensionAdapters,
): void {
  if (runtime.updateService !== undefined) return;
  runtime.ui ??= createSignalBoardUiAdapter(runtime.context, runtime.diagnostics);
  const ids = new RuntimeIdGenerator();
  const rateCounter = new TurnUpdateRateCounter();
  const questionRateCounter = new TurnQuestionRateCounter();
  const sessionStore = createPiSessionStore(pi, {
    correlationIds: { nextCorrelationId: () => randomUUID() },
    at: () => adapters.now().toISOString(),
    diagnostics: runtime.diagnostics,
  });
  const generation = runtime.generation;
  const requireCurrent = (): SignalBoardRuntime => {
    const current = lifecycle.slot.current();
    if (current?.generation !== generation || current.disposed || current.status !== 'healthy') {
      throw new Error('Stale Signal Board runtime.');
    }
    return current;
  };
  runtime.ids = ids;
  runtime.updateRateCounter = rateCounter;
  runtime.questionRateCounter = questionRateCounter;
  runtime.sessionStore = sessionStore;
  const refresh = async (): Promise<void> => {
    const current = requireCurrent();
    await adapters.hooks.refreshLocked?.(current);
    refreshRuntimeUi(current, adapters);
  };
  const afterMutationLocked = async (): Promise<void> => {
    await lifecycle.mutationBoundaryLocked(requireCurrent());
  };
  runtime.expiryService = new ExpiryService({
    queue: lifecycle.queue,
    readState: () => requireCurrent().state,
    swapState: (state) => {
      requireCurrent().state = state;
    },
    append: (event) => sessionStore.append(event),
    refresh,
    clock: { now: adapters.now },
    ids,
    timers: adapters.expiryTimers,
    recordDiagnostic: (record) => {
      requireCurrent().diagnostics.record({
        at: safeAdapterTimestamp(adapters.now),
        code: record.code,
        severity: record.code === 'SB_UI_UNAVAILABLE' ? 'warning' : 'error',
        area:
          record.code === 'SB_PERSISTENCE_FAILED'
            ? 'persistence'
            : record.code === 'SB_UI_UNAVAILABLE'
              ? 'ui'
              : 'lifecycle',
        category: record.category,
      });
    },
  });
  runtime.updateService = new UpdateService({
    queue: lifecycle.queue,
    readState: () => requireCurrent().state,
    swapState: (state) => {
      requireCurrent().state = state;
    },
    append: (event) => sessionStore.append(event),
    refresh,
    afterMutationLocked,
    clock: { now: adapters.now },
    ids,
    cwd: runtime.context.cwd,
    config: runtime.config.config,
    rateCounter,
  });
  runtime.questionService = new QuestionService({
    queue: lifecycle.queue,
    readState: () => requireCurrent().state,
    swapState: (state) => {
      requireCurrent().state = state;
    },
    append: (event) => sessionStore.append(event),
    refresh,
    afterMutationLocked,
    clock: { now: adapters.now },
    ids,
    cwd: runtime.context.cwd,
    config: runtime.config.config,
    rateCounter: questionRateCounter,
  });
  runtime.questionEscalationService = new QuestionEscalationService({
    queue: lifecycle.queue,
    readState: () => requireCurrent().state,
    swapState: (state) => {
      requireCurrent().state = state;
    },
    append: (event) => sessionStore.append(event),
    refresh,
    notify: (message, severity) => {
      const current = requireCurrent();
      if (current.context.hasUI) current.context.ui.notify(message, severity);
    },
    recordPostDurableFailure: (area, at) => {
      requireCurrent().diagnostics.record({
        at,
        code: 'SB_UI_UNAVAILABLE',
        severity: 'warning',
        area: area === 'notification' ? 'lifecycle' : 'ui',
        category: 'ui_failure',
      });
    },
    clock: { now: adapters.now },
    ids,
    config: runtime.config.config,
  });
}

function refreshRuntimeUi(
  runtime: SignalBoardRuntime,
  adapters: SignalBoardExtensionAdapters,
): void {
  runtime.ui ??= createSignalBoardUiAdapter(runtime.context, runtime.diagnostics);
  const currentTime = adapters.now();
  runtime.ui.refresh({
    state: runtime.state,
    config: runtime.config.config,
    currentTime: currentTime.toISOString(),
    completedWindowCutoff: completionWindowCutoff(
      currentTime,
      runtime.config.config.widget.showCompletedForMinutes,
    ),
    effectiveCommand: adapters.effectiveCommand(runtime),
  });
}

function safeClearExpiryHandle(timers: ExpiryTimerAdapter, handle: unknown): void {
  try {
    timers.clearTimeout(handle);
  } catch {
    // Timer cleanup is best-effort and content-free.
  }
}

function safeAdapterTimestamp(now: () => Date): string {
  try {
    return now().toISOString();
  } catch {
    return '1970-01-01T00:00:00.000Z';
  }
}

function registerStaticRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    ANSWER_CUSTOM_TYPE,
    (_message, _options, theme) => new Text(theme.fg('muted', '[Signal Board answer]'), 0, 0),
  );
}

export default function signalBoardExtension(pi: ExtensionAPI): void {
  createSignalBoardExtension()(pi);
}

export type { FixedConfigReader };
export { RuntimeLifecycle } from './integration/lifecycle.js';
export { RuntimeSlot } from './runtime/slot.js';
export type * from './runtime/types.js';
export * from './ui/board/component.js';
export * from './ui/board/model.js';
