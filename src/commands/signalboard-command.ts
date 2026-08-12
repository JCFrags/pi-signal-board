import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { COMMAND_INVOCATION, COMMAND_NAME, PRODUCT_ID } from '../constants.js';
import { selectSummary } from '../domain/selectors.js';
import { formatDoctorReport } from '../integration/doctor.js';
import type { RuntimeLifecycle } from '../integration/lifecycle.js';
import type { SignalBoardRuntime } from '../runtime/types.js';
import { type SignalBoardAction, SignalBoardComponent } from '../ui/board/component.js';
import { type BoardTab, buildBoardViewModel } from '../ui/board/model.js';
import { parseSignalBoardCommand } from './command-parser.js';
import type { ShortcutAvailability } from './shortcut-registration.js';

const COMMAND_PATTERN = /^signalboard(?::[1-9][0-9]*)?$/u;
const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export interface CommandMetadata {
  readonly name: string;
  readonly source?: string;
  readonly sourceInfo?: {
    readonly path?: string;
    readonly source?: string;
  };
}

export interface EffectiveCommandInfo {
  readonly baseName: typeof COMMAND_NAME;
  readonly invocationName: string;
  readonly invocation: string;
  readonly discovered: boolean;
  readonly collision: boolean;
  readonly ambiguous: boolean;
}

export interface SignalBoardCommandDependencies {
  readonly lifecycle: RuntimeLifecycle;
  readonly now: () => Date;
  readonly emit: (context: ExtensionContext, text: string) => void;
  readonly ownEntryPath?: string;
  readonly listCommands?: () => readonly CommandMetadata[];
  readonly shortcutAvailability?: () => ShortcutAvailability;
}

/** Resolve Pi's actual invocation without reading or probing command source paths. */
export function resolveEffectiveCommand(
  commands: readonly CommandMetadata[],
  ownEntryPath?: string,
): EffectiveCommandInfo {
  const candidates = commands.filter(
    (command) => command.source === 'extension' && COMMAND_PATTERN.test(command.name),
  );
  const owned = candidates.filter((command) => metadataIdentifiesPackage(command, ownEntryPath));
  const selected =
    owned.length === 1 ? owned[0] : candidates.length === 1 ? candidates[0] : undefined;
  const ambiguous = selected === undefined;
  const invocationName = selected?.name ?? COMMAND_NAME;
  return Object.freeze({
    baseName: COMMAND_NAME,
    invocationName,
    invocation: `/${invocationName}`,
    discovered: selected !== undefined,
    collision: candidates.length > 1 || invocationName !== COMMAND_NAME,
    ambiguous,
  });
}

/** Register the one static command and return its generation-aware name resolver. */
export function registerSignalBoardCommand(
  pi: Pick<ExtensionAPI, 'registerCommand' | 'getCommands'>,
  dependencies: SignalBoardCommandDependencies,
): (runtime?: SignalBoardRuntime) => EffectiveCommandInfo {
  const ambiguousGenerations = new Set<number>();
  const resolve = (runtime?: SignalBoardRuntime): EffectiveCommandInfo => {
    let commands: readonly CommandMetadata[] = [];
    try {
      commands = dependencies.listCommands?.() ?? (pi.getCommands() as readonly CommandMetadata[]);
    } catch {
      // Command discovery failure uses the documented base invocation.
    }
    const info = resolveEffectiveCommand(commands, dependencies.ownEntryPath);
    if (runtime !== undefined) {
      runtime.effectiveCommand = info;
      if (info.ambiguous && !ambiguousGenerations.has(runtime.generation)) {
        ambiguousGenerations.add(runtime.generation);
        runtime.diagnostics.record({
          at: safeTimestamp(dependencies.now),
          code: 'SB_COMMAND_DISCOVERY_AMBIGUOUS',
          severity: 'warning',
          area: 'lifecycle',
          category: 'command_ambiguous',
        });
      }
    }
    return info;
  };

  pi.registerCommand(COMMAND_NAME, {
    description: 'Open Pi Signal Board or show its summary and diagnostics.',
    handler: async (raw, context) => {
      await handleSignalBoardCommand(raw, context, dependencies, resolve);
    },
  });
  return resolve;
}

export async function handleSignalBoardCommand(
  raw: string,
  context: ExtensionCommandContext,
  dependencies: SignalBoardCommandDependencies,
  resolveCommand: (runtime?: SignalBoardRuntime) => EffectiveCommandInfo,
): Promise<void> {
  const parsed = parseSignalBoardCommand(raw);
  if (parsed.kind === 'open' && parsed.tab === undefined) {
    await handleSignalBoardOpen(context, dependencies, resolveCommand);
    return;
  }

  const runtime = dependencies.lifecycle.slot.current();
  const effective = resolveCommand(runtime);

  if (parsed.kind === 'usage') {
    dependencies.emit(context, formatUsage(effective.invocation));
    return;
  }
  if (parsed.kind === 'doctor') {
    dependencies.emit(
      context,
      formatDoctorReport(
        dependencies.lifecycle.doctorSnapshot(context),
        effective.invocation,
        dependencies.shortcutAvailability?.() ?? 'available',
      ),
    );
    return;
  }

  if (parsed.kind === 'summary' || context.mode !== 'tui' || !hasCustomUi(context)) {
    dependencies.emit(context, await plainSummary(dependencies, effective.invocation));
    return;
  }

  await openBoard(parsed.tab, context, dependencies);
}

