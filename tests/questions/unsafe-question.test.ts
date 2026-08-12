import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { QuestionClass, QuestionSpec } from '../../src/domain/types.js';
import { guardUnsafeQuestion } from '../../src/questions/unsafe-question.js';

function questionSpec(
  question: string,
  reason = 'A decision is needed.',
  questionClass: QuestionClass = 'preference',
): QuestionSpec {
  return Object.freeze({
    question,
    reason,
    class: questionClass,
    response: Object.freeze({ kind: 'text', options: Object.freeze([]) as readonly [] }),
    recommendedOptionIds: Object.freeze([]),
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'steer',
    affectedWork: Object.freeze([]),
    continuingWork: Object.freeze([]),
    attachments: Object.freeze([]),
  });
}

function expectUnsafe(spec: QuestionSpec): void {
  const result = guardUnsafeQuestion(spec);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toEqual({
    code: 'SB_UNSAFE_QUESTION',
    message: 'This question requires an immediate synchronous user decision and cannot be queued.',
    retryable: false,
  });
  expect(result.error.fieldErrors).toBeUndefined();
  expect(JSON.stringify(result.error)).not.toContain(spec.question);
  expect(JSON.stringify(result.error)).not.toContain(spec.reason);
}

const DANGEROUS_QUESTIONS = [
  'May I delete the old data?',
  'Should I drop the obsolete table?',
  'Can I deploy the build?',
  'Should I publish the package?',
  'May I release version 1.0?',
  'Can I push these commits?',
  'Should I merge the change?',
  'May I purchase another runner?',
  'Can I spend the remaining budget?',
  'Which billing plan should I select?',
  'Should I reveal the secret?',
  'May I copy the API key?',
  'Can I use this token?',
  'Should I rotate the password?',
  'May I change the permission?',
  'Can I grant repository access?',
  'Should I make the account admin?',
  'May I run this as root?',
  'Can I change the production setting?',
  'Should I take this destructive action?',
  'May I make this irreversible change?',
  'Can I destroy the old records?',
  'Should I overwrite the stored file?',
  'May I erase customer records?',
  'Can I wipe the database?',
  'Should I truncate the table?',
  'The next step is deletion. Is that acceptable?',
  'Is deployment now acceptable?',
  'Which publication target should I use?',
  'Is pushing the branch acceptable?',
  'Do you approve merging this?',
  'Is purchasing capacity acceptable?',
  'Does spending this amount work?',
  'Should the administrator receive permissions?',
] as const;

const MISCLASSIFIED_CLASSES = ['preference', 'reversible', 'information'] as const;

