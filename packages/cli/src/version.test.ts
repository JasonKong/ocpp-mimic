import { readFileSync } from 'node:fs';
import { VERSION } from '@ocpp-mimic/core';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const MANIFESTS = [
  'package.json',
  'packages/core/package.json',
  'packages/engine/package.json',
  'packages/cli/package.json',
  'apps/web/package.json',
];

describe('version', () => {
  it('is the same in core and in every package manifest', () => {
    for (const manifest of MANIFESTS) {
      const { version } = JSON.parse(readFileSync(new URL(manifest, ROOT), 'utf8')) as {
        version?: string;
      };
      expect(version, manifest).toBe(VERSION);
    }
  });

  it('is a semantic version with an Unreleased or own section in the changelog', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    const changelog = readFileSync(new URL('CHANGELOG.md', ROOT), 'utf8');
    expect(changelog).toMatch(
      new RegExp(`^## \\[(Unreleased|${VERSION.replace(/\./g, '\\.')})\\]`, 'm'),
    );
  });
});
