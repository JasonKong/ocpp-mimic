import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCalibrateCommand } from './calibrate.js';

const LOGS = fileURLToPath(new URL('../../../scenarios/logs/', import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('ocpp-mimic calibrate', () => {
  it('writes a persona and a report from logs of one model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-calibrate-'));
    dirs.push(dir);
    const err: string[] = [];
    const code = await runCalibrateCommand(
      {
        kind: 'calibrate',
        logs: [join(LOGS, 'usage.yaml-1.jsonl'), join(LOGS, 'usage.yaml-2.jsonl')],
        stations: [],
        name: 'load-ac-from-logs',
        out: join(dir, 'persona.yaml'),
        report: join(dir, 'report.md'),
      },
      { out: () => {}, err: (line) => err.push(line) },
    );
    expect(code).toBe(0);
    expect(err.at(-1)).toMatch(/^\d+ values derived, \d+ not/);
    const persona = await readFile(join(dir, 'persona.yaml'), 'utf8');
    expect(persona).toMatch(
      /^# Calibrated by ocpp-mimic from \d+ frames of REG-USE-1, REG-USE-2\./,
    );
    expect(persona).toContain('persona: load-ac-from-logs');
    expect(persona).toContain('chargePointModel: Load-AC-22');
    expect(persona).toContain('connectors: 2');
    expect(await readFile(join(dir, 'report.md'), 'utf8')).toMatch(
      /^# Calibration of load-ac-from-logs/,
    );
  });

  it('exits 2 for a missing log or a station that is not in it', async () => {
    const io = { out: () => {}, err: () => {} };
    expect(
      await runCalibrateCommand({ kind: 'calibrate', logs: ['/nope.jsonl'], stations: [] }, io),
    ).toBe(2);
    expect(
      await runCalibrateCommand(
        { kind: 'calibrate', logs: [join(LOGS, 'usage.yaml-1.jsonl')], stations: ['OTHER'] },
        io,
      ),
    ).toBe(2);
  });
});
