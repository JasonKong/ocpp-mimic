import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReplayCommand, RunCommand } from './command.js';
import { runReplayCommand } from './replay.js';
import { runCommand } from './run.js';

const SAMPLE = fileURLToPath(
  new URL('../../../scenarios/logs/local-card-session.yaml-1.jsonl', import.meta.url),
);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function replay(extra: Partial<ReplayCommand> & { log: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReplayCommand(
    { kind: 'replay', personas: [], allowCsms: [], speed: 20, ...extra },
    { out: (l) => out.push(l), err: (l) => err.push(l) },
  );
  return { code, out, err };
}

describe('ocpp-mimic replay', () => {
  it('replays a recorded session against the built-in CSMS', { timeout: 30_000 }, async () => {
    const { code, out } = await replay({ log: SAMPLE });
    expect(code, out.join('\n')).toBe(0);
    expect(out[0]).toMatch(/^PASS {2}Replay of SIM-CARD/);
  });

  it('replays a recorded 2.0.1 session as a 2.0.1 station', { timeout: 30_000 }, async () => {
    const log = fileURLToPath(
      new URL('../../../scenarios/logs/ocpp201-sessions.yaml-1.jsonl', import.meta.url),
    );
    const { code, out } = await replay({ log });
    expect(code, out.join('\n')).toBe(0);
    expect(out[0]).toMatch(/^PASS {2}Replay of SIM-201-CARD/);
  });

  it('replays a recorded 2.1 session as a 2.1 station', { timeout: 30_000 }, async () => {
    const log = fileURLToPath(
      new URL('../../../scenarios/logs/ocpp21-sessions.yaml-1.jsonl', import.meta.url),
    );
    const { code, out } = await replay({ log });
    expect(code, out.join('\n')).toBe(0);
    expect(out[0]).toMatch(/^PASS {2}Replay of SIM-21-CARD/);
  });

  it(
    'fails with the differences when the CSMS answers otherwise than the log',
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-replay-'));
      dirs.push(dir);
      const changed = (await readFile(SAMPLE, 'utf8')).replace(
        /("idTagInfo":\{"status":)"Accepted"(\},"transactionId")/,
        '$1"Blocked"$2',
      );
      await writeFile(join(dir, 'changed.jsonl'), changed);
      const { code, out } = await replay({ log: join(dir, 'changed.jsonl') });
      expect(code).toBe(1);
      expect(out.join('\n')).toMatch(
        /StartTransaction \(log line \d+\): idTagInfo.status is "Accepted", the log has "Blocked"/,
      );
    },
  );

  it(
    'writes the scenario with the frames inline, and the scenario runs',
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-replay-'));
      dirs.push(dir);
      const target = join(dir, 'replay.yaml');
      const written = await replay({ log: SAMPLE, write: target });
      expect(written.code).toBe(0);
      const yaml = await readFile(target, 'utf8');
      expect(yaml).toContain('replay: true');
      expect(yaml).toMatch(/- at: 0s\n\s+sent:/);
      const out: string[] = [];
      const command: RunCommand = {
        kind: 'run',
        paths: [target],
        vars: {},
        bail: false,
        personas: [],
        allowCsms: [],
      };
      expect(
        await runCommand(command, { out: (l) => out.push(l), err: () => {} }),
        out.join('\n'),
      ).toBe(0);
    },
  );

  it('asks for a station when the log has several, and exits 2 on an unreadable log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-replay-'));
    dirs.push(dir);
    const two =
      (await readFile(SAMPLE, 'utf8')) +
      (await readFile(SAMPLE, 'utf8'))
        .split('\n')
        .slice(1)
        .join('\n')
        .replaceAll('SIM-CARD', 'SIM-OTHER');
    await writeFile(join(dir, 'two.jsonl'), two);
    const several = await replay({ log: join(dir, 'two.jsonl') });
    expect(several.code).toBe(2);
    expect(several.err[0]).toMatch(/2 stations \(SIM-CARD, SIM-OTHER\); pick one/);
    expect((await replay({ log: join(dir, 'nope.jsonl') })).code).toBe(2);
  });
});
