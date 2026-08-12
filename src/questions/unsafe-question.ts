import { fail, type Result, signalBoardError, succeed } from '../domain/errors.js';
import type { QuestionSpec } from '../domain/types.js';

const HIGH_RISK_WORDS = new Set([
  'delete',
  'deletes',
  'deleted',
  'deleting',
  'deletion',
  'drop',
  'drops',
  'dropped',
  'dropping',
  'deploy',
  'deploys',
  'deployed',
  'deploying',
  'deployment',
  'deployments',
  'publish',
  'publishes',
  'published',
  'publishing',
  'publication',
  'release',
  'releases',
  'released',
  'releasing',
  'push',
  'pushes',
  'pushed',
  'pushing',
  'merge',
  'merges',
  'merged',
  'merging',
  'purchase',
  'purchases',
  'purchased',
  'purchasing',
  'spend',
  'spends',
  'spent',
  'spending',
  'secret',
  'secrets',
  'key',
  'keys',
  'token',
  'tokens',
  'password',
  'passwords',
  'permission',
  'permissions',
  'access',
  'admin',
  'administrator',
  'root',
  'production',
  'billing',
  'destructive',
  'irreversible',
  'destroy',
  'destroys',
  'destroyed',
  'destroying',
  'overwrite',
  'overwrites',
  'overwritten',
  'overwriting',
  'erase',
  'erases',
  'erased',
  'erasing',
  'wipe',
  'wipes',
  'wiped',
  'wiping',
  'truncate',
  'truncates',
  'truncated',
  'truncating',
]);

const LOCAL_CONTEXT = new Set(['local', 'locally']);
const CODE_CONTEXT = new Set([
  'code',
  'implementation',
  'source',
  'type',
  'interface',
  'function',
  'method',
  'variable',
  'enum',
  'schema',
  'model',
]);
const REPRESENTATION_CONTEXT = new Set([
  'representation',
  'represent',
  'represents',
  'represented',
  'representing',
  'name',
  'named',
  'naming',
  'label',
  'labeled',
  'shape',
  'mock',
  'stub',
  'string',
  'enum',
]);
const REVERSIBLE_CONTEXT = new Set(['reversible', 'undoable']);
const REPRESENTATION_BINDERS = new Set([
  'value',
  'label',
  'name',
  'method',
  'state',
  'status',
  'string',
  'enum',
  'field',
  'type',
  'variant',
  'identifier',
  'word',
  'term',
]);

// These categories can never be made safe by describing them as local code.
const NON_EXCEPTION_RISK = new Set([
  'purchase',
  'purchases',
  'purchased',
  'purchasing',
  'spend',
  'spends',
  'spent',
  'spending',
  'secret',
  'secrets',
  'key',
  'keys',
  'token',
  'tokens',
  'password',
  'passwords',
  'permission',
  'permissions',
  'access',
  'admin',
  'administrator',
  'root',
  'production',
  'billing',
  'destructive',
  'irreversible',
  'destroy',
  'destroys',
  'destroyed',
  'destroying',
  'overwrite',
  'overwrites',
  'overwritten',
  'overwriting',
  'erase',
  'erases',
  'erased',
  'erasing',
  'wipe',
  'wipes',
  'wiped',
  'wiping',
  'truncate',
  'truncates',
  'truncated',
  'truncating',
]);

const EXTERNAL_OR_EFFECT_CONTEXT = new Set([
  'actual',
  'actually',
  'apply',
  'execute',
  'perform',
  'proceed',
  'remote',
  'external',
  'server',
  'service',
  'cloud',
  'github',
  'gitlab',
  'npm',
  'registry',
  'repository',
  'branch',
  'database',
  'data',
  'record',
  'records',
  'table',
  'tables',
  'file',
  'files',
  'resource',
  'resources',
  'account',
  'accounts',
  'customer',
  'customers',
  'user',
  'users',
  'environment',
  'app',
  'application',
]);

/**
 * Reject an unsafe asynchronous question after complete semantic normalization.
 * The successful result contains the exact input object.
 */
export function guardUnsafeQuestion(spec: QuestionSpec): Result<QuestionSpec> {
  if (spec.class === 'authorization') return unsafe();

  const questionTokens = tokenize(spec.question);
  const reasonTokens = tokenize(spec.reason);
  const tokens = [...questionTokens, ...reasonTokens];
  if (!tokens.some((token) => HIGH_RISK_WORDS.has(token))) return succeed(spec);
  if (isLocalCodeRepresentationException(spec, tokens, questionTokens, reasonTokens)) {
    return succeed(spec);
  }
  return unsafe();
}

function isLocalCodeRepresentationException(
  spec: QuestionSpec,
  tokens: readonly string[],
  questionTokens: readonly string[],
  reasonTokens: readonly string[],
): boolean {
  if (spec.class !== 'reversible') return false;
  if (!hasAny(tokens, LOCAL_CONTEXT)) return false;
  if (!hasAny(tokens, CODE_CONTEXT)) return false;
  if (!hasAny(tokens, REPRESENTATION_CONTEXT)) return false;
  if (!hasAny(tokens, REVERSIBLE_CONTEXT)) return false;
  if (hasAny(tokens, NON_EXCEPTION_RISK)) return false;
  if (hasAny(tokens, EXTERNAL_OR_EFFECT_CONTEXT)) return false;
  return (
    highRiskTermsAreNamedRepresentations(questionTokens) &&
    highRiskTermsAreNamedRepresentations(reasonTokens)
  );
}

function highRiskTermsAreNamedRepresentations(tokens: readonly string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!HIGH_RISK_WORDS.has(tokens[index] ?? '')) continue;
    const previous = tokens[index - 1];
    if (previous === undefined || !REPRESENTATION_BINDERS.has(previous)) return false;
  }
  return true;
}

function tokenize(value: string): readonly string[] {
  return (
    value
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  );
}

function hasAny(tokens: readonly string[], words: ReadonlySet<string>): boolean {
  return tokens.some((token) => words.has(token));
}

function unsafe<T>(): Result<T> {
  return fail(signalBoardError('SB_UNSAFE_QUESTION'));
}
