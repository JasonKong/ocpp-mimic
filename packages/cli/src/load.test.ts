import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadCommand } from './command.js';
import { runLoadCommand } from './load.js';

const PERSONAS = fileURLToPath(new URL('../../../scenarios/personas/', import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ocpp-mimic-load-'));
  dirs.push(path);
  return path;
}

const PLAN = `name: Tiny load
csms: builtin
seed: 2
duration: 6s
rampUp: { rate: 20, jitter: 0 }
groups:
  - name: fast
    count: 4
    id: TINY-{1}
    persona: load-ac-1.6
    usage:
      sessionsPerHour: 1800
      stay: { min: 1s, max: 2s }
      steps: { min: 100ms, max: 200ms }
      idTags: { unknownShare: 0 }
events:
  - at: 2s
    reconnectStorm: {}
    stations: { count: 2 }
thresholds:
  bootAcceptedWithin: 5s
  recoverWithin: 3s
  unexpectedDisconnects: 0
  timeouts: 0
  callErrors: 0
  schemaViolations: 0
  memory: { rss: 4GB }
`;

async function run(plan: string, extra: Partial<LoadCommand> = {}) {
  const work = await dir();
  await writeFile(join(work, 'plan.yaml'), plan);
  const out: string[] = [];
  const err: string[] = [];
  const command: LoadCommand = {
    kind: 'load',
    plan: join(work, 'plan.yaml'),
    personas: [PERSONAS],
    allowCsms: [],
    reportDir: join(work, 'report'),
    junit: join(work, 'report', 'load.xml'),
    ...extra,
  };
  const code = await runLoadCommand(command, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, work };
}

describe('ocpp-mimic load', () => {
  it(
    'runs a plan against the built-in CSMS and passes its thresholds',
    { timeout: 30_000 },
    async () => {
      const { code, out, err, work } = await run(PLAN);
      expect(err).toEqual([]);
      expect(code, out.join('\n')).toBe(0);
      expect(out[0]).toMatch(/^ocpp-mimic load: Tiny load: 4 stations against ws:\/\//);
      expect(out).toContainEqual(expect.stringMatching(/^PASSED: Tiny load \(4 stations/));
      const report = JSON.parse(await readFile(join(work, 'report', 'report.json'), 'utf8'));
      expect(report.events).toEqual([
        expect.objectContaining({ kind: 'reconnectStorm', stations: 2 }),
      ]);
      expect(report.events[0].recoveredS).toBeLessThan(3);
      expect(report.groups[0].sessions).toBeGreaterThan(0);
      expect(report.metrics.transactions.started).toBeGreaterThan(0);
      expect(await readFile(join(work, 'report', 'report.md'), 'utf8')).toMatch(
        /^# Tiny load: passed/,
      );
      const junit = await readFile(join(work, 'report', 'load.xml'), 'utf8');
      expect(junit).toContain('<testcase name="bootAcceptedWithin"');
      expect(junit).not.toContain('<failure');
    },
  );

  it('fails with exit code 1 when a threshold is not met', { timeout: 30_000 }, async () => {
    const plan = PLAN.replace(
      '  timeouts: 0',
      '  timeouts: 0\n  csmsLatency: { p95: 0ms }',
    ).replace('duration: 6s', 'duration: 3s');
    const { code, out } = await run(plan.replace(/events:[\s\S]*?thresholds:/, 'thresholds:'));
    expect(code).toBe(1);
    expect(out).toContainEqual(expect.stringMatching(/^ {2}FAIL {2}csmsLatency p95/));
  });

  it('exits 2 with the problems of a plan that does not validate', async () => {
    const { code, err } = await run('name: x\ncsms: http://nope\nduration: 1m\ngroups: []\n');
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/\$\.groups/);
  });
});
