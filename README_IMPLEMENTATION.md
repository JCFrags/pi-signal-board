# Implementation Start

This directory is a reference scaffold, not the completed product. Perform these steps in order after copying every file, including dotfiles, into the implementation repository.

1. Select Node.js 22.19.0 or a compatible newer 22.x release and confirm `node --version`.
2. Do not edit `package.json`, `src/index.ts`, or `tests/scaffold.test.ts` before creating the lockfile. The temporary CI bootstrap verifies their SHA-256 values and refuses altered scaffold content.
3. Run `npm install --package-lock-only --ignore-scripts` against the public npm registry to create `package-lock.json` from the exact versions in `package.json`.
4. Delete `.lockfile-bootstrap.json`. Commit the new `package-lock.json` and marker deletion in the same SB-001 change. Never regenerate the lockfile in CI or during release.
5. Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run test:coverage`, `npm run build`, and `npm run pack:check`.
6. Replace the no-op entry point and scaffold test according to `../docs/09-implementation-blueprint.md`, implementing backlog items in `../backlog/implementation-sequence.yaml` order.

`./scripts/ci-install.mjs` has one narrow purpose: allow CI to validate the untouched reference scaffold before SB-001 exists. With a committed lockfile it runs `npm ci`; without a lockfile it works only while the bootstrap marker exists and all guarded files exactly match the sealed scaffold. The release workflow never uses this fallback and fails unless the lockfile exists and the marker is absent.
