import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { DEFAULT_CONFIG } from '../config/defaults.js';
import { evaluateHostCompatibility } from '../integration/compatibility.js';
import { createSessionHealthSnapshot, type SessionHealthSnapshot } from '../integration/doctor.js';
import { createDiagnostics } from '../services/diagnostics.js';
import type { RuntimeAccessError, RuntimeAccessResult, SignalBoardRuntime } from './types.js';

const ACCESS_ERRORS: Readonly<Record<RuntimeAccessError['code'], RuntimeAccessError>> =
  Object.freeze({
    SB_NOT_INITIALIZED: Object.freeze({
      code: 'SB_NOT_INITIALIZED',
      message: 'Signal Board is not initialized.',
      retryable: true,
    }),
    SB_DISABLED: Object.freeze({
      code: 'SB_DISABLED',
      message: 'Signal Board is disabled by configuration.',
      retryable: false,
    }),
    SB_UNSUPPORTED_HOST: Object.freeze({
      code: 'SB_UNSUPPORTED_HOST',
      message: 'The Node.js or Pi host version is not supported.',
      retryable: false,
    }),
    SB_INTERNAL: Object.freeze({
      code: 'SB_INTERNAL',
      message: 'Signal Board startup did not complete safely.',
      retryable: true,
    }),
  });

/** Generation-aware holder for the one session runtime. */
export class RuntimeSlot {
  #runtime: SignalBoardRuntime | undefined;

  current(): SignalBoardRuntime | undefined {
    return this.#runtime;
  }

  replaceLocked(runtime: SignalBoardRuntime): void {
    this.#runtime = runtime;
  }

  clearIfGenerationLocked(generation: number): boolean {
    if (this.#runtime?.generation !== generation) return false;
    this.#runtime = undefined;
    return true;
  }

  requireHealthyLocked(): RuntimeAccessResult<SignalBoardRuntime> {
    const runtime = this.#runtime;
    if (runtime === undefined || runtime.disposed) {
      return { ok: false, error: ACCESS_ERRORS.SB_NOT_INITIALIZED };
    }
    switch (runtime.status) {
      case 'healthy':
        return { ok: true, value: runtime };
      case 'disabled':
        return { ok: false, error: ACCESS_ERRORS.SB_DISABLED };
      case 'unsupported':
        return { ok: false, error: ACCESS_ERRORS.SB_UNSUPPORTED_HOST };
      case 'degraded':
        return { ok: false, error: ACCESS_ERRORS.SB_INTERNAL };
    }
  }

  doctorSnapshot(context: ExtensionContext): SessionHealthSnapshot {
    const runtime = this.#runtime;
    if (runtime === undefined) return uninitializedSnapshot(context);
    const snapshot = createSessionHealthSnapshot({
      compatibility: runtime.compatibility,
      config: runtime.config,
      diagnostics: runtime.diagnostics.snapshot(),
      mode: runtime.context.mode,
      projectTrusted: runtime.config.sources.project !== 'not_read_untrusted',
      persistence: runtime.identity.persistence,
    });
    return Object.freeze({
      ...snapshot,
      status: runtime.status === 'healthy' ? snapshot.status : runtime.status,
    });
  }
}

function uninitializedSnapshot(context: ExtensionContext): SessionHealthSnapshot {
  let persistence: 'persistent' | 'ephemeral' = 'ephemeral';
  try {
    persistence =
      context.sessionManager.getSessionFile() === undefined ? 'ephemeral' : 'persistent';
  } catch {
    // Doctor remains available when session metadata is unavailable.
  }
  return Object.freeze({
    status: 'uninitialized',
    compatibility: evaluateHostCompatibility({
      nodeVersion: process.versions.node,
      piVersion: undefined,
    }),
    config: Object.freeze({
      config: DEFAULT_CONFIG,
      sources: Object.freeze({ global: 'absent' as const, project: 'not_read_untrusted' as const }),
      warnings: Object.freeze([]),
    }),
    diagnostics: createDiagnostics().snapshot(),
    mode: context.mode,
    projectTrusted: false,
    persistence,
  });
}
