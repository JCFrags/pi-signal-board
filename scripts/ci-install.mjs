import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'package-lock.json');
const markerPath = join(root, '.lockfile-bootstrap.json');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args) {
  execFileSync(npm, args, { cwd: root, stdio: 'inherit' });
}

if (existsSync(lockPath)) {
  if (existsSync(markerPath)) {
    throw new Error(
      'package-lock.json exists but .lockfile-bootstrap.json was not removed. ' +
        'Delete the bootstrap marker in the same SB-001 commit as the lockfile.',
    );
  }
  run(['ci', '--ignore-scripts']);
  process.exit(0);
}

if (!existsSync(markerPath)) {
  throw new Error(
    'package-lock.json is required. Generate it with ' +
      '`npm install --package-lock-only --ignore-scripts` under Node 22.19.0.',
  );
}

const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
if (marker.schemaVersion !== 1 || typeof marker.allowedFileSha256 !== 'object') {
  throw new Error('Invalid .lockfile-bootstrap.json contract.');
}

for (const [relativePath, expected] of Object.entries(marker.allowedFileSha256)) {
  const bytes = readFileSync(join(root, relativePath));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `Bootstrap install refused because ${relativePath} changed before the lockfile was committed. ` +
        'Restore the scaffold or complete SB-001 locally.',
    );
  }
}

console.warn(
  'BOOTSTRAP ONLY: resolving the untouched reference scaffold to create a temporary CI lockfile. ' +
    'SB-001 must commit package-lock.json and remove .lockfile-bootstrap.json before implementation.',
);
run(['install', '--package-lock-only', '--ignore-scripts']);
run(['ci', '--ignore-scripts']);
