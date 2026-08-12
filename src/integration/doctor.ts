import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { ConfigLoadResult, ConfigWarning } from '../config/types.js';
import {
  COMMAND_INVOCATION,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  SHORTCUT_DISPLAY,
  SUPPORTED_NODE_RANGE,
  SUPPORTED_PI_RANGE,
} from '../constants.js';
import type { DiagnosticsSnapshot } from '../services/diagnostics.js';
import type { CompatibilityFact, CompatibilityResult } from './compatibility.js';

export type DoctorStatus = 'healthy' | 'degraded' | 'disabled' | 'unsupported' | 'uninitialized';
export type DoctorMode = ExtensionContext['mode'];
export type SessionPersistence = 'persistent' | 'ephemeral';

/** Content-free M0 health retained for the current Pi session only. */
export interface SessionHealthSnapshot {
  readonly status: DoctorStatus;
  readonly compatibility: CompatibilityResult;
  readonly config: ConfigLoadResult;
  readonly diagnostics: DiagnosticsSnapshot;
  readonly mode: DoctorMode;
  readonly projectTrusted: boolean;
  readonly persistence: SessionPersistence;
}

export interface SessionHealthInput extends Omit<SessionHealthSnapshot, 'status'> {}

export function createSessionHealthSnapshot(input: SessionHealthInput): SessionHealthSnapshot {
  const status: DoctorStatus = !input.compatibility.supported
    ? 'unsupported'
    : !input.config.config.enabled
      ? 'disabled'
      : input.diagnostics.totalRecorded > 0 || input.config.warnings.length > 0
        ? 'degraded'
        : 'healthy';

  return Object.freeze({ ...input, status });
}

const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function formatCompatibility(fact: CompatibilityFact): string {
  const detected =
    fact.detectedVersion === undefined
      ? 'unresolved'
      : SAFE_VERSION.test(fact.detectedVersion)
        ? fact.detectedVersion
        : 'invalid';
  return `${detected} (${fact.status})`;
}

function formatWarning(warning: ConfigWarning): string {
  const category = warning.safeCategory === undefined ? '' : `:${warning.safeCategory}`;
  return `${warning.source}:${warning.reason}${category}`;
}

function formatDiagnosticCounts(snapshot: DiagnosticsSnapshot): string {
  const counts = Object.entries(snapshot.counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => `${code}=${count}`);
  return counts.length === 0 ? 'none' : counts.join(', ');
}

/** Format diagnostics without board content, paths, exceptions, or stack data. */
export function formatDoctorReport(health: SessionHealthSnapshot): string {
  const warningCategories = health.config.warnings.map(formatWarning);
  const diagnostics = health.diagnostics;

  return [
    'PI SIGNAL BOARD DOCTOR',
    '',
    `Status: ${health.status}`,
    `Extension: ${PRODUCT_NAME} ${PRODUCT_VERSION}`,
    `Supported Node range: ${SUPPORTED_NODE_RANGE}`,
    `Supported Pi range: ${SUPPORTED_PI_RANGE}`,
    `Node: ${formatCompatibility(health.compatibility.node)}`,
    `Pi host: ${formatCompatibility(health.compatibility.pi)}`,
    `Mode: ${health.mode}`,
    `Project trust: ${health.projectTrusted ? 'trusted' : 'untrusted'}`,
    `Config sources: defaults=applied; global=${health.config.sources.global}; project=${health.config.sources.project}`,
    `Config warnings: ${health.config.warnings.length}`,
    `Config warning categories: ${warningCategories.length === 0 ? 'none' : warningCategories.join(', ')}`,
    `Effective config: ${health.config.config.enabled ? 'enabled' : 'disabled'}`,
    `Session: ${health.persistence}`,
    `Board runtime: ${health.status}; lifecycle generation is content-free`,
    'Board counts: active=0; updates=0; questions=0; decisions=0; unread=0',
    `Replay counts: accepted=${diagnostics.replay.accepted}; skipped=${diagnostics.replay.skipped}`,
    `Delivery failures: ${diagnostics.deliveryFailureCount}`,
    `Diagnostics: total=${diagnostics.totalRecorded}; retained=${diagnostics.retained}`,
    `Diagnostic codes: ${formatDiagnosticCounts(diagnostics)}`,
    `Command: ${COMMAND_INVOCATION}`,
    `Shortcut name: ${SHORTCUT_DISPLAY}`,
    '',
    'No paths, board content, exception text, or stack traces are included.',
  ].join('\n');
}

export function formatM0Usage(): string {
  return [
    'Pi Signal Board M0 diagnostic shell. Board actions are not available and no state changed.',
    `Usage: ${COMMAND_INVOCATION} doctor`,
  ].join('\n');
}
