import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { DEFAULT_CONFIG } from './config/defaults.js';
import type { ConfigLoadContext, FixedConfigReader } from './config/loader.js';
import { loadConfiguration } from './config/loader.js';
import type { ConfigLoadResult, ConfigWarning } from './config/types.js';
import { COMMAND_NAME } from './constants.js';
import {
  type CorrelationIdGenerator,
  convertUnexpectedError,
  type UnexpectedErrorArea,
  type UnexpectedErrorCategory,
} from './domain/errors.js';
import {
  type CompatibilityResult,
  evaluateCurrentHostCompatibility,
  evaluateHostCompatibility,
} from './integration/compatibility.js';
import {
  createSessionHealthSnapshot,
  formatDoctorReport,
  formatM0Usage,
  type SessionHealthSnapshot,
  type SessionPersistence,
} from './integration/doctor.js';
import { createDiagnostics, type Diagnostics } from './services/diagnostics.js';

export interface SignalBoardExtensionAdapters {
  readonly evaluateCompatibility: () => CompatibilityResult;
  readonly loadConfig: (context: ConfigLoadContext) => Promise<ConfigLoadResult>;
  readonly now: () => Date;
  readonly writePrint: (text: string) => void;
}

const DEFAULT_ADAPTERS: SignalBoardExtensionAdapters = {
  evaluateCompatibility: evaluateCurrentHostCompatibility,
  loadConfig: loadConfiguration,
  now: () => new Date(),
  writePrint: (text) => process.stdout.write(`${text}\n`),
};

const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

class M0CorrelationIds implements CorrelationIdGenerator {
  #next = 0;

  nextCorrelationId(): string {
    this.#next += 1;
    return `sb-m0-${this.#next}`;
  }
}

function safeTimestamp(now: () => Date): string {
  try {
    const value = now().toISOString();
    return Number.isFinite(Date.parse(value)) ? value : FALLBACK_TIMESTAMP;
  } catch {
    return FALLBACK_TIMESTAMP;
  }
}

function recordUnexpected(
  cause: unknown,
  diagnostics: Diagnostics,
  correlationIds: CorrelationIdGenerator,
  at: string,
  area: UnexpectedErrorArea,
  category: UnexpectedErrorCategory,
): void {
  convertUnexpectedError(cause, { diagnostics, correlationIds, at, area, category });
}

function fallbackConfig(projectTrusted: boolean): ConfigLoadResult {
  const warning: ConfigWarning = {
    source: 'global',
    reason: 'unreadable',
    safeCategory: 'io_error',
  };
  return Object.freeze({
    config: DEFAULT_CONFIG,
    sources: Object.freeze({
      global: 'rejected' as const,
      project: projectTrusted ? ('rejected' as const) : ('not_read_untrusted' as const),
    }),
    warnings: Object.freeze([warning]),
  });
}

function fallbackCompatibility(): CompatibilityResult {
  return evaluateHostCompatibility({
    nodeVersion: process.versions.node,
    piVersion: undefined,
  });
}

function safeEmit(
  context: ExtensionContext,
  text: string,
  writePrint: SignalBoardExtensionAdapters['writePrint'],
): void {
  if (context.mode === 'print') {
    try {
      writePrint(text);
    } catch {
      // A failed print stream must not throw from a command boundary.
    }
  }
  try {
    context.ui.notify(text, 'info');
  } catch {
    // A failed UI output surface must not throw from a command boundary.
  }
}

function createUninitializedHealth(context: ExtensionContext): SessionHealthSnapshot {
  let persistence: SessionPersistence = 'ephemeral';
  try {
    persistence =
      context.sessionManager.getSessionFile() === undefined ? 'ephemeral' : 'persistent';
  } catch {
    // Uninitialized doctor output remains available without inspecting the exception.
  }

  return Object.freeze({
    status: 'uninitialized',
    compatibility: fallbackCompatibility(),
    config: Object.freeze({
      config: DEFAULT_CONFIG,
      sources: Object.freeze({ global: 'absent', project: 'not_read_untrusted' }),
      warnings: Object.freeze([]),
    }),
    diagnostics: createDiagnostics().snapshot(),
    mode: context.mode,
    projectTrusted: false,
    persistence,
  });
}

