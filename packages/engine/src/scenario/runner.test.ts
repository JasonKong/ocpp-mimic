import { fileURLToPath } from 'node:url';
import { parseScenario, type Scenario } from '@ocpp-mimic/core';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { findScenarioFiles, readScenarioFile } from './files.js';
import { formatScenarioResult } from './report.js';
import { runScenario, type RunOptions } from './runner.js';

const EXAMPLES = fileURLToPath(new URL('../../../../scenarios/examples/', import.meta.url));
const REGRESSION = fileURLToPath(new URL('../../../../scenarios/regression/', import.meta.url));
const PERSONAS = fileURLToPath(new URL('../../../../scenarios/personas/', import.meta.url));
const FAST: RunOptions = { backoff: { initialDelayMs: 20, maxDelayMs: 100, jitter: 0 } };

function scenario(yaml: string): Scenario {
  const result = parseScenario(parse(yaml));
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.scenario;
}

const STATION = 'station: { id: SIM-1, persona: generic-1.6 }';

describe('scenario runner', () => {
  it('runs the reference examples against the built-in CSMS', { timeout: 90_000 }, async () => {
    const files = (await findScenarioFiles([EXAMPLES])).filter(
      (f) => !f.endsWith('app-triggered-start.yaml'),
    );
    const outcomes: string[] = [];
    for (const file of files) {
      for (const document of (await readScenarioFile(file)).documents) {
        if (document.scenario === undefined) throw new Error(document.errors.join('\n'));
        const result = await runScenario(document.scenario, document.label, FAST);
        const failing = result.steps.find((s) => s.status === 'failed');
        outcomes.push(
          `${result.name}: ${result.status}${failing ? ` at "${failing.label}": ${failing.message} ${JSON.stringify(failing.details ?? [])}` : ''}${result.error ? ` (${result.error})` : ''}`,
        );
      }
    }
    expect(outcomes).toEqual([
      'A fault ends the transaction and clearing it recovers the connector: passed',
      'Card session with periodic meter values: passed',
      'Card session and remote start on OCPP 2.0.1: passed',
      'Card session and web payment on OCPP 2.1: passed',
      'StopTransaction is resent after an outage: passed',
      'StopTransaction is resent after a half-open connection: passed',
      'Remote start and stop from the CSMS: passed',
    ]);
  });

  it(
    'runs the CSMS command scenarios against the built-in CSMS',
    { timeout: 120_000 },
    async () => {
      const outcomes: string[] = [];
      for (const document of (await readScenarioFile(`${REGRESSION}csms-commands.yaml`))
        .documents) {
        if (document.scenario === undefined) throw new Error(document.errors.join('\n'));
        const result = await runScenario(document.scenario, document.label, {
          ...FAST,
          personaDirs: [PERSONAS],
        });
        const failing = result.steps.find((s) => s.status === 'failed');
        outcomes.push(
          `${result.name}: ${result.status}${failing ? ` at "${failing.label}": ${failing.message} ${JSON.stringify(failing.details ?? [])}` : ''}${result.error ? ` (${result.error})` : ''}`,
        );
      }
      expect(outcomes).toEqual([
        'RemoteStartTransaction and RemoteStopTransaction: passed',
        "RemoteStartTransaction refused by the station's switch: passed",
        'TriggerMessage: passed',
        'GetConfiguration and ChangeConfiguration take effect: passed',
        'UnlockConnector ends the transaction: passed',
        'ChangeAvailability answers first and keeps connectorId 0 separate: passed',
        'Soft reset during a transaction, then a hard reset: passed',
        "The station follows the CSMS's answers: passed",
      ]);
    },
  );

  it(
    'fails a step with expected and actual values, and skips the rest',
    { timeout: 20_000 },
    async () => {
      const result = await runScenario(
        scenario(`
name: wrong expectation
${STATION}
steps:
  - presentCard: { idTag: TAG, result: authorized }
  - plugIn: {}
  - expect: { sent: StartTransaction, payload: { idTag: OTHER }, within: 2s }
  - unplug: {}
`),
        'inline#1',
        FAST,
      );
      expect(result.status).toBe('failed');
      // The OCA schema check still runs after a failed step.
      expect(result.steps.map((s) => s.status)).toEqual([
        'passed',
        'passed',
        'failed',
        'skipped',
        'passed',
      ]);
      expect(result.steps[2]?.message).toBe('no matching StartTransaction sent within 2s');
      expect(result.steps[2]?.details?.[0]).toMatch(
        /^StartTransaction at [\d:.]+: \$\.payload\.idTag: expected "OTHER", found "TAG"$/,
      );
    },
  );

  it("refuses actions that do not exist in the station's OCPP version, before running", async () => {
    const result = await runScenario(
      scenario(`name: wrong version
station: { id: SIM-201, persona: generic-2.0.1 }
steps:
  - expect: { sent: StartTransaction }
  - csmsCall: { action: RemoteStartTransaction, payload: { idTag: A } }
  - csmsReply: { action: TransactionEvent, error: FormationViolation }
  - expect: { sent: TransactionEvent, within: 1s }`),
      'wrong-version.yaml',
      FAST,
    );
    expect(result.status).toBe('error');
    expect(result.error?.split('\n')).toEqual([
      'steps[0].expect: StartTransaction is not a charging station message in OCPP 2.0.1 (station SIM-201)',
      'steps[1].csmsCall: RemoteStartTransaction is not a CSMS message in OCPP 2.0.1 (station SIM-201)',
      'steps[2].csmsReply: FormationViolation is not an error code in OCPP 2.0.1 (station SIM-201)',
    ]);
  });

  it('treats refusals as failures unless the step expects them', { timeout: 20_000 }, async () => {
    const yaml = (expectError: string) => `
name: locked cable
station: { id: SIM-1, persona: generic-1.6, behaviour: { cableLock: true } }
steps:
  - presentCard: { idTag: TAG }
  - plugIn: {}
  - expectConnector: { status: Charging, locked: true }
  - unplug: { ${expectError} }
`;
    const expected = await runScenario(scenario(yaml('expectError: locked')), 'a#1', FAST);
    expect(expected.status).toBe('passed');
    const unexpected = await runScenario(scenario(yaml('')), 'b#1', FAST);
    expect(unexpected.steps[3]).toMatchObject({
      status: 'failed',
      message: 'refused: connector 1 is locked',
    });
    const wrong = await runScenario(scenario(yaml('expectError: jammed')), 'c#1', FAST);
    expect(wrong.steps[3]?.message).toBe(
      'refused with "connector 1 is locked", which does not contain "jammed"',
    );
  });

  it(
    'checks expectNo over its window, and saves values for later steps',
    { timeout: 20_000 },
    async () => {
      const result = await runScenario(
        scenario(`
name: expectNo and save
${STATION}
steps:
  - expectNo: { received: RemoteStopTransaction, within: 500ms }
  - expectStation: { registration: Accepted, save: { reg: $.registration } }
  - expectStation: { registration: "{{reg}}" }
  - csmsCall: { action: TriggerMessage, payload: { requestedMessage: StatusNotification, connectorId: 1 } }
  - expectNo: { sent: StatusNotification, within: 1s }
`),
        'inline#1',
        FAST,
      );
      expect(result.steps.map((s) => s.status)).toEqual([
        'passed',
        'passed',
        'passed',
        'passed',
        'failed',
        'passed',
      ]);
      expect(result.steps[4]?.message).toMatch(/^StatusNotification was sent at /);
    },
  );

  it(
    'fails the scenario when a frame breaks the official OCA schema',
    { timeout: 20_000 },
    async () => {
      const yaml = (check: boolean) => `
name: schema
${STATION}
checkSchemas: ${check}
steps:
  - csmsCall: { action: RemoteStartTransaction, payload: { idTag: X, bogus: 1 }, error: FormationViolation }
`;
      const strict = await runScenario(scenario(yaml(true)), 'a#1', FAST);
      expect(strict.status).toBe('failed');
      expect(strict.steps.at(-1)).toMatchObject({
        label: 'every frame passes the official OCA schemas',
        status: 'failed',
        details: [
          expect.stringContaining(
            'RemoteStartTransaction (CALL): $: must NOT have additional properties (bogus)',
          ),
        ],
      });
      expect((await runScenario(scenario(yaml(false)), 'b#1', FAST)).status).toBe('passed');
    },
  );

  it(
    'charges an EV with the energy multiplier and reports the multiplier',
    { timeout: 30_000 },
    async () => {
      const result = await runScenario(
        scenario(`
name: fast EV
station: { id: SIM-1, persona: generic-1.6, energyMultiplier: 240 }
steps:
  - presentCard: { idTag: TAG }
  - plugIn: { ev: test-5kwh }
  - expectConnector: { status: Charging, ev: { soc: { $gt: 70 } } }
  - expectConnector: { status: SuspendedEV, ev: { soc: 100 }, within: 20s }
`),
        'ev#1',
        FAST,
      );
      expect(result.status).toBe('passed');
      expect(result.properties.energyMultiplier).toBe('×240');
    },
  );

  it(
    'reports errors for timeouts, unknown variables and setup problems',
    { timeout: 20_000 },
    async () => {
      const timedOut = await runScenario(
        scenario(`
name: slow
${STATION}
timeout: 1s
steps:
  - wait: 10s
`),
        'a#1',
        FAST,
      );
      expect(timedOut).toMatchObject({ status: 'error', error: 'the scenario timed out after 1s' });
      expect(timedOut.durationMs).toBeLessThan(5000);

      const unknown = await runScenario(
        scenario(`
name: vars
${STATION}
steps:
  - presentCard: { idTag: "{{TAG}}" }
`),
        'b#1',
        FAST,
      );
      expect(unknown).toMatchObject({
        status: 'error',
        error: '$.steps[0].presentCard: unknown variable TAG',
      });
      expect(
        (await runScenario(unknownScenario(), 'c#1', { ...FAST, vars: { TAG: 'T' } })).status,
      ).toBe('passed');

      const setup = await runScenario(
        scenario(`
name: no persona
station: { id: SIM-1, persona: nope }
steps:
  - online: {}
`),
        'd#1',
        FAST,
      );
      expect(setup).toMatchObject({ status: 'error', error: 'unknown persona nope' });
    },
  );

  it(
    'measures waits in awake time and reports how long the host slept',
    { timeout: 20_000 },
    async () => {
      // A laptop that sleeps for 15 minutes during a wait: the wall clock jumps,
      // Node's timers and the awake clock do not (#264).
      let asleepMs = 0;
      const clock = { wall: () => Date.now() + asleepMs, awake: () => performance.now() };
      const sleeper = setTimeout(() => (asleepMs = 15 * 60_000), 300);
      const slept = await runScenario(
        scenario(`
name: host sleeps
${STATION}
steps:
  - wait: 1s
  - expectStation: { registration: Accepted, within: 1s }
`),
        'sleep#1',
        { ...FAST, clock },
      );
      clearTimeout(sleeper);
      expect(slept.status).toBe('passed');
      expect(slept.durationMs).toBeGreaterThanOrEqual(15 * 60_000);
      expect(slept.hostAsleepMs).toBeGreaterThan(15 * 60_000 - 1000);
      expect(slept.hostAsleepMs).toBeLessThan(15 * 60_000 + 1000);
      expect(slept.properties.hostAsleep).toBe('15m');
      expect(formatScenarioResult(slept)[0]).toContain(', host asleep 15m)');

      const awake = await runScenario(
        scenario(`
name: host stays awake
${STATION}
steps:
  - wait: 100ms
`),
        'awake#1',
        FAST,
      );
      expect(awake.status).toBe('passed');
      expect(awake.hostAsleepMs).toBeUndefined();
      expect(awake.properties.hostAsleep).toBeUndefined();
    },
  );
});

function unknownScenario(): Scenario {
  return scenario(`
name: vars
${STATION}
steps:
  - presentCard: { idTag: "{{TAG}}", result: authorized }
`);
}
