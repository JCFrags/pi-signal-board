import { posix, win32 } from 'node:path';

import {
  type FieldErrorReason,
  fail,
  fieldError,
  type Result,
  signalBoardError,
  succeed,
} from './errors.js';
import { sanitizeText, TEXT_FIELD_POLICIES, type TextPolicy } from './sanitization.js';
import type { Attachment } from './types.js';

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_LINE = 2_147_483_647;

const ATTACHMENT_KINDS = new Set(['file', 'line_range', 'test_run', 'command', 'url', 'note']);
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

/**
 * Validate and normalize inert attachment metadata. This function only performs
 * lexical string processing. It does not inspect paths or access referenced data.
 */
export function normalizeAttachments(input: unknown, cwd: string): Result<readonly Attachment[]> {
  const cwdResult = classifyCwd(cwd);
  if (!cwdResult.ok) {
    return invalid('cwd', 'invalid_value');
  }
  if (!Array.isArray(input)) {
    return invalid('attachments', 'invalid_type');
  }
  if (input.length > MAX_ATTACHMENTS) {
    return fail(signalBoardError('SB_LIMIT_EXCEEDED', [fieldError('attachments', 'too_many')]));
  }

  const normalized: Attachment[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const result = normalizeAttachment(input[index], index, cwdResult.value);
    if (!result.ok) {
      return result;
    }
    normalized.push(result.value);
  }

  return succeed(Object.freeze(normalized));
}

type PathFlavor = 'posix' | 'windows';

interface ClassifiedCwd {
  readonly flavor: PathFlavor;
  readonly absolute: string;
}

function classifyCwd(cwd: string): Result<ClassifiedCwd> {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) {
    return invalid('cwd', 'invalid_value');
  }
  if (WINDOWS_ABSOLUTE.test(cwd)) {
    return succeed({ flavor: 'windows', absolute: win32.resolve(cwd) });
  }
  if (posix.isAbsolute(cwd)) {
    return succeed({ flavor: 'posix', absolute: posix.resolve(cwd.replaceAll('\\', '/')) });
  }
  return invalid('cwd', 'invalid_value');
}

function normalizeAttachment(
  input: unknown,
  index: number,
  cwd: ClassifiedCwd,
): Result<Attachment> {
  const base = `attachments[${index}]`;
  if (!isRecord(input)) {
    return invalid(base, 'invalid_type');
  }
  if (typeof input.kind !== 'string') {
    return invalid(`${base}.kind`, input.kind === undefined ? 'required' : 'invalid_type');
  }
  if (!ATTACHMENT_KINDS.has(input.kind)) {
    return invalid(`${base}.kind`, 'unsupported');
  }

  const label = sanitizedField(
    input,
    'label',
    `${base}.label`,
    TEXT_FIELD_POLICIES.attachmentLabel,
  );
  if (!label.ok) {
    return label;
  }

  switch (input.kind) {
    case 'file':
      return normalizeFile(input, base, label.value, cwd, false);
    case 'line_range':
      return normalizeFile(input, base, label.value, cwd, true);
    case 'test_run':
    case 'command': {
      const keys = exactKeys(input, ['kind', 'label', 'reference'], base);
      if (!keys.ok) return keys;
      const reference = sanitizedField(
        input,
        'reference',
        `${base}.reference`,
        TEXT_FIELD_POLICIES.attachmentReference,
      );
      if (!reference.ok) return reference;
      return succeed(
        Object.freeze({ kind: input.kind, label: label.value, reference: reference.value }),
      );
    }
    case 'url':
      return normalizeUrl(input, base, label.value);
    case 'note': {
      const keys = exactKeys(input, ['kind', 'label', 'text'], base);
      if (!keys.ok) return keys;
      const text = sanitizedField(
        input,
        'text',
        `${base}.text`,
        TEXT_FIELD_POLICIES.attachmentNote,
      );
      if (!text.ok) return text;
      return succeed(Object.freeze({ kind: 'note', label: label.value, text: text.value }));
    }
    default:
      return invalid(`${base}.kind`, 'unsupported');
  }
}

