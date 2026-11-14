import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calibrate,
  calibrationReport,
  parseLog,
  parseScenario,
  resolvePersonas,
} from '@ocpp-mimic/core';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runScenario } from './scenario/runner.js';

const LOGS = fileURLToPath(new URL('../../../scenarios/logs/', import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A persona with values a calibration should find again. */
const PERSONA = `persona: calib-test-1.6
extends: generic-1.6
boot: { chargePointVendor: CalibCo, chargePointModel: X-2, firmwareVersion: "9.1" }
connectors: 2
power: { offeredW: 11000 }
config:
  MeterValueSampleInterval: 2
  MeterValuesSampledData: Energy.Active.Import.Register,Power.Active.Import,Power.Offered
timing: { startTransactionDelay: 800ms, actionDelay: 300ms }
faults:
  - { errorCode: GroundFailure, info: GF1, vendorErrorCode: E9 }
usage:
  sessionsPerHour: 1200
  stay: { min: 4s, max: 6s }
  steps: { min: 200ms, max: 400ms }
  stopBy: { card: 1, unplug: 0 }
  idTags: { unknownShare: 0 }
`;

const SOURCE = {
  name: 'A calibration source',
  csms: 'builtin',
  station: { id: 'CAL-1', persona: 'calib-test-1.6', usage: true, seed: 2 },
  steps: [
    {
      csmsCall: {
        action: 'ChangeConfiguration',
        payload: { key: 'HeartbeatInterval', value: '2' },
        answer: { status: 'Accepted' },
      },
    },
    { csmsCall: { action: 'GetConfiguration', payload: {} } },
    ...Array.from({ length: 4 }, () => ({
      csmsCall: {
        action: 'TriggerMessage',
        payload: { requestedMessage: 'Heartbeat' },
        answer: { status: 'Accepted' },
      },
    })),
    { fault: { connector: 2, errorCode: 'GroundFailure', info: 'GF1', vendorErrorCode: 'E9' } },
    { clearFault: { connector: 2 } },
    { wait: '30s' },
  ],
};

describe('calibration', () => {
  it('reads boot fields, connectors and measurands from a sample log', async () => {
    const log = parseLog(await readFile(join(LOGS, 'usage.yaml-1.jsonl'), 'utf8'));
    const { persona, derived } = calibrate(log.lines);
    expect(persona).toMatchObject({
      persona: 'load-ac-22-calibrated',
      extends: 'generic-1.6',
      boot: { chargePointVendor: 'ocpp-mimic', chargePointModel: 'Load-AC-22' },
      connectors: 2,
    });
    expect(derived.find((d) => d.name === 'config.HeartbeatInterval')).toMatchObject({
      note: 'too few samples',
    });
  });

  it(
    'gives back the values of the persona a log was recorded from',
    { timeout: 90_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-calibrate-'));
      dirs.push(dir);
      await writeFile(join(dir, 'calib-test-1.6.yaml'), PERSONA);
      const parsed = parseScenario(SOURCE, 'source');
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      const logDir = join(dir, 'logs');
      const result = await runScenario(parsed.scenario, 'source', { personaDirs: [dir], logDir });
      expect(result.status, JSON.stringify(result.steps.filter((s) => s.status !== 'passed'))).toBe(
        'passed',
      );
      const log = parseLog(await readFile(join(logDir, 'source.jsonl'), 'utf8'));

      const calibration = calibrate(log.lines, { name: 'calibrated' });
      const p = calibration.persona as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(p.boot).toEqual({
        chargePointVendor: 'CalibCo',
        chargePointModel: 'X-2',
        firmwareVersion: '9.1',
      });
      expect(p.connectors).toBe(2);
      expect(p.config.HeartbeatInterval).toBe(2);
      expect(p.config.MeterValueSampleInterval).toBe(2);
      expect(p.config.MeterValuesSampledData).toBe(
        'Energy.Active.Import.Register,Power.Active.Import,Power.Offered',
      );
      expect(Math.abs(p.power.offeredW - 11000) / 11000).toBeLessThan(0.1);
      const secondsOf = (value: string) => Number(value.replace(/s$/, ''));
      expect(Math.abs(secondsOf(p.timing.actionDelay) - 0.3)).toBeLessThanOrEqual(0.15);
      expect(Math.abs(secondsOf(p.timing.startTransactionDelay) - 0.8)).toBeLessThanOrEqual(0.25);
      expect(p.faults).toEqual([
        {
          name: 'GroundFailure GF1',
          errorCode: 'GroundFailure',
          info: 'GF1',
          vendorErrorCode: 'E9',
        },
      ]);
      expect(p.usage.stopBy).toEqual({ card: 1, unplug: 0 });
      expect(secondsOf(p.usage.stay.min)).toBeGreaterThan(3);
      expect(secondsOf(p.usage.stay.max)).toBeLessThan(8);

      // The result is a persona ocpp-mimic accepts.
      const resolved = resolvePersonas([
        {
          source: 'generic',
          data: parse(
            await readFile(
              fileURLToPath(new URL('../personas/generic-1.6.yaml', import.meta.url)),
              'utf8',
            ),
          ),
        },
        { source: 'calibrated', data: calibration.persona },
      ]);
      expect(resolved.errors).toEqual([]);
      expect(calibrationReport(calibration)).toMatch(
        /\| config.MeterValueSampleInterval \| `2` \| \d+ \|/,
      );
    },
  );
});