/** Open the same no-argument board path used by the command and fixed shortcut. */
export async function handleSignalBoardOpen(
  context: ExtensionContext,
  dependencies: SignalBoardCommandDependencies,
  resolveCommand: (runtime?: SignalBoardRuntime) => EffectiveCommandInfo,
): Promise<void> {
  const runtime = dependencies.lifecycle.slot.current();
  const effective = resolveCommand(runtime);
  if (context.mode !== 'tui' || !hasCustomUi(context)) {
    dependencies.emit(context, await plainSummary(dependencies, effective.invocation));
    return;
  }
  await openBoard(undefined, context, dependencies);
}

async function openBoard(
  requestedTab: BoardTab | undefined,
  context: ExtensionContext,
  dependencies: SignalBoardCommandDependencies,
): Promise<void> {
  let openedAt: string;
  try {
    openedAt = dependencies.now().toISOString();
  } catch {
    dependencies.emit(context, internalFailure());
    return;
  }

  const expiry = await dependencies.lifecycle.evaluateBoardOpen();
  if (!expiry.ok) {
    dependencies.emit(context, runtimeFailure(expiry.error.code));
    return;
  }

  const snapshot = await dependencies.lifecycle.runHealthy((runtime) =>
    buildBoardViewModel(runtime.state, requestedTab, openedAt, runtime.config.config),
  );
  if (!snapshot.ok) {
    dependencies.emit(context, runtimeFailure(snapshot.error.code));
    return;
  }

  let component: SignalBoardComponent | undefined;
  try {
    const action = await context.ui.custom<SignalBoardAction | undefined>(
      (tui, theme, _keybindings, done) => {
        component = new SignalBoardComponent({ tui, theme, model: snapshot.value, done });
        return component;
      },
    );
    if (action !== undefined && action.type !== 'close') {
      dependencies.emit(
        context,
        'Signal Board action is not available in this build (SB_UI_UNAVAILABLE). No state changed.',
      );
    }
  } catch {
    recordUiFailure(dependencies.lifecycle.slot.current(), dependencies.now);
    dependencies.emit(
      context,
      'Signal Board interactive UI failed (SB_UI_UNAVAILABLE). No state changed.',
    );
  } finally {
    component?.dispose();
    component = undefined;
  }
}

async function plainSummary(
  dependencies: SignalBoardCommandDependencies,
  effectiveCommand: string,
): Promise<string> {
  let openedAt: string;
  try {
    openedAt = dependencies.now().toISOString();
  } catch {
    return internalFailure();
  }
  const result = await dependencies.lifecycle.runHealthy((runtime) =>
    formatPlainSummary(runtime, openedAt, effectiveCommand),
  );
  return result.ok ? result.value : runtimeFailure(result.error.code);
}

export function formatPlainSummary(
  runtime: Pick<SignalBoardRuntime, 'state'>,
  openedAt: string,
  _effectiveCommand = COMMAND_INVOCATION,
): string {
  const summary = selectSummary(runtime.state, 10, openedAt);
  const questions = summary.items.filter((entry) => entry.entityType === 'question');
  const updates = summary.items.filter((entry) => entry.entityType === 'update');
  const lines = [
    `Signal: ${countLabel(summary.counts.actionableQuestions, 'actionable question')}, ${countLabel(summary.counts.activeUpdates, 'active update')}, ${countLabel(summary.counts.unread, 'unread change')}.`,
    'Questions:',
    ...(questions.length === 0
      ? ['- none']
      : questions.map(
          (entry) =>
            `- [${questionLabel(entry.item.status)}] ${entry.item.displayId} ${oneLine(entry.item.question)}`,
        )),
    'Updates:',
    ...(updates.length === 0
      ? ['- none']
      : updates.map(
          (entry) =>
            `- [${updateLabel(entry.item.kind)}] ${entry.item.displayId} ${oneLine(entry.item.title)}`,
        )),
  ];
  if (summary.omittedItems > 0) lines.push(`… and ${summary.omittedItems} more`);
  return lines.join('\n');
}

export function formatUsage(invocation = COMMAND_INVOCATION): string {
  return [
    `Usage: ${invocation} [inbox|updates|decisions|history|summary|doctor]`,
    'Subcommands are case-sensitive. Extra arguments are not accepted.',
  ].join('\n');
}

function metadataIdentifiesPackage(command: CommandMetadata, ownEntryPath?: string): boolean {
  if (command.sourceInfo?.source === PRODUCT_ID) return true;
  if (ownEntryPath === undefined || command.sourceInfo?.path === undefined) return false;
  return normalizeMetadataPath(command.sourceInfo.path) === normalizeMetadataPath(ownEntryPath);
}

function normalizeMetadataPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+/gu, '/').replace(/\/$/u, '');
}

function hasCustomUi(context: ExtensionContext): boolean {
  try {
    return typeof context.ui.custom === 'function';
  } catch {
    return false;
  }
}

function recordUiFailure(runtime: SignalBoardRuntime | undefined, now: () => Date): void {
  runtime?.diagnostics.record({
    at: safeTimestamp(now),
    code: 'SB_UI_UNAVAILABLE',
    severity: 'warning',
    area: 'ui',
    category: 'ui_failure',
  });
}

function safeTimestamp(now: () => Date): string {
  try {
    return now().toISOString();
  } catch {
    return FALLBACK_TIMESTAMP;
  }
}

function runtimeFailure(code: string): string {
  return `Signal Board runtime unavailable (${code}). No state changed.`;
}

function internalFailure(): string {
  return 'Signal Board command failed safely (SB_INTERNAL). No state changed.';
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function questionLabel(status: string): string {
  return status.replaceAll('_', ' ').toUpperCase();
}

function updateLabel(kind: string): string {
  return kind === 'finding' ? 'FOUND' : kind === 'completed' ? 'DONE' : kind.toUpperCase();
}
