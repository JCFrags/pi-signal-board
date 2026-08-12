import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_ATTACHMENT_LINE,
  MAX_ATTACHMENTS,
  normalizeAttachments,
} from '../../src/domain/attachments.js';

function resultValue(result: ReturnType<typeof normalizeAttachments>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Synthetic attachment fixture failed.');
  return result.value;
}

function fieldFailure(
  result: ReturnType<typeof normalizeAttachments>,
  path: string,
  message: string,
  code = 'SB_INVALID_ARGUMENT',
): void {
  expect(result).toMatchObject({
    ok: false,
    error: { code, fieldErrors: [{ path, message }] },
  });
}

describe('attachment normalization', () => {
  it('FR-140 normalizes every inert attachment kind and sanitizes its text', () => {
    const result = normalizeAttachments(
      [
        { kind: 'file', label: '\u001b[31m Source \u001b[0m', path: '@./src/../src/main.ts' },
        {
          kind: 'line_range',
          label: ' Range ',
          path: 'src/main.ts',
          startLine: 1,
          endLine: 12,
        },
        { kind: 'test_run', label: ' Test ', reference: ' suite\u0000result ' },
        { kind: 'command', label: ' Command ', reference: ' npm   test ' },
        { kind: 'url', label: ' Link ', url: 'https://example.test/a path?q=one two' },
        { kind: 'note', label: ' Note ', text: ' first\r\n\tsecond ' },
      ],
      '/work/project',
    );

    expect(resultValue(result)).toEqual([
      { kind: 'file', label: 'Source', path: 'src/main.ts' },
      {
        kind: 'line_range',
        label: 'Range',
        path: 'src/main.ts',
        startLine: 1,
        endLine: 12,
      },
      { kind: 'test_run', label: 'Test', reference: 'suiteresult' },
      { kind: 'command', label: 'Command', reference: 'npm test' },
      {
        kind: 'url',
        label: 'Link',
        url: 'https://example.test/a%20path?q=one%20two',
      },
      { kind: 'note', label: 'Note', text: 'first\n\tsecond' },
    ]);
  });

  it('FR-140 strips exactly one leading at sign and classifies POSIX paths lexically', () => {
    const attachments = resultValue(
      normalizeAttachments(
        [
          { kind: 'file', label: 'one', path: '@@scope/file.ts' },
          { kind: 'file', label: 'two', path: '../outside.txt', external: false },
          { kind: 'file', label: 'three', path: '/work/projected/not-inside.txt' },
          { kind: 'file', label: 'root', path: '.' },
        ],
        '/work/project',
      ),
    );

    expect(attachments).toEqual([
      { kind: 'file', label: 'one', path: '@scope/file.ts' },
      { kind: 'file', label: 'two', path: '/work/outside.txt', external: true },
      {
        kind: 'file',
        label: 'three',
        path: '/work/projected/not-inside.txt',
        external: true,
      },
      { kind: 'file', label: 'root', path: '.' },
    ]);
  });

  it('FR-140 handles Windows paths portably and stores POSIX separators', () => {
    expect(
      resultValue(
        normalizeAttachments(
          [
            { kind: 'file', label: 'inside', path: '@src\\feature\\..\\main.ts' },
            { kind: 'file', label: 'outside', path: '..\\outside.txt' },
            { kind: 'file', label: 'drive', path: 'D:\\logs\\result.txt' },
          ],
          'C:\\work\\project',
        ),
      ),
    ).toEqual([
      { kind: 'file', label: 'inside', path: 'src/main.ts' },
      { kind: 'file', label: 'outside', path: 'C:/work/outside.txt', external: true },
      { kind: 'file', label: 'drive', path: 'D:/logs/result.txt', external: true },
    ]);

    expect(
      resultValue(
        normalizeAttachments(
          [{ kind: 'file', label: 'Windows external', path: 'C:\\temp\\a.txt' }],
          '/work/project',
        ),
      ),
    ).toEqual([{ kind: 'file', label: 'Windows external', path: 'C:/temp/a.txt', external: true }]);
  });

  it('FR-140 rejects empty, NUL, ambiguous drive-relative, and oversized paths', () => {
    fieldFailure(
      normalizeAttachments([{ kind: 'file', label: 'x', path: '@' }], '/work/project'),
      'attachments[0].path',
      'This field is required.',
    );
    fieldFailure(
      normalizeAttachments([{ kind: 'file', label: 'x', path: 'private\0value' }], '/work/project'),
      'attachments[0].path',
      'This field has an invalid value.',
    );
    fieldFailure(
      normalizeAttachments([{ kind: 'file', label: 'x', path: 'C:relative.txt' }], '/work/project'),
      'attachments[0].path',
      'This field has an invalid value.',
    );
    fieldFailure(
      normalizeAttachments(
        [{ kind: 'file', label: 'x', path: `/${'x'.repeat(1_000)}` }],
        '/work/project',
      ),
      'attachments[0].path',
      'This field is too long.',
    );
  });

  it('FR-140 enforces one-based bounded integer line ranges', () => {
    const attachment = (startLine: unknown, endLine: unknown) => ({
      kind: 'line_range',
      label: 'range',
      path: 'file.ts',
      startLine,
      endLine,
    });

    for (const [start, end, field] of [
      [0, 1, 'startLine'],
      [1.5, 2, 'startLine'],
      [1, 0, 'endLine'],
      [1, MAX_ATTACHMENT_LINE + 1, 'endLine'],
      [5, 4, 'endLine'],
    ] as const) {
      fieldFailure(
        normalizeAttachments([attachment(start, end)], '/work/project'),
        `attachments[0].${field}`,
        'This field is outside the allowed range.',
      );
    }

    expect(
      resultValue(normalizeAttachments([attachment(1, MAX_ATTACHMENT_LINE)], '/work/project'))[0],
    ).toMatchObject({ startLine: 1, endLine: MAX_ATTACHMENT_LINE });
  });

  it('FR-140 accepts HTTP(S) URLs and rejects credentials, malformed input, and protocols', () => {
    expect(
      resultValue(
        normalizeAttachments(
          [
            { kind: 'url', label: 'http', url: 'http://example.test' },
            { kind: 'url', label: 'https', url: 'https://example.test/path' },
          ],
          '/work/project',
        ),
      ),
    ).toEqual([
      { kind: 'url', label: 'http', url: 'http://example.test/' },
      { kind: 'url', label: 'https', url: 'https://example.test/path' },
    ]);

    for (const [url, message] of [
      ['https://user:secret@example.test/path', 'This field has an invalid value.'],
      ['not a URL', 'This field has an invalid value.'],
      ['file:///private/path', 'This field uses an unsupported value.'],
      ['javascript:alert(1)', 'This field uses an unsupported value.'],
    ] as const) {
      fieldFailure(
        normalizeAttachments([{ kind: 'url', label: 'link', url }], '/work/project'),
        'attachments[0].url',
        message,
      );
    }
  });

  it('FR-140 validates collection limits, kinds, required fields, types, and exact shapes', () => {
    fieldFailure(
      normalizeAttachments('not-an-array', '/work/project'),
      'attachments',
      'This field has the wrong type.',
    );
    fieldFailure(
      normalizeAttachments(
        Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({
          kind: 'note',
          label: 'note',
          text: 'text',
        })),
        '/work/project',
      ),
      'attachments',
      'This field contains too many values.',
      'SB_LIMIT_EXCEEDED',
    );
    fieldFailure(
      normalizeAttachments([{ kind: 'image', label: 'x' }], '/work/project'),
      'attachments[0].kind',
      'This field uses an unsupported value.',
    );
    fieldFailure(
      normalizeAttachments([{ kind: 'note', text: 'text' }], '/work/project'),
      'attachments[0].label',
      'This field is required.',
    );
    fieldFailure(
      normalizeAttachments([{ kind: 'note', label: 'x', text: 1 }], '/work/project'),
      'attachments[0].text',
      'This field has the wrong type.',
    );
    fieldFailure(
      normalizeAttachments(
        [{ kind: 'note', label: 'x', text: 'text', unexpected: 'private' }],
        '/work/project',
      ),
      'attachments[0]',
      'This field has an invalid value.',
    );
    fieldFailure(
      normalizeAttachments(
        [{ kind: 'file', label: 'x', path: 'x', external: 'yes' }],
        '/work/project',
      ),
      'attachments[0].external',
      'This field has the wrong type.',
    );
  });

  it('FR-140 enforces sanitized Unicode code-point limits', () => {
    const validLabel = `\u001b[31m${'😀'.repeat(160)}\u001b[0m`;
    expect(
      resultValue(
        normalizeAttachments([{ kind: 'note', label: validLabel, text: 'text' }], '/cwd'),
      )[0],
    ).toMatchObject({ label: '😀'.repeat(160) });

    fieldFailure(
      normalizeAttachments(
        [{ kind: 'test_run', label: 'x', reference: '😀'.repeat(1_001) }],
        '/cwd',
      ),
      'attachments[0].reference',
      'This field is too long.',
    );
  });

  it('MT-019 performs no filesystem, process, or network action and returns frozen metadata', () => {
    const require = createRequire(import.meta.url);
    const fsHooks = require('node:fs') as typeof import('node:fs');
    const processHooks = require('node:child_process') as typeof import('node:child_process');
    const stat = vi.spyOn(fsHooks, 'statSync');
    const read = vi.spyOn(fsHooks, 'readFileSync');
    const spawn = vi.spyOn(processHooks, 'spawn');
    const fetch = vi.spyOn(globalThis, 'fetch');

    const result = normalizeAttachments(
      [
        { kind: 'file', label: 'file', path: '/private/does-not-exist' },
        { kind: 'command', label: 'command', reference: 'rm -rf /' },
        { kind: 'url', label: 'url', url: 'https://example.test/private' },
      ],
      '/work/project',
    );

    expect(result.ok).toBe(true);
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(result.value.every(Object.isFrozen)).toBe(true);
    }
  });

  it('NFR-040 returns stable content-free errors without rejected data or stack details', () => {
    const secret = '/home/alice/SECRET-private\0file';
    const result = normalizeAttachments([{ kind: 'file', label: 'private', path: secret }], '/cwd');

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|alice|private.file|stack/iu);
  });
});
