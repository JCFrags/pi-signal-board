import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const requiredFiles = new Set([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'SECURITY.md',
  'dist/index.js',
  'dist/index.d.ts',
]);
const forbiddenPrefixes = [
  'src/',
  'test/',
  'tests/',
  'coverage/',
  '.github/',
  '.pi/',
  'scripts/',
  'docs/',
];
const forbiddenExact = new Set([
  '.npmrc',
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
  'biome.json',
]);

let stdout;
try {
  ({ stdout } = await execFileAsync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--json', '--dry-run', '--ignore-scripts'],
    { maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' },
  ));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`npm pack dry run failed: ${message}`);
}

const parsed = JSON.parse(stdout);
if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.files)) {
  throw new Error('Unexpected npm pack --json response shape.');
}

const files = new Set(parsed[0].files.map((entry) => entry.path));
for (const required of requiredFiles) {
  if (!files.has(required)) {
    throw new Error(`Packed package is missing required file: ${required}`);
  }
}
for (const path of files) {
  if (forbiddenExact.has(path) || forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`Packed package contains forbidden file: ${path}`);
  }
  if (path.endsWith('.map')) {
    throw new Error(`Packed package contains a source map: ${path}`);
  }
}

console.log(`Pack check passed: ${files.size} files, ${parsed[0].size} bytes packed.`);
