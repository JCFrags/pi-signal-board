import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import {
  type FixedConfigReader,
  type FixedConfigReadResult,
  loadConfiguration,
} from '../../src/config/loader.js';
import { configDocumentSchema, isConfigDocument } from '../../src/config/schema.js';
import { CONFIG_FILE_NAME, MAX_CONFIG_BYTES } from '../../src/constants.js';

class StubReader implements FixedConfigReader {
  readonly calls: string[] = [];

  constructor(private readonly results: ReadonlyMap<string, FixedConfigReadResult>) {}

  async readUtf8Capped(path: string): Promise<FixedConfigReadResult> {
    this.calls.push(path);
    return this.results.get(path) ?? { kind: 'absent' };
  }
}

const temporaryDirectories: string[] = [];
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function present(value: unknown): FixedConfigReadResult {
  return { kind: 'present', text: JSON.stringify(value) };
}

function paths(cwd: string): { global: string; project: string } {
  return {
    global: join(getAgentDir(), CONFIG_FILE_NAME),
    project: join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
  };
}

function context(cwd: string, trusted: boolean) {
  return { cwd, isProjectTrusted: vi.fn(() => trusted) };
}

describe('configuration schema and defaults', () => {
  it('publishes the normative immutable defaults', () => {
    expect(DEFAULT_CONFIG).toEqual({
      schemaVersion: 1,
      enabled: true,
      widget: {
        enabled: true,
        placement: 'aboveEditor',
        maxItems: 4,
        showCompletedForMinutes: 10,
        hideWhenClear: true,
      },
      status: { enabled: true, hideWhenClear: true },
      notifications: {
        highPriorityQuestion: true,
        questionEscalated: true,
        deliveryFailed: true,
        normalQuestion: false,
        updateCompleted: false,
      },
      questions: {
        defaultDeliveryMode: 'steer',
        defaultBlockingPolicy: 'when_agent_settles',
        recoveryDeliveryOnStart: true,
      },
      limits: {
        maxActiveUpdates: 50,
        maxActionableQuestions: 20,
        visibleHistoryLimit: 500,
        maxUpdateMutationsPerTurn: 12,
        maxQuestionMutationsPerTurn: 5,
        maxAcknowledgementsPerTurn: 20,
      },
      ui: {
        wideLayoutMinimumColumns: 100,
        minimumColumns: 50,
        showRelativeTime: true,
      },
      debug: { enabled: false, showAnswerMessages: false },
    });
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.widget)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.limits)).toBe(true);
  });

  it('keeps the runtime schema strict and partial except for schemaVersion', () => {
    expect(
      (configDocumentSchema as unknown as { readonly additionalProperties?: unknown })
        .additionalProperties,
    ).toBe(false);
    expect(Object.isFrozen(configDocumentSchema)).toBe(true);
    expect(Object.isFrozen(configDocumentSchema.properties.widget)).toBe(true);
    expect(isConfigDocument({ schemaVersion: 1, widget: { maxItems: 8 } })).toBe(true);
    expect(isConfigDocument({ widget: { maxItems: 4 } })).toBe(false);
    expect(isConfigDocument({ schemaVersion: 1, widget: { maxItems: 9 } })).toBe(false);
    expect(isConfigDocument({ schemaVersion: 1, widget: { unknown: true } })).toBe(false);
  });
});

