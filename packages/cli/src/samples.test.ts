import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeVersionProblem } from './node-version.js';
import { samplesRoot, webRoot } from './paths.js';
import { copySamples, SAMPLE_DIRS } from './samples.js';

describe('samples', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('finds the samples and the Web UI in the monorepo', () => {
    expect(samplesRoot()).toMatch(/scenarios\/$/);
    expect(webRoot()).toMatch(/apps\/web\/dist\/$/);
  });

  it('copies every sample folder and keeps files that are already there', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-samples-'));
    await mkdir(join(dir, 'personas'));
    await writeFile(join(dir, 'personas', 'load-ac-1.6.yaml'), 'mine\n');

    const copied = await copySamples(dir);

    expect(copied).toHaveLength(SAMPLE_DIRS.length);
    expect((await readdir(dir)).sort()).toEqual([...SAMPLE_DIRS].sort());
    expect(await readdir(join(dir, 'examples'))).toContain('local-card-session.yaml');
    expect(await readFile(join(dir, 'personas', 'load-ac-1.6.yaml'), 'utf8')).toBe('mine\n');
    expect(await readdir(join(dir, 'personas'))).toContain('regression-2.1.yaml');
  });
});

describe('Node.js version check', () => {
  it('accepts 24 and later and names the version it needs otherwise', () => {
    expect(nodeVersionProblem('24.0.0')).toBeUndefined();
    expect(nodeVersionProblem('25.2.1')).toBeUndefined();
    expect(nodeVersionProblem('16.20.2')).toMatch(
      /^ocpp-mimic needs Node\.js 24 or later; this is Node\.js 16\.20\.2\./,
    );
  });
});
