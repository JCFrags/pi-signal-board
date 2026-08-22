import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';

import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { ConfigLoadContext } from '../config/loader.js';
import type { ConfigLoadResult, ConfigWarning } from '../config/types.js';
import { STATUS_ID, WIDGET_ID } from '../constants.js';
import { fail, type Result, signalBoardError } from '../domain/errors.js';
import { createEmptyBoardState } from '../domain/reducer.js';
import { type ReplayOutcome, replayBranch } from '../persistence/replay.js';
import { RuntimeSlot } from '../runtime/slot.js';
import type {
  RuntimeAccessResult,
  RuntimeLifecycleHooks,
  SignalBoardRuntime,
} from '../runtime/types.js';
import type { BoardViewCheckpointResult } from '../services/board-view-checkpoint-service.js';
import { createDiagnostics, type Diagnostics } from '../services/diagnostics.js';
import type { ExpiryEvaluation } from '../services/expiry-service.js';
import { MutationQueue } from '../services/mutation-queue.js';
import type { CompatibilityResult } from './compatibility.js';
import { evaluateHostCompatibility } from './compatibility.js';
import type { SessionHealthSnapshot } from './doctor.js';

const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export interface RuntimeLifecycleAdapters {
  readonly evaluateCompatibility: () => CompatibilityResult;
  readonly loadConfig: (context: ConfigLoadContext) => Promise<ConfigLoadResult>;
  readonly replay: (entries: readonly SessionEntry[]) => ReplayOutcome;
  readonly now: () => Date;
  readonly hooks: RuntimeLifecycleHooks;
}

/** Owns one extension-instance queue and every session runtime generation. */
export class RuntimeLifecycle {
  readonly queue = new MutationQueue();
  readonly slot = new RuntimeSlot();
  readonly #adapters: RuntimeLifecycleAdapters;
  #nextGeneration = 0;
  #registered = false;

  constructor(adapters: RuntimeLifecycleAdapters) {
    this.#adapters = adapters;
  }

