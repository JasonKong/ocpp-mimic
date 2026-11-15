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

/** A 2.0.1 persona with values a calibration should find again. */
const PERSONA_201 = `persona: calib-test-2.0.1
extends: generic-2.0.1
boot: { vendorName: CalibCo, model: X-201, firmwareVersion: "9.2" }
connectors: 2
power: { offeredW: 11000 }
deviceModel:
  SampledDataCtrlr:
    TxUpdatedInterval: 2
    TxUpdatedMeasurands: Energy.Active.Import.Register,Power.Active.Import,Power.Offered
  AuthCtrlr: { LocalPreAuthorize: true }
timing: { actionDelay: 300ms }
faults:
  - { errorCode: GroundFailure, info: GF1 }
usage:
  sessionsPerHour: 1200
  stay: { min: 4s, max: 6s }
  steps: { min: 200ms, max: 400ms }
  stopBy: { card: 1, unplug: 0 }
  idTags: { unknownShare: 0 }
`;

const SOURCE_201 = {
  name: 'A 2.0.1 calibration source',
  csms: 'builtin',
  station: { id: 'CAL-201', persona: 'calib-test-2.0.1', usage: true, seed: 2 },
  steps: [
    {
      csmsCall: {
        action: 'SetVariables',
        payload: {
          setVariableData: [
            {
              component: { name: 'OCPPCommCtrlr' },
              variable: { name: 'HeartbeatInterval' },
              attributeValue: '2',
            },
          ],
        },
      },
    },
    {
      csmsCall: { action: 'GetBaseReport', payload: { requestId: 1, reportBase: 'FullInventory' } },
    },
    ...Array.from({ length: 4 }, () => ({
      csmsCall: {
        action: 'TriggerMessage',
        payload: { requestedMessage: 'Heartbeat' },
        answer: { status: 'Accepted' },
      },
    })),
    { fault: { evse: 2, errorCode: 'GroundFailure', info: 'GF1' } },
    { clearFault: { evse: 2 } },
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
  it('gives back the generic 2.0.1 persona from the 2.0.1 sample log', async () => {
    const log = parseLog(await readFile(join(LOGS, 'ocpp201-sessions.yaml-1.jsonl'), 'utf8'));
    const { persona } = calibrate(log.lines);
    expect(persona).toMatchObject({
      persona: 'generic-ac-2.0.1-calibrated',
      extends: 'generic-2.0.1',
      boot: { vendorName: 'ocpp-mimic', model: 'Generic-AC-2.0.1', firmwareVersion: '0.0.0' },
      connectors: 1,
    });
    // What it derives is what generic-2.0.1 has: its default measurands. One periodic
    // sample is too few for TxUpdatedInterval, and the log has no NotifyReport.
    expect(persona.deviceModel).toEqual({
      SampledDataCtrlr: {
        TxUpdatedMeasurands: 'Energy.Active.Import.Register,Power.Active.Import',
      },
    });
  });

  it(
    'gives back the values of the 2.0.1 persona a log was recorded from',
    { timeout: 90_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-calibrate-'));
      dirs.push(dir);
      await writeFile(join(dir, 'calib-test-2.0.1.yaml'), PERSONA_201);
      const parsed = parseScenario(SOURCE_201, 'source');
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      const logDir = join(dir, 'logs');
      const result = await runScenario(parsed.scenario, 'source', { personaDirs: [dir], logDir });
      expect(result.status, JSON.stringify(result.steps.filter((s) => s.status !== 'passed'))).toBe(
        'passed',
      );
      const log = parseLog(await readFile(join(logDir, 'source.jsonl'), 'utf8'));
      expect(log.lines.every((line) => line.ocpp === '2.0.1')).toBe(true);

      const calibration = calibrate(log.lines, { name: 'calibrated' });
      const p = calibration.persona as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(p.extends).toBe('generic-2.0.1');
      expect(p.boot).toEqual({ vendorName: 'CalibCo', model: 'X-201', firmwareVersion: '9.2' });
      expect(p.connectors).toBe(2);
      expect(p.deviceModel.OCPPCommCtrlr.HeartbeatInterval).toBe(2);
      expect(p.deviceModel.SampledDataCtrlr.TxUpdatedInterval).toBe(2);
      expect(p.deviceModel.SampledDataCtrlr.TxUpdatedMeasurands).toBe(
        'Energy.Active.Import.Register,Power.Active.Import,Power.Offered',
      );
      // From the NotifyReport: a writable value that differs from the default.
      expect(p.deviceModel.AuthCtrlr).toEqual({ LocalPreAuthorize: 'true' });
      expect(Math.abs(p.power.offeredW - 11000) / 11000).toBeLessThan(0.1);
      const secondsOf = (value: string) => Number(value.replace(/s$/, ''));
      expect(Math.abs(secondsOf(p.timing.actionDelay) - 0.3)).toBeLessThanOrEqual(0.15);
      expect(p.timing.startTransactionDelay).toBeUndefined();
      expect(p.faults).toEqual([
        { name: 'GroundFailure GF1', errorCode: 'GroundFailure', info: 'GF1' },
      ]);
      expect(p.usage.stopBy).toEqual({ card: 1, unplug: 0 });

      const resolved = resolvePersonas([
        {
          source: 'generic',
          data: parse(
            await readFile(
              fileURLToPath(new URL('../personas/generic-2.0.1.yaml', import.meta.url)),
              'utf8',
            ),
          ),
        },
        { source: 'calibrated', data: calibration.persona },
      ]);
      expect(resolved.errors).toEqual([]);
    },
  );
});
