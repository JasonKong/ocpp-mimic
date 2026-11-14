import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog } from '@ocpp-mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunCommand } from './command.js';
import { runCommand } from './run.js';

const EXAMPLES = fileURLToPath(new URL('../../../scenarios/examples/', import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function files(contents: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-cli-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(contents)) await writeFile(join(dir, name), text);
  return dir;
}

function command(paths: string[], extra: Partial<RunCommand> = {}): RunCommand {
  return { kind: 'run', paths, vars: {}, bail: false, personas: [], allowCsms: [], ...extra };
}

async function run(cmd: RunCommand) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(cmd, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

const PASSING = `name: booted
station: { id: CLI-1, persona: generic-1.6 }
steps:
  - expectStation: { registration: Accepted }
`;
const FAILING = `name: never charges
station: { id: CLI-2, persona: generic-1.6 }
steps:
  - expectConnector: { status: Charging, within: 300ms }
`;

describe('ocpp-mimic run', () => {
  it(
    "writes each scenario's frames as a JSONL log with --log-dir",
    { timeout: 30_000 },
    async () => {
      const dir = await files({ 'a.yaml': PASSING });
      const logDir = join(dir, 'logs');
      const { code } = await run(command([join(dir, 'a.yaml')], { logDir }));
      expect(code).toBe(0);
      const log = parseLog(await readFile(join(logDir, 'a.yaml-1.jsonl'), 'utf8'));
      expect(log.problems).toEqual([]);
      expect(log.header).toMatchObject({
        masked: false,
        source: expect.stringMatching(/a\.yaml#1$/),
      });
      expect(log.lines[0]).toMatchObject({ station: 'CLI-1', direction: 'cp-to-csms' });
      expect(log.lines[0]?.frame?.[2]).toBe('BootNotification');
    },
  );

  it(
    'exits 0 when every scenario passes, and prints a line per scenario',
    { timeout: 30_000 },
    async () => {
      const dir = await files({
        'a.yaml': PASSING,
        'b.yaml': `${PASSING}---\n${PASSING.replace('CLI-1', 'CLI-3')}`,
      });
      const { code, out, err } = await run(command([dir]));
      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(out.filter((l) => l.startsWith('PASS'))).toHaveLength(3);
      expect(out.at(-1)).toMatch(/^3 passed \(/);
    },
  );

  it(
    'exits 1 when a scenario fails, with the failing step in the output',
    { timeout: 30_000 },
    async () => {
      const dir = await files({ 'a.yaml': PASSING, 'b.yaml': FAILING });
      const { code, out } = await run(command([dir]));
      expect(code).toBe(1);
      expect(out).toContainEqual(
        expect.stringMatching(/^FAIL {2}never charges \([\d.]+s\) {2}.*b\.yaml#1$/),
      );
      expect(out).toContain('      step 1: expectConnector 1 status=Charging');
      expect(out).toContain('        $.status: expected "Charging", found "Available"');
      expect(out.at(-1)).toMatch(/^1 passed, 1 failed \(/);
    },
  );

  it(
    'stops after the first scenario that does not pass with --bail',
    { timeout: 30_000 },
    async () => {
      const dir = await files({ 'a.yaml': FAILING, 'b.yaml': PASSING });
      const { code, out } = await run(command([dir], { bail: true }));
      expect(code).toBe(1);
      expect(out.filter((l) => /^(PASS|FAIL)/.test(l))).toHaveLength(1);
    },
  );

  it('exits 2 without running anything when a file does not validate', async () => {
    const dir = await files({
      'a.yaml': PASSING,
      'b.yaml': 'name: broken\nstation: { id: X, persona: generic-1.6 }\nsteps:\n  - plugin: {}\n',
      'c.yaml':
        'name: vars\nstation: { id: Y, persona: generic-1.6 }\nsteps:\n  - presentCard: { idTag: "{{TAG}}" }\n',
    });
    const { code, out, err } = await run(command([dir]));
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/b\.yaml#1: \$\.steps\[0\]\.plugin: unknown step/);
    expect(err[1]).toMatch(/c\.yaml#1: \$\.steps\[0\]\.presentCard: unknown variable TAG/);
    expect(err.at(-1)).toBe('2 problems; nothing was run');

    // --var defines the variable.
    const fixed = await run(command([join(dir, 'c.yaml')], { vars: { TAG: 'T' } }));
    expect(fixed.code).toBe(0);
    expect((await run(command([join(dir, 'missing.yaml')]))).code).toBe(2);
  });

  it(
    'writes a JUnit report with --junit, also when files do not validate',
    { timeout: 30_000 },
    async () => {
      const dir = await files({ 'a.yaml': PASSING, 'b.yaml': FAILING });
      const report = join(dir, 'reports', 'junit.xml');
      const { code, out } = await run(command([dir], { junit: report }));
      expect(code).toBe(1);
      expect(out.at(-1)).toBe(`JUnit report written to ${report}`);
      const xml = await readFile(report, 'utf8');
      expect(xml).toContain('tests="2" failures="1" errors="0"');
      expect(xml).toContain('<testcase name="never charges"');
      expect(xml).toContain('<failure message="step 1: expectConnector 1 status=Charging');

      const invalid = await files({ 'c.yaml': 'name: broken\nsteps: []\n' });
      const second = join(invalid, 'junit.xml');
      expect((await run(command([invalid], { junit: second }))).code).toBe(2);
      expect(await readFile(second, 'utf8')).toContain('<testsuite name="validation" tests="2"');
    },
  );

  it('runs the example scenarios from the command line', { timeout: 60_000 }, async () => {
    const { code, out } = await run(
      command([join(EXAMPLES, 'remote-start-stop.yaml'), join(EXAMPLES, 'fault.yaml')]),
    );
    expect(code).toBe(0);
    expect(out.at(-1)).toMatch(/^2 passed/);
  });
});
