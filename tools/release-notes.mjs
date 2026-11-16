#!/usr/bin/env node
// Prints the CHANGELOG.md section of a version, for the release notes, and
// checks that the version is the one the packages carry.
// Usage: node tools/release-notes.mjs <version> (a leading "v" is ignored)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wanted = (process.argv[2] ?? '').replace(/^v/, '');
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (wanted === '') fail('usage: node tools/release-notes.mjs <version>');

const source = readFileSync(join(root, 'packages/core/src/version.ts'), 'utf8');
const version = /VERSION = '([^']+)'/.exec(source)?.[1];
if (version !== wanted) fail(`the tag says ${wanted}, but VERSION is ${version}`);

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const sections = changelog.split(/^(?=## \[)/m);
const section = sections.find((s) => s.startsWith(`## [${version}]`));
if (section === undefined) {
  fail(`CHANGELOG.md has no "## [${version}]" section; rename Unreleased before tagging`);
}
// The heading is the release's title; the notes are the rest.
process.stdout.write(`${section.slice(section.indexOf('\n') + 1).trim()}\n`);
