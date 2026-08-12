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
  COMMAND_NAME,
  QUESTION_TOOL_NAME,
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
import { TurnUpdateRateCounter } from './services/update-rate-counter.js';
import { UpdateService } from './services/update-service.js';
import {
  PendingToolFailures,
  patchPendingToolFailure,
  registerUpdateTool,
} from './tools/update-tool.js';

export interface SignalBoardExtensionAdapters {
  readonly evaluateCompatibility: () => CompatibilityResult;
  readonly loadConfig: (context: ConfigLoadContext) => Promise<ConfigLoadResult>;
  readonly now: () => Date;
  readonly writePrint: (text: string) => void;
  readonly replay: RuntimeLifecycleAdapters['replay'];
  readonly hooks: RuntimeLifecycleHooks;
  readonly captureLifecycle?: (lifecycle: RuntimeLifecycle) => void;
}

const DEFAULT_ADAPTERS: SignalBoardExtensionAdapters = {
  evaluateCompatibility: evaluateCurrentHostCompatibility,
  loadConfig: loadConfiguration,
  now: () => new Date(),
  writePrint: (text) => process.stdout.write(`${text}\n`),
  replay: DEFAULT_REPLAY_ADAPTER,
  hooks: Object.freeze({}),
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
        constructUpdateRuntime(runtime, pi, lifecycle, adapters);
        await adapters.hooks.evaluateExpiryLocked?.(runtime);
      },
      async resetTurnRateCountersLocked(runtime) {
        runtime.updateRateCounter?.reset();
        await adapters.hooks.resetTurnRateCountersLocked?.(runtime);
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
  for (const [name, label] of [
    [QUESTION_TOOL_NAME, 'Signal Board Question'],
    [ACK_TOOL_NAME, 'Signal Board Acknowledgement'],
  ] as const) {
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

function constructUpdateRuntime(
  runtime: SignalBoardRuntime,
  pi: ExtensionAPI,
  lifecycle: RuntimeLifecycle,
  adapters: SignalBoardExtensionAdapters,
): void {
  if (runtime.updateService !== undefined) return;
  const ids = new RuntimeIdGenerator();
  const rateCounter = new TurnUpdateRateCounter();
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
  runtime.sessionStore = sessionStore;
  runtime.updateService = new UpdateService({
    queue: lifecycle.queue,
    readState: () => requireCurrent().state,
    swapState: (state) => {
      requireCurrent().state = state;
    },
    append: (event) => sessionStore.append(event),
    refresh: async () => {
      const current = requireCurrent();
      await adapters.hooks.refreshLocked?.(current);
    },
    clock: { now: adapters.now },
    ids,
    cwd: runtime.context.cwd,
    config: runtime.config.config,
    rateCounter,
  });
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