function normalizeFile(
  input: Record<string, unknown>,
  base: string,
  label: string,
  cwd: ClassifiedCwd,
  lineRange: boolean,
): Result<Attachment> {
  const allowed = lineRange
    ? ['kind', 'label', 'path', 'startLine', 'endLine', 'external']
    : ['kind', 'label', 'path', 'external'];
  const keys = exactKeys(input, allowed, base);
  if (!keys.ok) return keys;
  if ('external' in input && typeof input.external !== 'boolean') {
    return invalid(`${base}.external`, 'invalid_type');
  }
  if (typeof input.path !== 'string') {
    return invalid(`${base}.path`, input.path === undefined ? 'required' : 'invalid_type');
  }
  if (input.path.includes('\0')) {
    return invalid(`${base}.path`, 'invalid_value');
  }

  const sanitized = sanitizeText(input.path, TEXT_FIELD_POLICIES.attachmentPath);
  if (!sanitized.ok) {
    return invalid(`${base}.path`, textReason(sanitized.reason));
  }
  const stripped = sanitized.value.startsWith('@') ? sanitized.value.slice(1) : sanitized.value;
  if (stripped.length === 0) {
    return invalid(`${base}.path`, 'required');
  }
  const pathResult = normalizePath(stripped, cwd);
  if (!pathResult.ok) {
    return invalid(`${base}.path`, 'invalid_value');
  }
  const durablePath = sanitizeText(pathResult.value.path, TEXT_FIELD_POLICIES.attachmentPath);
  if (!durablePath.ok) {
    return invalid(`${base}.path`, textReason(durablePath.reason));
  }

  if (!lineRange) {
    return succeed(
      Object.freeze({
        kind: 'file',
        label,
        path: durablePath.value,
        ...(pathResult.value.external ? { external: true as const } : {}),
      }),
    );
  }

  const start = validLine(input.startLine, `${base}.startLine`);
  if (!start.ok) return start;
  const end = validLine(input.endLine, `${base}.endLine`);
  if (!end.ok) return end;
  if (end.value < start.value) {
    return invalid(`${base}.endLine`, 'out_of_range');
  }

  return succeed(
    Object.freeze({
      kind: 'line_range',
      label,
      path: durablePath.value,
      startLine: start.value,
      endLine: end.value,
      ...(pathResult.value.external ? { external: true as const } : {}),
    }),
  );
}

function normalizeUrl(
  input: Record<string, unknown>,
  base: string,
  label: string,
): Result<Attachment> {
  const keys = exactKeys(input, ['kind', 'label', 'url'], base);
  if (!keys.ok) return keys;
  const value = sanitizedField(input, 'url', `${base}.url`, TEXT_FIELD_POLICIES.attachmentUrl);
  if (!value.ok) return value;

  let parsed: URL;
  try {
    parsed = new URL(value.value);
  } catch {
    return invalid(`${base}.url`, 'invalid_value');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalid(`${base}.url`, 'unsupported');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.hostname.length === 0) {
    return invalid(`${base}.url`, 'invalid_value');
  }
  const canonical = sanitizeText(parsed.href, TEXT_FIELD_POLICIES.attachmentUrl);
  if (!canonical.ok) {
    return invalid(`${base}.url`, textReason(canonical.reason));
  }

  return succeed(Object.freeze({ kind: 'url', label, url: canonical.value }));
}

function normalizePath(
  value: string,
  cwd: ClassifiedCwd,
): Result<{ readonly path: string; readonly external: boolean }> {
  if (WINDOWS_DRIVE_PREFIX.test(value) && !WINDOWS_ABSOLUTE.test(value)) {
    return invalid('path', 'invalid_value');
  }

  if (cwd.flavor === 'posix' && WINDOWS_ABSOLUTE.test(value)) {
    return succeed({ path: toPosix(win32.resolve(value)), external: true });
  }

  if (cwd.flavor === 'windows') {
    const resolved = win32.resolve(cwd.absolute, value.replaceAll('/', '\\'));
    const relative = win32.relative(cwd.absolute, resolved);
    const internal = isInternalRelative(relative, 'windows');
    return succeed({
      path: internal ? toPosix(relative || '.') : toPosix(resolved),
      external: !internal,
    });
  }

  const resolved = posix.resolve(cwd.absolute, value.replaceAll('\\', '/'));
  const relative = posix.relative(cwd.absolute, resolved);
  const internal = isInternalRelative(relative, 'posix');
  return succeed({
    path: internal ? relative || '.' : resolved,
    external: !internal,
  });
}

function isInternalRelative(relative: string, flavor: PathFlavor): boolean {
  const api = flavor === 'windows' ? win32 : posix;
  return relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

function validLine(value: unknown, path: string): Result<number> {
  if (typeof value !== 'number') {
    return invalid(path, value === undefined ? 'required' : 'invalid_type');
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_ATTACHMENT_LINE) {
    return invalid(path, 'out_of_range');
  }
  return succeed(value);
}

function sanitizedField(
  input: Record<string, unknown>,
  key: string,
  path: string,
  policy: TextPolicy,
): Result<string> {
  const value = input[key];
  if (typeof value !== 'string') {
    return invalid(path, value === undefined ? 'required' : 'invalid_type');
  }
  const sanitized = sanitizeText(value, policy);
  return sanitized.ok ? succeed(sanitized.value) : invalid(path, textReason(sanitized.reason));
}

function exactKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  base: string,
): Result<true> {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) {
      return invalid(base, 'invalid_value');
    }
  }
  return succeed(true);
}

function textReason(reason: string): FieldErrorReason {
  if (reason === 'empty') return 'required';
  if (reason === 'too_long') return 'too_long';
  return 'invalid_value';
}

function invalid<T>(path: string, reason: FieldErrorReason): Result<T> {
  return fail(signalBoardError('SB_INVALID_ARGUMENT', [fieldError(path, reason)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}
