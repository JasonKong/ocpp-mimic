import { describe, expect, it } from 'vitest';
import { parseScenario, stepLabel, variableProblems, type Scenario } from './scenario.js';

const station = { id: 'SIM-1', persona: 'generic-1.6' };

function valid(document: Record<string, unknown>): Scenario {
  const result = parseScenario({ name: 'test', station, ...document });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.scenario;
}

function errors(document: Record<string, unknown>): string[] {
  const result = parseScenario({ name: 'test', station, ...document }, 'file.yaml#1');
  return result.ok ? [] : result.errors;
}

describe('scenario validation', () => {
  it('fills in defaults', () => {
    const scenario = valid({ steps: [{ online: null }] });
    expect(scenario).toEqual({
      name: 'test',
      csms: 'builtin',
      stations: [{ id: 'SIM-1', persona: 'generic-1.6', waitForBoot: true }],
      vars: {},
      checkSchemas: true,
      steps: [{ kind: 'online' }],
    });
  });

  it('turns every step kind into a typed step', () => {
    const scenario = valid({
      stations: [
        station,
        {
          id: 'SIM-2',
          persona: 'generic-1.6',
          config: { HeartbeatInterval: 30 },
          waitForBoot: false,
        },
      ],
      station: undefined,
      timeout: '2m',
      vars: { TAG: 'T1' },
      steps: [
        { plugIn: { connector: 1, ev: 'small' } },
        { unplug: { expectError: 'locked', station: 'SIM-2' } },
        { presentCard: { idTag: '{{TAG}}', result: 'authorized' } },
        { fault: { connector: 0, errorCode: 'GroundFailure', info: 'GND' } },
        { clearFault: {} },
        { offline: { mode: 'half-open' } },
        { online: {} },
        { setBehaviour: { cableLock: true } },
        { wait: '1.5s' },
        { charge: { duration: '1m' } },
        {
          name: 'boot',
          expect: {
            sent: 'BootNotification',
            answer: { status: 'Accepted' },
            save: { at: '$.answer.currentTime' },
          },
        },
        { expectNo: { received: 'RemoteStopTransaction', within: '30s' } },
        { expectConnector: { connector: 1, status: 'Charging', locked: true, within: 5000 } },
        { expectStation: { queuedMessages: 0, save: { reg: '$.registration' } } },
        {
          csmsCall: { action: 'Reset', payload: { type: 'Soft' }, answer: { status: 'Accepted' } },
        },
        {
          csmsReply: {
            action: 'Authorize',
            payload: { idTagInfo: { status: 'Invalid' } },
            times: 1,
          },
        },
        {
          http: {
            method: 'POST',
            url: 'http://localhost/x',
            basicAuth: { user: 'u', password: 'p' },
            json: { a: 1 },
            expect: { status: 200 },
          },
        },
      ],
    });
    expect(scenario.timeoutMs).toBe(120_000);
    expect(scenario.stations[1]).toEqual({
      id: 'SIM-2',
      persona: 'generic-1.6',
      config: { HeartbeatInterval: '30' },
      waitForBoot: false,
    });
    expect(scenario.steps).toEqual([
      { kind: 'plugIn', connector: 1, ev: 'small' },
      { kind: 'unplug', connector: 1, expectError: 'locked', station: 'SIM-2' },
      { kind: 'presentCard', connector: 1, idTag: '{{TAG}}', result: 'authorized' },
      { kind: 'fault', connector: 0, errorCode: 'GroundFailure', info: 'GND' },
      { kind: 'clearFault', connector: 1 },
      { kind: 'offline', mode: 'half-open' },
      { kind: 'online' },
      { kind: 'setBehaviour', behaviour: { cableLock: true } },
      { kind: 'wait', durationMs: 1500 },
      { kind: 'charge', connector: 1, durationMs: 60_000 },
      {
        kind: 'expect',
        name: 'boot',
        direction: 'sent',
        action: 'BootNotification',
        answer: { status: 'Accepted' },
        save: { at: '$.answer.currentTime' },
        withinMs: 10_000,
        from: 'last',
      },
      {
        kind: 'expectNo',
        direction: 'received',
        action: 'RemoteStopTransaction',
        withinMs: 30_000,
      },
      {
        kind: 'expectConnector',
        connector: 1,
        match: { status: 'Charging', locked: true },
        withinMs: 5000,
      },
      {
        kind: 'expectStation',
        match: { queuedMessages: 0 },
        save: { reg: '$.registration' },
        withinMs: 10_000,
      },
      {
        kind: 'csmsCall',
        action: 'Reset',
        payload: { type: 'Soft' },
        answer: { status: 'Accepted' },
      },
      {
        kind: 'csmsReply',
        action: 'Authorize',
        reply: { payload: { idTagInfo: { status: 'Invalid' } } },
        times: 1,
      },
      {
        kind: 'http',
        method: 'POST',
        url: 'http://localhost/x',
        basicAuth: { user: 'u', password: 'p' },
        json: { a: 1 },
        expect: { status: 200 },
      },
    ]);
  });

  it('parses replay steps and replay stations', () => {
    const parsed = parseScenario({
      name: 'replay',
      station: { id: 'R1', persona: 'generic-1.6', replay: true },
      steps: [
        { replay: { log: 'logs/a.jsonl', speed: 10, maxGap: '5s', compare: 'strict' } },
        {
          replay: {
            frames: [
              { at: '0s', sent: [2, '1', 'Heartbeat', {}] },
              { at: '20ms', received: [3, '1', {}] },
            ],
          },
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.scenario.stations[0]).toMatchObject({ replay: true, waitForBoot: false });
    expect(parsed.scenario.steps[0]).toEqual({
      kind: 'replay',
      log: 'logs/a.jsonl',
      speed: 10,
      maxGapMs: 5000,
      compare: 'strict',
    });
    expect(parsed.scenario.steps[1]).toMatchObject({
      kind: 'replay',
      frames: [
        { atMs: 0, direction: 'cp-to-csms', frame: [2, '1', 'Heartbeat', {}] },
        { atMs: 20, direction: 'csms-to-cp', frame: [3, '1', {}] },
      ],
    });
    const bad = parseScenario({
      name: 'bad replay',
      station: { id: 'R1', persona: 'generic-1.6', replay: true },
      steps: [
        { replay: {} },
        { replay: { log: 'a', frames: [] } },
        { replay: { frames: [{ at: '0s' }] } },
        { replay: { log: 'a', speed: 0 } },
      ],
    });
    expect(bad.ok ? [] : bad.errors).toEqual([
      '$.steps[0].replay: give log or frames',
      '$.steps[1].replay: give log or frames',
      '$.steps[2].replay.frames[0]: needs sent or received, with an OCPP-J message array',
      '$.steps[3].replay.speed: must be above 0',
    ]);
  });

  it('reads 2.0.1 station and step fields: deviceModel, idToken, type and evse', () => {
    const result = parseScenario({
      name: 'v201',
      station: {
        id: 'S',
        persona: 'generic-2.0.1',
        deviceModel: { OCPPCommCtrlr: { HeartbeatInterval: 10 } },
      },
      steps: [
        { presentCard: { idToken: 'TAG', type: 'KeyCode', evse: 2 } },
        { plugIn: { evse: 2 } },
        { expect: { sent: 'TransactionEvent' } },
        { csmsCall: { action: 'GetVariables', payload: {}, error: 'FormatViolation' } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scenario.stations[0]?.deviceModel).toEqual({
      OCPPCommCtrlr: { HeartbeatInterval: '10' },
    });
    expect(result.scenario.steps.slice(0, 2)).toMatchObject([
      { kind: 'presentCard', idTag: 'TAG', type: 'KeyCode', connector: 2 },
      { kind: 'plugIn', connector: 2 },
    ]);
    const both = parseScenario({
      name: 'both',
      station: { id: 'S', persona: 'p' },
      steps: [{ presentCard: { idTag: 'A', idToken: 'B' } }],
    });
    expect(both.ok ? [] : both.errors).toEqual([
      '$.steps[0].presentCard: needs idTag or idToken (one of them)',
    ]);
  });

  it('names the file, the step and the field in errors', () => {
    expect(
      errors({
        steps: [
          { plugin: { connector: 1 } },
          { plugIn: { connector: 'one' } },
          { presentCard: { connector: 1 } },
          { expect: { sent: 'RemoteStartTransaction' } },
          { expect: { received: 'Heartbeat' } },
          { expect: {} },
          { fault: { errorCode: 'NoError' } },
          { plugIn: {}, unplug: {} },
          { wait: 'soon' },
          { expectStation: { within: '1s' } },
          { expectConnector: { status: { $near: 1 } } },
          { csmsReply: { action: 'Authorize', payload: {}, ignore: true } },
          { http: { url: 'x', method: 'FETCH' } },
          { presentCard: { idTag: '{{env}}', station: 'SIM-9' } },
          { wait: '1s', station: 'SIM-1' },
        ],
      }),
    ).toEqual([
      'file.yaml#1: $.steps[0].plugin: unknown step (known: plugIn, unplug, evSuspend, evResume, clearFault, presentCard, fault, offline, online, stopStation, startStation, setBehaviour, charge, expect, expectNo, csmsCall, csmsReply, http, clearInjections, wait, inject, replay, expectConnector, expectStation)',
      'file.yaml#1: $.steps[1].plugIn.connector: expected integer, got string',
      'file.yaml#1: $.steps[2].presentCard: needs idTag or idToken (one of them)',
      'file.yaml#1: $.steps[3].expect.sent: "RemoteStartTransaction" is not one of Authorize, BootNotification, DataTransfer, DiagnosticsStatusNotification, FirmwareStatusNotification, Heartbeat, LogStatusNotification, MeterValues, SecurityEventNotification, SignCertificate, SignedFirmwareStatusNotification, StartTransaction, StatusNotification, StopTransaction, ClearedChargingLimit, Get15118EVCertificate, GetCertificateStatus, NotifyChargingLimit, NotifyCustomerInformation, NotifyDisplayMessages, NotifyEVChargingNeeds, NotifyEVChargingSchedule, NotifyEvent, NotifyMonitoringReport, NotifyReport, PublishFirmwareStatusNotification, ReportChargingProfiles, ReservationStatusUpdate, TransactionEvent',
      expect.stringMatching(
        /^file\.yaml#1: \$\.steps\[4\]\.expect\.received: "Heartbeat" is not one of/,
      ),
      'file.yaml#1: $.steps[5].expect: needs sent or received',
      'file.yaml#1: $.steps[6].fault.errorCode: NoError is not a fault; use clearFault',
      'file.yaml#1: $.steps[7]: a step has exactly one step key besides name, found plugIn, unplug',
      'file.yaml#1: $.steps[8].wait: not a duration (use milliseconds or e.g. "500ms", "6s", "3m"): "soon"',
      'file.yaml#1: $.steps[9].expectStation: nothing to match',
      'file.yaml#1: $.steps[10].expectConnector.status: unknown operator $near (use $exists, $regex, $ne, $gt, $gte, $lt, $lte, $contains, $size)',
      'file.yaml#1: $.steps[11].csmsReply: give exactly one of payload, error or ignore: true',
      'file.yaml#1: $.steps[12].http.method: "FETCH" is not one of GET, POST, PUT, PATCH, DELETE',
      'file.yaml#1: $.steps[13].presentCard.station: no station SIM-9 in this scenario',
      'file.yaml#1: $.steps[13].presentCard: invalid template {{env}}',
      'file.yaml#1: $.steps[14]: a step has exactly one step key besides name, found wait, station',
    ]);
  });

  it('checks the scenario fields', () => {
    expect(parseScenario('nope').ok).toBe(false);
    expect(errors({ name: '', steps: [] })).toEqual([
      'file.yaml#1: $.name: must not be empty',
      'file.yaml#1: $.steps: needs at least one step',
    ]);
    expect(errors({ stations: [station], steps: [{ online: {} }] })).toEqual([
      'file.yaml#1: $: give station or stations, not both',
    ]);
    expect(
      errors({ station: undefined, stations: [station, station], steps: [{ online: {} }] }),
    ).toEqual(['file.yaml#1: $.stations[1].id: duplicate station id SIM-1']);
    expect(
      errors({ csms: 'http://x', vars: { env: 1, 'bad-name': 2 }, steps: [{ online: {} }] }),
    ).toEqual([
      'file.yaml#1: $.vars.env: "env" is not a valid variable name',
      'file.yaml#1: $.vars.bad-name: "bad-name" is not a valid variable name',
      'file.yaml#1: $.csms: must be builtin or a ws:// or wss:// URL',
    ]);
    expect(
      errors({
        csms: 'ws://localhost:9000/ocpp',
        steps: [{ csmsCall: { action: 'Reset', payload: { type: 'Hard' } } }],
      }),
    ).toEqual(['file.yaml#1: $.steps[0].csmsCall: needs the built-in CSMS (csms: builtin)']);
    expect(
      errors({ station: { id: 'X', persona: 'p', energyMultiplier: 0 }, steps: [{ online: {} }] }),
    ).toEqual(['file.yaml#1: $.station.energyMultiplier: must be above 0']);
  });

  it('finds variables used before they are defined', () => {
    const scenario = valid({
      vars: { TAG: 'T' },
      steps: [
        { presentCard: { idTag: '{{TAG}}' } },
        { expectConnector: { transactionId: '{{tx}}' } },
        { expect: { sent: 'StartTransaction', save: { tx: '$.answer.transactionId' } } },
        { csmsCall: { action: 'RemoteStopTransaction', payload: { transactionId: '{{tx}}' } } },
        { http: { url: '{{APP_API}}/x', headers: { Authorization: 'Bearer {{env.TOKEN}}' } } },
      ],
    });
    expect(variableProblems(scenario)).toEqual([
      '$.steps[1].expectConnector: unknown variable tx',
      '$.steps[4].http: unknown variable APP_API',
    ]);
    expect(variableProblems(scenario, ['APP_API', 'tx'])).toEqual([]);
  });

  it('labels steps for reports', () => {
    const scenario = valid({
      steps: [
        { plugIn: { connector: 2 } },
        { name: 'Card in', presentCard: { idTag: 'T' } },
        { expect: { sent: 'StopTransaction' } },
        { expectNo: { received: 'RemoteStopTransaction', within: '30s' } },
        { expectConnector: { status: 'Charging', locked: true } },
        { wait: 65_000 },
        { http: { method: 'POST', url: '{{API}}/start' } },
        { inject: { type: 'latency', ms: '2s', for: '30s' } },
        { inject: { type: 'reconnectStorm' } },
        { clearInjections: null },
        { csmsCall: { action: 'ClearCache', noAnswer: '2s' } },
      ],
    });
    expect(scenario.steps.map(stepLabel)).toEqual([
      'plugIn connector 2',
      'Card in',
      'expect sent StopTransaction',
      'expectNo received RemoteStopTransaction for 30s',
      'expectConnector 1 status=Charging locked=true',
      'wait 1m5s',
      'http POST {{API}}/start',
      'inject latency ms=2000 direction=both for 30s',
      'inject reconnectStorm',
      'clearInjections',
      'csmsCall ClearCache',
    ]);
    expect(scenario.steps[7]).toMatchObject({
      kind: 'inject',
      request: { injection: { type: 'latency', ms: 2000 }, forMs: 30_000 },
    });
    expect(scenario.steps[10]).toMatchObject({ kind: 'csmsCall', noAnswerMs: 2000 });
    const invalid = parseScenario({
      name: 'x',
      station: { id: 'A', persona: 'p' },
      steps: [
        { inject: { type: 'drop' } },
        { csmsCall: { action: 'ClearCache', noAnswer: '1s', answer: {} } },
      ],
    });
    expect(invalid.ok ? [] : invalid.errors).toEqual([
      '$.steps[0].inject.direction: missing required property',
      '$.steps[1].csmsCall: give one of answer, error and noAnswer',
    ]);
  });
});