describe('unsafe asynchronous-question guard', () => {
  it('rejects authorization unconditionally before content inspection', () => {
    for (const text of [
      'Which local label reads better?',
      'Which API shape should be used?',
      'What documentation section should explain setup?',
      'Choose blue or green.',
    ]) {
      expectUnsafe(questionSpec(text, 'Both choices are harmless.', 'authorization'));
    }
  });

  it('rejects a fixed corpus of more than 100 misclassified high-risk questions', () => {
    let checked = 0;
    for (const questionClass of MISCLASSIFIED_CLASSES) {
      for (const question of DANGEROUS_QUESTIONS) {
        expectUnsafe(questionSpec(question, 'The work is otherwise ready.', questionClass));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('detects high-risk wording split across normalized question and reason text', () => {
    const cases = [
      ['May I deploy this build?', 'The target is production.'],
      ['Should I delete the old entries?', 'They are customer data.'],
      ['May I publish this?', 'It is the next release.'],
      ['Can I push and', 'merge the branch?'],
      ['Should I purchase capacity?', 'It changes billing.'],
      ['May I reveal or use it?', 'The value is a secret token.'],
      ['Should I change this role?', 'It grants admin access.'],
      ['May I proceed?', 'The effect is destructive and irreversible.'],
      ['May I deploy this build?', 'The production target is ready.'],
    ] as const;
    for (const [question, reason] of cases) {
      expectUnsafe(questionSpec(question, reason, 'preference'));
    }
  });

  it('rejects INV-004 after the composed boundary has removed terminal controls', () => {
    expectUnsafe(
      questionSpec('May I deploy this to production?', 'The code is ready.', 'authorization'),
    );
    expectUnsafe(
      questionSpec('May I deploy this build?', 'The production target is ready.', 'preference'),
    );
  });

  it('allows only a narrow reversible local code representation exception', () => {
    const safe = [
      questionSpec(
        'Should the local code representation name the enum value deploy or stage?',
        'This naming-only implementation choice is reversible.',
        'reversible',
      ),
      questionSpec(
        'Which label should the local implementation name release?',
        'The local enum representation change is reversible.',
        'reversible',
      ),
      questionSpec(
        'Should local code name the mock method delete or remove?',
        'This representation choice is reversible.',
        'reversible',
      ),
    ];
    for (const spec of safe) {
      const result = guardUnsafeQuestion(spec);
      expect(result).toEqual({ ok: true, value: spec });
      if (result.ok) expect(result.value).toBe(spec);
    }
  });

  it('rejects active verbs even when a representation binder follows them', () => {
    const cases = [
      ['Should local code delete value?', 'This representation change is reversible.'],
      ['Should local code push state?', 'This representation change is reversible.'],
      ['Should local code release version?', 'This representation change is reversible.'],
      ['Should local code deploy status?', 'This representation change is reversible.'],
    ] as const;
    for (const [question, reason] of cases) {
      expectUnsafe(questionSpec(question, reason, 'reversible'));
    }
  });

  it('does not widen the exception to actual effects or protected categories', () => {
    const cases = [
      ['Should local code represent deployment to production?', 'The code change is reversible.'],
      ['Should local code represent delete for customer data?', 'The naming is reversible.'],
      ['Should local code represent push to the remote repository?', 'The enum is reversible.'],
      ['Should local code represent a secret token?', 'The type change is reversible.'],
      ['Should local code represent admin access?', 'The model is reversible.'],
      ['Should local code represent a purchase?', 'The schema change is reversible.'],
      ['Should local code represent this destructive effect?', 'The type is reversible.'],
      ['Should local code representation deploy?', 'The choice is reversible.'],
      ['Should local code representation delete?', 'The choice is reversible.'],
    ] as const;
    for (const [question, reason] of cases) {
      expectUnsafe(questionSpec(question, reason, 'reversible'));
    }
  });

  it('requires every part of the narrow exception context', () => {
    const cases = [
      questionSpec(
        'Should the enum value deploy be used?',
        'The naming is reversible.',
        'reversible',
      ),
      questionSpec(
        'Should the local value deploy be used?',
        'The naming is reversible.',
        'reversible',
      ),
      questionSpec(
        'Should local code use the value deploy?',
        'The change is reversible.',
        'reversible',
      ),
      questionSpec(
        'Should local code name the value deploy?',
        'This is a local code choice.',
        'reversible',
      ),
      questionSpec(
        'Should local code name the value deploy?',
        'This representation is reversible.',
        'preference',
      ),
    ];
    for (const spec of cases) expectUnsafe(spec);
  });

  it('allows benign baselines and does not match substrings in unrelated words', () => {
    const benign = [
      questionSpec(
        'Which API shape should be used?',
        'Both implementations are local and reversible.',
        'reversible',
      ),
      questionSpec(
        'Which heading should explain setup?',
        'The guide needs clearer wording.',
        'information',
      ),
      questionSpec('Which color label reads better?', 'This is a user preference.', 'preference'),
      questionSpec(
        'Should the dropdown use compact spacing?',
        'The UI choice is reversible.',
        'reversible',
      ),
      questionSpec(
        'Should the pushpin icon be blue?',
        'This is only a visual preference.',
        'preference',
      ),
      questionSpec(
        'Which merger pattern is clearer in the diagram?',
        'This is documentation.',
        'information',
      ),
      questionSpec(
        'Should rooted trees use circles?',
        'This is a local diagram choice.',
        'preference',
      ),
      questionSpec('Which keynote title is clearer?', 'The document needs a title.', 'preference'),
      questionSpec(
        'Should passwordless be one word in the guide?',
        'This edits documentation only.',
        'preference',
      ),
      questionSpec(
        'Should deletable remain an internal type name?',
        'This is ordinary documentation.',
        'information',
      ),
      questionSpec(
        'Should accessibility notes move earlier?',
        'This changes documentation order.',
        'preference',
      ),
      questionSpec(
        'Which administrative note belongs first?',
        'This is documentation.',
        'information',
      ),
      questionSpec(
        'Should tokenization use Unicode words?',
        'This local parser choice is reversible.',
        'reversible',
      ),
      questionSpec('...?', 'Ordinary punctuation-only label review.', 'preference'),
    ];
    for (const spec of benign) {
      const result = guardUnsafeQuestion(spec);
      expect(result.ok, spec.question).toBe(true);
      if (result.ok) expect(result.value).toBe(spec);
    }
  });

  it('is deterministic across 1,000 fixed-seed case and separator variants', () => {
    const seed = 0x5b020;
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const words = [
      'delete',
      'deploy',
      'publish',
      'release',
      'purchase',
      'secret',
      'admin',
      'billing',
    ];
    const separators = [' ', '-', ': ', '\n', ' / '];
    try {
      for (let index = 0; index < 1_000; index += 1) {
        const word = words[next() % words.length];
        const separator = separators[next() % separators.length];
        if (word === undefined || separator === undefined) throw new Error('generated fixture');
        const rendered = next() % 2 === 0 ? word.toUpperCase() : word;
        const spec = questionSpec(`May I${separator}${rendered}?`, `case ${index}`, 'preference');
        const first = guardUnsafeQuestion(spec);
        const second = guardUnsafeQuestion(spec);
        expect(first, `seed=${seed} case=${index}`).toEqual(second);
        expect(first.ok, `seed=${seed} case=${index}`).toBe(false);
      }
    } catch (error) {
      console.error(`unsafe-question property seed=${seed} state=${state}`);
      throw error;
    }
  });

  it('has no append, service, persistence, host, or ambient-I/O dependency', () => {
    const source = readFileSync(
      new URL('../../src/questions/unsafe-question.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"][^'"]*(?:services|persistence|runtime|integration)/u);
    expect(source).not.toMatch(
      /\b(?:append|fetch|process|readFile|writeFile|Date|Math\.random)\b/u,
    );
  });
});
