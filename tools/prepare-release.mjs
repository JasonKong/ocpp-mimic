#!/usr/bin/env node
// Prepares a release: sets VERSION, every package manifest and the README's
// image tag to <version>, and turns CHANGELOG.md's Unreleased section into
// "## [<version>] - <date>" with a fresh, empty Unreleased above it.
// Usage: node tools/prepare-release.mjs <version> [--date YYYY-MM-DD]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { date: { type: 'string' } },
});
const version = (positionals[0] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node tools/prepare-release.mjs <version> [--date YYYY-MM-DD]');
  process.exit(2);
}
const date = values.date ?? new Date().toISOString().slice(0, 10);

/** Rewrites a file; already at the new version is fine. */
const edit = (file, change) => {
  const path = join(root, file);
  writeFileSync(path, change(readFileSync(path, 'utf8')));
};

edit('packages/core/src/version.ts', (s) =>
  s.replace(/VERSION = '[^']+'/, `VERSION = '${version}'`),
);
for (const manifest of [
  'package.json',
  'packages/core/package.json',
  'packages/engine/package.json',
  'packages/cli/package.json',
  'apps/web/package.json',
]) {
  edit(manifest, (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
}
// The README's docker run names the release's image.
edit('README.md', (s) =>
  s.replace(
    /ghcr\.io\/jasonkong\/ocpp-mimic:\d+\.\d+\.\d+[0-9A-Za-z.-]*/g,
    `ghcr.io/jasonkong/ocpp-mimic:${version}`,
  ),
);
edit('CHANGELOG.md', (s) => {
  if (!s.includes('\n## [Unreleased]\n')) throw new Error('CHANGELOG.md has no Unreleased section');
  return s.replace('\n## [Unreleased]\n', `\n## [Unreleased]\n\n## [${version}] - ${date}\n`);
});
console.log(`Set ${version} and opened CHANGELOG.md's section for ${date}.`);
console.log(
  'Review, merge, then tag the merge commit on main with v' + version + ' and push the tag.',
);
