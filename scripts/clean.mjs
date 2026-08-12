import { rm } from 'node:fs/promises';

const generatedDirectories = ['dist', 'coverage', '.vitest'];
await Promise.all(generatedDirectories.map((path) => rm(path, { recursive: true, force: true })));