async function initializeHealth(
  context: ExtensionContext,
  adapters: SignalBoardExtensionAdapters,
): Promise<SessionHealthSnapshot> {
  const diagnostics = createDiagnostics();
  const correlationIds = new M0CorrelationIds();
  const at = safeTimestamp(adapters.now);

  let projectTrusted = false;
  try {
    projectTrusted = context.isProjectTrusted();
  } catch (cause) {
    recordUnexpected(cause, diagnostics, correlationIds, at, 'lifecycle', 'runtime_unavailable');
  }

  let compatibility: CompatibilityResult;
  try {
    compatibility = adapters.evaluateCompatibility();
  } catch (cause) {
    recordUnexpected(cause, diagnostics, correlationIds, at, 'compatibility', 'unexpected');
    compatibility = fallbackCompatibility();
  }

  if (!compatibility.supported) {
    diagnostics.record({
      at,
      code: 'SB_UNSUPPORTED_HOST',
      severity: 'error',
      area: 'compatibility',
      category: 'unsupported_version',
    });
  }

  let config: ConfigLoadResult;
  try {
    config = await adapters.loadConfig({
      cwd: context.cwd,
      isProjectTrusted: () => projectTrusted,
    });
  } catch (cause) {
    recordUnexpected(cause, diagnostics, correlationIds, at, 'config', 'io_failure');
    config = fallbackConfig(projectTrusted);
  }

  for (const _warning of config.warnings) {
    diagnostics.record({
      at,
      code: 'SB_CONFIG_INVALID',
      severity: 'warning',
      area: 'config',
      category: 'invalid_data',
    });
  }
  if (!config.config.enabled) {
    diagnostics.record({
      at,
      code: 'SB_CONFIG_DISABLED',
      severity: 'info',
      area: 'config',
      category: 'disabled',
    });
  }

  let persistence: SessionPersistence = 'ephemeral';
  try {
    persistence =
      context.sessionManager.getSessionFile() === undefined ? 'ephemeral' : 'persistent';
  } catch (cause) {
    recordUnexpected(cause, diagnostics, correlationIds, at, 'lifecycle', 'runtime_unavailable');
  }

  return createSessionHealthSnapshot({
    compatibility,
    config,
    diagnostics: diagnostics.snapshot(),
    mode: context.mode,
    projectTrusted,
    persistence,
  });
}

/** Build an extension factory with narrow adapters for deterministic host-path tests. */
export function createSignalBoardExtension(
  overrides: Partial<SignalBoardExtensionAdapters> = {},
): (pi: ExtensionAPI) => void {
  const adapters: SignalBoardExtensionAdapters = { ...DEFAULT_ADAPTERS, ...overrides };

  return (pi: ExtensionAPI): void => {
    let health: SessionHealthSnapshot | undefined;

    pi.registerCommand(COMMAND_NAME, {
      description: 'Show the Pi Signal Board M0 diagnostics shell.',
      handler: async (args, context) => {
        const text =
          args.trim() === 'doctor'
            ? formatDoctorReport(health ?? createUninitializedHealth(context))
            : formatM0Usage();
        safeEmit(context, text, adapters.writePrint);
      },
    });

    pi.on('session_start', async (_event, context) => {
      health = undefined;
      try {
        health = await initializeHealth(context, adapters);
      } catch {
        // initializeHealth owns all expected boundaries. Keep doctor usable if an invariant fails.
        health = createUninitializedHealth(context);
      }
    });

    pi.on('session_shutdown', () => {
      health = undefined;
    });
  };
}

/** Pi extension entry point. M0 registers only one command and lifecycle diagnostics. */
export default function signalBoardExtension(pi: ExtensionAPI): void {
  createSignalBoardExtension()(pi);
}

export type { FixedConfigReader };