describe('configuration loading', () => {
  it('uses defaults when both optional files are absent', async () => {
    const cwd = '/trusted/project';
    const expectedPaths = paths(cwd);
    const reader = new StubReader(new Map());

    const result = await loadConfiguration(context(cwd, true), reader);

    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.config).not.toBe(DEFAULT_CONFIG);
    expect(result.sources).toEqual({ global: 'absent', project: 'absent' });
    expect(result.warnings).toEqual([]);
    expect(reader.calls).toEqual([expectedPaths.global, expectedPaths.project]);
  });

  it('recursively merges global then trusted-project documents', async () => {
    const cwd = '/trusted/project';
    const expectedPaths = paths(cwd);
    const reader = new StubReader(
      new Map([
        [
          expectedPaths.global,
          present({
            schemaVersion: 1,
            notifications: { normalQuestion: true },
            limits: { visibleHistoryLimit: 1000 },
            widget: { maxItems: 7, hideWhenClear: false },
          }),
        ],
        [
          expectedPaths.project,
          present({
            schemaVersion: 1,
            notifications: { normalQuestion: false },
            widget: { maxItems: 3 },
            questions: { defaultDeliveryMode: 'nextTurn' },
          }),
        ],
      ]),
    );

    const result = await loadConfiguration(context(cwd, true), reader);

    expect(result.sources).toEqual({ global: 'applied', project: 'applied' });
    expect(result.config.notifications.normalQuestion).toBe(false);
    expect(result.config.limits.visibleHistoryLimit).toBe(1000);
    expect(result.config.widget).toMatchObject({ maxItems: 3, hideWhenClear: false });
    expect(result.config.questions.defaultDeliveryMode).toBe('nextTurn');
    expect(result.config.status).toEqual(DEFAULT_CONFIG.status);
  });

  it('checks trust before every project reader operation', async () => {
    const cwd = '/untrusted/project';
    const expectedPaths = paths(cwd);
    const reader = new StubReader(
      new Map([
        [expectedPaths.global, present({ schemaVersion: 1, widget: { maxItems: 2 } })],
        [expectedPaths.project, present({ schemaVersion: 1, enabled: false })],
      ]),
    );
    const loadContext = context(cwd, false);

    const result = await loadConfiguration(loadContext, reader);

    expect(loadContext.isProjectTrusted).toHaveBeenCalledOnce();
    expect(reader.calls).toEqual([expectedPaths.global]);
    expect(result.sources).toEqual({ global: 'applied', project: 'not_read_untrusted' });
    expect(result.config.enabled).toBe(true);
    expect(result.config.widget.maxItems).toBe(2);
  });

  it.each([
    ['malformed JSON', { kind: 'present', text: '{' }, 'malformed_json'],
    [
      'unknown field',
      present({ schemaVersion: 1, backendUrl: 'https://example.test' }),
      'invalid_schema',
    ],
    ['null value', present({ schemaVersion: 1, widget: null }), 'invalid_schema'],
    ['wrong version', present({ schemaVersion: 2 }), 'invalid_schema'],
    ['range failure', present({ schemaVersion: 1, widget: { maxItems: 100 } }), 'invalid_schema'],
    [
      'non-integer',
      present({ schemaVersion: 1, limits: { maxActiveUpdates: 1.5 } }),
      'invalid_schema',
    ],
    ['oversize', { kind: 'too_large' }, 'too_large'],
    ['invalid UTF-8', { kind: 'invalid_encoding' }, 'invalid_encoding'],
  ] as const)('rejects a whole %s document', async (_name, sourceResult, reason) => {
    const cwd = '/project';
    const expectedPaths = paths(cwd);
    const reader = new StubReader(new Map([[expectedPaths.global, sourceResult]]));

    const result = await loadConfiguration(context(cwd, false), reader);

    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.sources.global).toBe('rejected');
    expect(result.warnings).toEqual([{ source: 'global', reason }]);
  });

  it('retains lower-precedence configuration when the project document is rejected', async () => {
    const cwd = '/trusted/project';
    const expectedPaths = paths(cwd);
    const reader = new StubReader(
      new Map([
        [expectedPaths.global, present({ schemaVersion: 1, widget: { maxItems: 2 } })],
        [expectedPaths.project, present({ schemaVersion: 1, widget: { maxItems: 9 } })],
      ]),
    );

    const result = await loadConfiguration(context(cwd, true), reader);

    expect(result.config.widget.maxItems).toBe(2);
    expect(result.sources).toEqual({ global: 'applied', project: 'rejected' });
    expect(result.warnings).toEqual([{ source: 'project', reason: 'invalid_schema' }]);
  });

  it('returns only a fixed safe category for read failures', async () => {
    const cwd = '/project';
    const expectedPaths = paths(cwd);
    const reader = new StubReader(
      new Map([
        [expectedPaths.global, { kind: 'unreadable', safeCategory: 'access_denied' as const }],
      ]),
    );

    const result = await loadConfiguration(context(cwd, false), reader);

    expect(result.warnings).toEqual([
      { source: 'global', reason: 'unreadable', safeCategory: 'access_denied' },
    ]);
    expect(JSON.stringify(result)).not.toContain(expectedPaths.global);
  });

  it('deeply freezes each effective configuration without freezing shared input', async () => {
    const cwd = '/project';
    const expectedPaths = paths(cwd);
    const reader = new StubReader(
      new Map([[expectedPaths.global, present({ schemaVersion: 1, widget: { maxItems: 6 } })]]),
    );

    const result = await loadConfiguration(context(cwd, false), reader);

    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result.config.widget)).toBe(true);
    expect(Object.isFrozen(result.config.notifications)).toBe(true);
    expect(() => {
      (result.config.widget as { maxItems: number }).maxItems = 1;
    }).toThrow(TypeError);
    expect(DEFAULT_CONFIG.widget.maxItems).toBe(4);
  });

  it('reads at most 64 KiB plus one proof byte with the production reader', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'signal-board-config-'));
    temporaryDirectories.push(directory);
    process.env.PI_CODING_AGENT_DIR = directory;
    const configPath = join(directory, CONFIG_FILE_NAME);
    const json = JSON.stringify({ schemaVersion: 1, widget: { maxItems: 5 } });
    const exact = json + ' '.repeat(MAX_CONFIG_BYTES - Buffer.byteLength(json));
    await writeFile(configPath, exact, 'utf8');

    const accepted = await loadConfiguration(context('/untrusted', false));

    expect(Buffer.byteLength(exact)).toBe(MAX_CONFIG_BYTES);
    expect(accepted.sources.global).toBe('applied');
    expect(accepted.config.widget.maxItems).toBe(5);

    await writeFile(configPath, `${exact} `, 'utf8');
    const rejected = await loadConfiguration(context('/untrusted', false));

    expect(rejected.sources.global).toBe('rejected');
    expect(rejected.warnings).toEqual([{ source: 'global', reason: 'too_large' }]);
  });
});