  register(pi: Pick<ExtensionAPI, 'on'>): void {
    if (this.#registered) return;
    this.#registered = true;
    pi.on('session_start', async (_event, context) => {
      await this.start(context);
    });
    pi.on('session_tree', async (_event, context) => {
      await this.replaceTree(context);
    });
    pi.on('turn_start', async () => {
      await this.turnStart();
    });
    pi.on('agent_settled', async () => {
      await this.agentSettled();
    });
    pi.on('session_shutdown', async () => {
      await this.shutdown();
    });
  }

  async start(context: ExtensionContext): Promise<void> {
    await this.queue.run(async () => {
      const previous = this.slot.current();
      if (previous !== undefined) this.disposeLocked(previous);

      const generation = ++this.#nextGeneration;
      const diagnostics = createDiagnostics();
      const at = safeTimestamp(this.#adapters.now);
      const trusted = safeTrust(context, diagnostics, at);
      const compatibility = safeCompatibility(this.#adapters, diagnostics, at);
      if (!compatibility.supported) {
        diagnostics.record({
          at,
          code: 'SB_UNSUPPORTED_HOST',
          severity: 'error',
          area: 'compatibility',
          category: 'unsupported_version',
        });
      }
      const config = await safeConfig(this.#adapters, context, trusted, diagnostics, at);
      recordConfigWarnings(config.warnings, diagnostics, at);

      let replay: ReplayOutcome;
      let replayFailed = false;
      try {
        replay = this.#adapters.replay(context.sessionManager.getBranch());
      } catch {
        replayFailed = true;
        replay = emptyReplay();
        recordInternal(diagnostics, at, 'replay');
      }
      recordReplay(replay, diagnostics, at);

      const runtime: SignalBoardRuntime = {
        generation,
        identity: safeIdentity(context, generation),
        treeRevision: 0,
        context,
        queue: this.queue,
        compatibility,
        config,
        diagnostics,
        state: replay.state,
        status: initialStatus(
          compatibility,
          config,
          replayFailed || diagnostics.count('SB_INTERNAL') > 0,
        ),
        timer: undefined,
        disposed: false,
        disposeCount: 0,
        notifications: new Set(),
      };
      this.slot.replaceLocked(runtime);

      if (runtime.status === 'healthy') {
        try {
          await this.#adapters.hooks.evaluateExpiryLocked?.(runtime);
          await this.#adapters.hooks.recoverDeliveryLocked?.(runtime);
          await this.refreshLocked(runtime);
          await this.armTimerLocked(runtime);
          if (runtime.config.warnings.length > 0 || replay.warnings.length > 0) {
            this.notifyStartupOnceLocked(runtime);
          }
        } catch {
          recordInternal(runtime.diagnostics, at, 'lifecycle');
          runtime.status = 'degraded';
          this.clearTimerLocked(runtime);
          this.clearSurfacesLocked(runtime);
          this.notifyStartupOnceLocked(runtime);
        }
      } else {
        this.clearSurfacesLocked(runtime);
        this.notifyStartupOnceLocked(runtime);
      }
    });
  }

  async replaceTree(context: ExtensionContext): Promise<void> {
    await this.queue.run(async () => {
      const runtime = this.slot.current();
      if (runtime === undefined || runtime.disposed) return;
      this.clearTimerLocked(runtime);
      runtime.treeRevision += 1;

      let replay: ReplayOutcome;
      try {
        replay = this.#adapters.replay(context.sessionManager.getBranch());
      } catch {
        replay = emptyReplay();
        runtime.status = 'degraded';
        recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'replay');
      }
      runtime.state = replay.state;
      recordReplay(replay, runtime.diagnostics, safeTimestamp(this.#adapters.now));

      if (runtime.status === 'healthy') {
        try {
          await this.refreshLocked(runtime);
          await this.armTimerLocked(runtime);
        } catch {
          recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
          this.clearTimerLocked(runtime);
          this.clearSurfacesLocked(runtime);
        }
      } else {
        this.clearSurfacesLocked(runtime);
      }
    });
  }

  async turnStart(): Promise<void> {
    await this.queue.run(async () => {
      const runtime = this.healthyRuntimeLocked();
      if (runtime === undefined) return;
      try {
        await this.#adapters.hooks.resetTurnRateCountersLocked?.(runtime);
      } catch {
        recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
      }
    });
  }

  async agentSettled(): Promise<void> {
    await this.queue.run(async () => {
      const runtime = this.healthyRuntimeLocked();
      if (runtime === undefined) return;
      try {
        await this.#adapters.hooks.evaluateExpiryLocked?.(runtime);
        await this.#adapters.hooks.escalateConditionalQuestionsLocked?.(runtime);
      } catch {
        recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
      } finally {
        await this.refreshLocked(runtime);
        await this.rearmTimerContainedLocked(runtime);
      }
    });
  }

  /** Evaluate expiry at the board-open boundary without adding board UI. */
  evaluateBoardOpen(): Promise<RuntimeAccessResult<ExpiryEvaluation>> {
    return this.runHealthy(async (runtime) => {
      const evaluation = await runtime.expiryService?.evaluateExpiryLocked(this.#adapters.now());
      if (evaluation === undefined) throw new Error('Expiry service is unavailable.');
      await this.rearmTimerContainedLocked(runtime);
      return evaluation;
    });
  }

  /** Persist one normal board-close checkpoint through the shared runtime queue. */
  markBoardViewed(
    cutoffAt: string,
    expected: {
      readonly generation: number;
      readonly identityToken: string;
      readonly treeRevision: number;
    },
  ): Promise<Result<BoardViewCheckpointResult>> {
    return this.queue.run(async () => {
      const access = this.slot.requireHealthyLocked();
      if (!access.ok) {
        const code =
          access.error.code === 'SB_DISABLED'
            ? 'SB_CONFIG_DISABLED'
            : access.error.code === 'SB_INTERNAL'
              ? undefined
              : access.error.code;
        return code === undefined ? fail(internalPublicError()) : fail(signalBoardError(code));
      }
      if (
        access.value.generation !== expected.generation ||
        access.value.identity.token !== expected.identityToken ||
        access.value.treeRevision !== expected.treeRevision
      ) {
        return fail(signalBoardError('SB_STATE_CONFLICT'));
      }
      const service = access.value.boardViewCheckpointService;
      if (service === undefined) return fail(internalPublicError());
      try {
        return await service.markViewedLocked({ cutoffAt });
      } catch {
        recordInternal(access.value.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
        return fail(internalPublicError());
      }
    });
  }

  /** Complete timer work after a service mutation that already owns this queue. */
  async mutationBoundaryLocked(runtime: SignalBoardRuntime): Promise<void> {
    const current = this.slot.current();
    if (
      current?.generation !== runtime.generation ||
      current.disposed ||
      current.status !== 'healthy'
    ) {
      return;
    }
    await this.#adapters.hooks.evaluateExpiryLocked?.(current);
    await this.rearmTimerContainedLocked(current);
  }

  async shutdown(): Promise<void> {
    await this.queue.run(() => {
      const runtime = this.slot.current();
      if (runtime === undefined) return;
      const generation = runtime.generation;
      this.disposeLocked(runtime);
      this.slot.clearIfGenerationLocked(generation);
    });
  }

  /** Public mutation access enters the same queue used by all lifecycle work. */
  runHealthy<T>(
    operation: (runtime: SignalBoardRuntime) => T | Promise<T>,
  ): Promise<RuntimeAccessResult<T>> {
    return this.queue.run(async () => {
      const access = this.slot.requireHealthyLocked();
      if (!access.ok) return access;
      try {
        return { ok: true, value: await operation(access.value) };
      } catch {
        recordInternal(access.value.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
        return {
          ok: false,
          error: {
            code: 'SB_INTERNAL',
            message: 'Agent Board startup did not complete safely.',
            retryable: true,
          },
        };
      }
    });
  }

  doctorSnapshot(context: ExtensionContext): SessionHealthSnapshot {
    return this.slot.doctorSnapshot(context);
  }

  private healthyRuntimeLocked(): SignalBoardRuntime | undefined {
    const runtime = this.slot.current();
    return runtime !== undefined && !runtime.disposed && runtime.status === 'healthy'
      ? runtime
      : undefined;
  }

  private async refreshLocked(runtime: SignalBoardRuntime): Promise<void> {
    try {
      await this.#adapters.hooks.refreshLocked?.(runtime);
    } catch {
      runtime.diagnostics.record({
        at: safeTimestamp(this.#adapters.now),
        code: 'SB_UI_UNAVAILABLE',
        severity: 'warning',
        area: 'ui',
        category: 'ui_failure',
      });
      this.clearSurfacesLocked(runtime);
    }
  }

  private async rearmTimerContainedLocked(runtime: SignalBoardRuntime): Promise<void> {
    this.clearTimerLocked(runtime);
    try {
      await this.armTimerLocked(runtime);
    } catch {
      recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
      this.clearTimerLocked(runtime);
    }
  }

  private async armTimerLocked(runtime: SignalBoardRuntime): Promise<void> {
    if (runtime.disposed || runtime.status !== 'healthy') return;
    const generation = runtime.generation;
    const handle = await this.#adapters.hooks.armTimerLocked?.(runtime, async () => {
      await this.queue.run(async () => {
        const current = this.slot.current();
        if (current?.generation !== generation || current.disposed) return;
        current.timer = undefined;
        try {
          await this.#adapters.hooks.onTimerLocked?.(current);
          await this.refreshLocked(current);
          await this.armTimerLocked(current);
        } catch {
          recordInternal(current.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
          current.status = 'degraded';
          this.clearTimerLocked(current);
          this.clearSurfacesLocked(current);
        }
      });
    });
    if (this.slot.current()?.generation !== generation || runtime.disposed) {
      if (handle !== undefined) this.safeClearHandle(handle);
      return;
    }
    runtime.timer = handle;
  }

  private disposeLocked(runtime: SignalBoardRuntime): void {
    if (runtime.disposed) return;
    runtime.disposed = true;
    runtime.disposeCount += 1;
    this.clearTimerLocked(runtime);
    this.disposeSurfacesLocked(runtime);
    runtime.notifications.clear();
  }

  private clearTimerLocked(runtime: SignalBoardRuntime): void {
    const handle = runtime.timer;
    runtime.timer = undefined;
    if (handle !== undefined) this.safeClearHandle(handle);
  }

  private safeClearHandle(handle: unknown): void {
    try {
      this.#adapters.hooks.clearTimer?.(handle);
    } catch {
      // Timer cleanup is best-effort and content-free.
    }
  }

  private clearSurfacesLocked(runtime: SignalBoardRuntime): void {
    if (runtime.ui !== undefined) {
      try {
        runtime.ui.clear();
        return;
      } catch {
        this.recordUiCleanupFailure(runtime);
      }
    }
    this.clearSurfacesFallback(runtime);
  }

  private disposeSurfacesLocked(runtime: SignalBoardRuntime): void {
    if (runtime.ui !== undefined) {
      try {
        runtime.ui.dispose();
        return;
      } catch {
        this.recordUiCleanupFailure(runtime);
      }
    }
    this.clearSurfacesFallback(runtime);
  }

  private clearSurfacesFallback(runtime: SignalBoardRuntime): void {
    safeUiCall(runtime, 'widget', () => runtime.context.ui.setWidget(WIDGET_ID, undefined));
    safeUiCall(runtime, 'status', () => runtime.context.ui.setStatus(STATUS_ID, undefined));
  }

  private recordUiCleanupFailure(runtime: SignalBoardRuntime): void {
    runtime.diagnostics.record({
      at: FALLBACK_TIMESTAMP,
      code: 'SB_UI_UNAVAILABLE',
      severity: 'warning',
      area: 'ui',
      category: 'ui_failure',
    });
  }

  private notifyStartupOnceLocked(runtime: SignalBoardRuntime): void {
    if (runtime.notifications.has('startup')) return;
    runtime.notifications.add('startup');
    const message =
      runtime.status === 'unsupported'
        ? 'Agent Board is unavailable on this host. Run /agentboard doctor.'
        : runtime.status === 'disabled'
          ? 'Agent Board is disabled. Run /agentboard doctor.'
          : runtime.status === 'healthy'
            ? 'Agent Board started with recoverable warnings. Run /agentboard doctor.'
            : 'Agent Board startup failed safely. Run /agentboard doctor.';
    safeUiCall(runtime, 'notification', () => runtime.context.ui.notify(message, 'warning'));
  }
}

function initialStatus(
  compatibility: CompatibilityResult,
  config: ConfigLoadResult,
  degraded: boolean,
): SignalBoardRuntime['status'] {
  if (!compatibility.supported) return 'unsupported';
  if (!config.config.enabled) return 'disabled';
  if (degraded) return 'degraded';
  return 'healthy';
}

function emptyReplay(): ReplayOutcome {
  return Object.freeze({
    state: createEmptyBoardState(),
    acceptedEvents: 0,
    skippedEvents: 0,
    warnings: Object.freeze([]),
  });
}

function safeCompatibility(
  adapters: RuntimeLifecycleAdapters,
  diagnostics: Diagnostics,
  at: string,
): CompatibilityResult {
  try {
    return adapters.evaluateCompatibility();
  } catch {
    recordInternal(diagnostics, at, 'compatibility');
    return evaluateHostCompatibility({ nodeVersion: process.versions.node, piVersion: undefined });
  }
}

async function safeConfig(
  adapters: RuntimeLifecycleAdapters,
  context: ExtensionContext,
  trusted: boolean,
  diagnostics: Diagnostics,
  at: string,
): Promise<ConfigLoadResult> {
  try {
    return await adapters.loadConfig({ cwd: context.cwd, isProjectTrusted: () => trusted });
  } catch {
    recordInternal(diagnostics, at, 'config');
    const warning: ConfigWarning = {
      source: 'global',
      reason: 'unreadable',
      safeCategory: 'io_error',
    };
    return Object.freeze({
      config: DEFAULT_CONFIG,
      sources: Object.freeze({
        global: 'rejected' as const,
        project: trusted ? ('rejected' as const) : ('not_read_untrusted' as const),
      }),
      warnings: Object.freeze([warning]),
    });
  }
}

function safeTrust(context: ExtensionContext, diagnostics: Diagnostics, at: string): boolean {
  try {
    return context.isProjectTrusted();
  } catch {
    recordInternal(diagnostics, at, 'lifecycle');
    return false;
  }
}

function safeIdentity(
  context: ExtensionContext,
  generation: number,
): SignalBoardRuntime['identity'] {
  let persistence: 'persistent' | 'ephemeral' = 'ephemeral';
  let source = `ephemeral:${generation}`;
  try {
    const file = context.sessionManager.getSessionFile();
    persistence = file === undefined ? 'ephemeral' : 'persistent';
    source = `${persistence}:${context.sessionManager.getSessionId()}`;
  } catch {
    // Use the generation-only fallback without exposing session metadata.
  }
  return Object.freeze({
    persistence,
    token: createHash('sha256').update(source).digest('hex').slice(0, 12),
  });
}

function recordConfigWarnings(
  warnings: readonly ConfigWarning[],
  diagnostics: Diagnostics,
  at: string,
): void {
  for (const _warning of warnings) {
    diagnostics.record({
      at,
      code: 'SB_CONFIG_INVALID',
      severity: 'warning',
      area: 'config',
      category: 'invalid_data',
    });
  }
}

function recordReplay(replay: ReplayOutcome, diagnostics: Diagnostics, at: string): void {
  diagnostics.setReplayCounts(replay.acceptedEvents, replay.skippedEvents);
  for (const _warning of replay.warnings) {
    diagnostics.record({
      at,
      code: 'SB_REPLAY_SKIPPED',
      severity: 'warning',
      area: 'replay',
      category: 'decode_rejected',
    });
  }
}

function recordInternal(
  diagnostics: Diagnostics,
  at: string,
  area: 'compatibility' | 'config' | 'replay' | 'lifecycle',
): void {
  diagnostics.record({
    at,
    code: 'SB_INTERNAL',
    severity: 'error',
    area,
    category: 'unexpected',
  });
}

function safeUiCall(runtime: SignalBoardRuntime, _surface: string, operation: () => void): void {
  try {
    operation();
  } catch {
    runtime.diagnostics.record({
      at: FALLBACK_TIMESTAMP,
      code: 'SB_UI_UNAVAILABLE',
      severity: 'warning',
      area: 'ui',
      category: 'ui_failure',
    });
  }
}

function internalPublicError() {
  return Object.freeze({
    code: 'SB_INTERNAL' as const,
    message: 'Agent Board encountered an unexpected internal error.',
    retryable: true,
  });
}

function safeTimestamp(now: () => Date): string {
  try {
    return now().toISOString();
  } catch {
    return FALLBACK_TIMESTAMP;
  }
}

export const DEFAULT_REPLAY_ADAPTER = replayBranch;
