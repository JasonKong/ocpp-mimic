/**
 * Component tests: the 2.0.1 views rendered to HTML with Vue's server
 * renderer, from the props the app gives them.
 */
import { describe, expect, it } from 'vitest';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type {
  DeviceModelEntry,
  RecordEntry,
  SessionDetail,
  SessionSummary,
  StationSnapshot,
  StationSummary,
} from '../api.js';
import DeviceModelBrowser from './DeviceModelBrowser.vue';
import FleetOverview from './FleetOverview.vue';
import MessageLog from './MessageLog.vue';
import EnergyPanel from './EnergyPanel.vue';
import PriceCard from './PriceCard.vue';
import SessionHeader from './SessionHeader.vue';
import SessionLog from './SessionLog.vue';
import SessionsView from './SessionsView.vue';
import VehicleCard from './VehicleCard.vue';
import StationDetail from './StationDetail.vue';
import StationList from './StationList.vue';
import TransactionEvents from './TransactionEvents.vue';

const render = (component: Component, props: Record<string, unknown>) =>
  renderToString(createSSRApp({ render: () => h(component, props) }));
/** The visible text, whitespace collapsed. */
const text = (html: string) =>
  html
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const station201: StationSnapshot = {
  id: 'SIM-201',
  ocpp: '2.0.1',
  persona: 'generic-2.0.1',
  csmsUrl: 'ws://localhost:9000/ocpp',
  running: true,
  transport: 'open',
  registration: 'Accepted',
  connected: true,
  station: { status: 'Available', errorCode: 'NoError' },
  connectors: [
    {
      connectorId: 1,
      evseId: 1,
      status: 'Occupied',
      chargingState: 'SuspendedEVSE',
      errorCode: 'NoError',
      plugged: true,
      locked: false,
      transactionId: '5b0c9a61-3a3c-4b5e-9d55-0f1d7c2e8a11',
      idTag: 'TAG-1',
      energyWh: 1200,
      powerW: 0,
      limitW: 0,
    },
    {
      connectorId: 2,
      evseId: 2,
      status: 'Reserved',
      chargingState: 'Idle',
      errorCode: 'NoError',
      plugged: false,
      locked: false,
      energyWh: 0,
      powerW: 0,
    },
  ],
  config: {},
  queuedMessages: 0,
  behaviour: { refuseRemoteStart: false, cableLock: false },
  energyMultiplier: 1,
  localList: { version: 0, size: 0 },
  reservations: [
    { reservationId: 4, connectorId: 2, idTag: 'TAG-R', expiryDate: '2026-11-15T11:30:00Z' },
  ],
  chargingProfiles: [],
};

describe('the 2.0.1 views', () => {
  it('shows EVSEs with their connector status, charging state, transaction and IdToken types', async () => {
    const html = await render(StationDetail, { station: station201, persona: undefined });
    const shown = text(html);
    expect(shown).toContain('OCPP 2.0.1');
    expect(shown).toContain('EVSE 1 · connector 1 Occupied SuspendedEVSE');
    expect(shown).toContain('EVSE 2 · connector 1 Reserved');
    expect(shown).not.toContain('EVSE 2 · connector 1 Reserved Idle');
    expect(shown).toContain('5b0c9a61…');
    expect(html).toContain('title="5b0c9a61-3a3c-4b5e-9d55-0f1d7c2e8a11"');
    expect(shown).toContain('Reserved for TAG-R until 11:30');
    // The IdToken type picker, ISO14443 first.
    expect(html).toContain('aria-label="IdToken type"');
    expect(html.indexOf('ISO14443')).toBeLessThan(html.indexOf('NoAuthorization'));
  });

  it('keeps the 1.6 view for 1.6 stations', async () => {
    const station16: StationSnapshot = {
      ...station201,
      ocpp: '1.6',
      connectors: [
        {
          connectorId: 1,
          status: 'Charging',
          errorCode: 'NoError',
          plugged: true,
          locked: false,
          transactionId: 7,
          energyWh: 0,
          powerW: 7360,
        },
      ],
      reservations: [],
    };
    const html = await render(StationDetail, { station: station16, persona: undefined });
    expect(text(html)).toContain('Connector 1 Charging');
    expect(html).not.toContain('IdToken type');
  });

  it('lists TransactionEvents newest first with seqNo, trigger and charging state', async () => {
    const entries: RecordEntry[] = [0, 1].map((seqNo) => ({
      kind: 'frame',
      seq: seqNo + 1,
      stationId: 'SIM-201',
      at: `2026-11-15T10:00:0${seqNo}.000Z`,
      direction: 'cp-to-csms',
      messageType: 2,
      action: 'TransactionEvent',
      payload: {
        eventType: seqNo === 0 ? 'Started' : 'Updated',
        seqNo,
        triggerReason: seqNo === 0 ? 'CablePluggedIn' : 'ChargingStateChanged',
        evse: { id: 1, connectorId: 1 },
        transactionInfo: {
          transactionId: 'abcdef0123456789',
          chargingState: seqNo === 0 ? 'Charging' : 'SuspendedEVSE',
        },
      },
      text: '',
    }));
    const shown = text(await render(TransactionEvents, { entries }));
    expect(shown).toContain(
      '10:00:01.000 1 abcdef01 1 Updated ChargingStateChanged SuspendedEVSE 10:00:00.000 1 abcdef01 0 Started CablePluggedIn Charging',
    );
    expect(text(await render(TransactionEvents, { entries: [] }))).toContain(
      'No TransactionEvent sent yet.',
    );
  });

  it('browses the Device Model by component, hiding write-only values', async () => {
    const variables: DeviceModelEntry[] = [
      {
        component: 'SecurityCtrlr',
        variable: 'BasicAuthPassword',
        dataType: 'string',
        maxLimit: 40,
        attributes: [{ type: 'Actual', mutability: 'WriteOnly' }],
      },
      {
        component: 'OCPPCommCtrlr',
        variable: 'HeartbeatInterval',
        dataType: 'integer',
        unit: 's',
        minLimit: 0,
        attributes: [{ type: 'Actual', mutability: 'ReadWrite', value: '300' }],
      },
      {
        component: 'EVSE@1',
        variable: 'Power',
        dataType: 'decimal',
        unit: 'W',
        maxLimit: 7360,
        attributes: [
          { type: 'Actual', mutability: 'ReadOnly', value: '0' },
          { type: 'MaxSet', mutability: 'ReadWrite', value: '7360' },
        ],
      },
    ];
    const shown = text(await render(DeviceModelBrowser, { variables }));
    expect(shown).toContain('OCPPCommCtrlr 1');
    expect(shown).toContain('HeartbeatInterval 300 edit RW integer (s) · min 0');
    expect(shown).toContain('BasicAuthPassword (write-only) WO');
    expect(shown).toContain('Power 0 RO MaxSet 7360 decimal (W) · max 7360');
    expect(shown.indexOf('SecurityCtrlr')).toBeLessThan(shown.indexOf('EVSE@1'));
    // Only read-write values can be set locally.
    const html = await render(DeviceModelBrowser, { variables });
    expect(html.match(/Set HeartbeatInterval as a local operator/g)).toHaveLength(1);
    expect(html).not.toContain('Set Power as a local operator');
    expect(html).not.toContain('Set BasicAuthPassword as a local operator');
    expect(text(await render(DeviceModelBrowser, { variables: undefined }))).toContain('Loading…');
  });

  it('marks every station with its version in the list', async () => {
    const stations: StationSummary[] = [
      {
        id: 'SIM-1',
        persona: 'generic-1.6',
        ocpp: '1.6',
        tags: [],
        state: 'connected',
        registration: 'Accepted',
        connectors: [],
      },
      {
        id: 'SIM-2',
        persona: 'generic-2.0.1',
        ocpp: '2.0.1',
        tags: [],
        state: 'connected',
        registration: 'Accepted',
        connectors: [
          { connectorId: 1, status: 'Occupied', chargingState: 'Charging' },
          // Plugged in but not charging yet.
          { connectorId: 2, status: 'Occupied', chargingState: 'EVConnected' },
        ],
      },
    ];
    const html = await render(StationList, { stations, personas: [], selectedId: undefined });
    const shown = text(html);
    expect(shown).toContain('SIM-1 1.6 Accepted');
    expect(shown).toContain('SIM-2 2.0.1 Charging 1');
    expect(html).toContain('class="version-badge v16"');
    expect(html).toContain('class="version-badge v201"');
    // The bulk actions act on the stations in view.
    expect(shown).toContain('2 in view Start Stop Offline Online Delete');
  });

  it('counts charging 2.0.1 EVSEs in the fleet overview by their charging state', async () => {
    const stations: StationSummary[] = [
      {
        id: 'A',
        persona: 'generic-1.6',
        ocpp: '1.6',
        tags: [],
        state: 'connected',
        registration: 'Accepted',
        connectors: [
          { connectorId: 1, status: 'SuspendedEV' },
          { connectorId: 2, status: 'Preparing' },
        ],
      },
      {
        id: 'B',
        persona: 'generic-2.0.1',
        ocpp: '2.0.1',
        tags: [],
        state: 'connected',
        registration: 'Accepted',
        connectors: [
          { connectorId: 1, status: 'Occupied', chargingState: 'Charging' },
          { connectorId: 2, status: 'Occupied', chargingState: 'EVConnected' },
        ],
      },
    ];
    const html = await render(FleetOverview, { stations });
    // All: 2 stations, 2 online, 0 offline, 0 stopped, 2 charging, 0 faulted.
    expect(text(html)).toContain('All 2 2 0 0 2 0');
  });

  it('shows the version of each frame in the message log', async () => {
    const entries: RecordEntry[] = [
      {
        kind: 'frame',
        seq: 1,
        stationId: 'SIM-201',
        at: '2026-11-15T10:00:00.000Z',
        direction: 'cp-to-csms',
        messageType: 2,
        uniqueId: '1',
        action: 'StatusNotification',
        payload: {},
        ocpp: '2.0.1',
        text: '[2,"1","StatusNotification",{}]',
      },
    ];
    const html = await render(MessageLog, { entries, stationId: 'SIM-201' });
    expect(text(html)).toContain('2.0.1 StatusNotification');
  });
});

describe('the Sessions view', () => {
  const summary = (n: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
    stationId: 'SIM-201',
    n,
    ocpp: '2.0.1',
    state: 'finished',
    source: 'local',
    evseId: 1,
    idToken: { idToken: 'AA000001', type: 'ISO14443' },
    requestedAt: '2026-11-15T10:00:00.000Z',
    energyWh: 12_400,
    ...extra,
  });
  const remote: SessionDetail = {
    session: {
      ...summary(2, { state: 'running', source: 'remote', remoteStartId: 42 }),
      idToken: { idToken: 'APP-USER-1', type: 'Central' },
      connectorId: 1,
      transactionId: '5b0c9a61-3a3c-4b5e-9d55-0f1d7c2e8a11',
      startedAt: '2026-11-15T10:00:01.000Z',
      timeline: [
        {
          seq: 10,
          at: '2026-11-15T10:00:00.000Z',
          action: 'RequestStartTransaction',
          direction: 'csms-to-cp',
          messageType: 2,
        },
        {
          seq: 11,
          at: '2026-11-15T10:00:00.080Z',
          action: 'RequestStartTransaction',
          direction: 'cp-to-csms',
          messageType: 3,
          status: 'Accepted',
          sincePreviousMs: 80,
        },
        {
          seq: 12,
          at: '2026-11-15T10:00:01.000Z',
          action: 'TransactionEvent',
          direction: 'cp-to-csms',
          messageType: 2,
          status: 'Started RemoteStart',
          sincePreviousMs: 920,
        },
      ],
      samples: [],
      truth: [],
      states: [],
      costs: [],
    },
    summary: summary(2, { state: 'running', source: 'remote' }),
    estimate: { targetSoc: 100, targetFrom: 'default', taperSoc: 80, reason: 'no SoC reported' },
    durations: { charging: 0, suspendedEV: 0, suspendedEVSE: 0, idle: 0 },
    price: { tariffId: 'reference', currency: 'NZD', items: [], exclTax: 0, tax: 0, inclTax: 0 },
  };
  const props = (extra: Record<string, unknown> = {}) => ({
    station: station201,
    sessions: [
      summary(3, { state: 'not-started', source: 'remote', failure: { reason: 'Rejected' } }),
      remote.summary,
      summary(1),
    ],
    detail: remote,
    selectedN: 2,
    showTruth: false,
    now: Date.parse('2026-11-15T10:30:01.000Z'),
    ...extra,
  });

  it('lists sessions with their start source, and shows how the open one started', async () => {
    const html = await render(SessionsView, props());
    const shown = text(html);
    expect(shown).toContain('#3 Remote start Rejected EVSE 1 · AA000001');
    expect(shown).toContain('#1 Card 12.40 kWh EVSE 1 · AA000001');
    expect(shown).toContain('Session #2 Remote start Running');
    expect(shown).toContain('idToken APP-USER-1 (Central)');
    expect(shown).toContain('remoteStartId 42');
    expect(shown).toContain('Duration 30 min');
    expect(shown).toContain('CSMS → CP RequestStartTransaction');
    expect(shown).toContain('+80 ms CP → CSMS RequestStartTransaction answer Accepted');
    expect(shown).toContain('Started RemoteStart');
    expect(html).toContain('class="version-badge v201"');
  });

  it('names 1.6 things as 1.6 does and explains a session that never started', async () => {
    const failed: SessionDetail = {
      ...remote,
      session: {
        ...remote.session,
        ocpp: '1.6',
        state: 'not-started',
        source: 'remote',
        failure: { reason: 'NotAuthorized', detail: 'Invalid' },
        idToken: { idToken: 'APP-USER-1' },
        timeline: [],
      },
    };
    const station16 = { ...station201, ocpp: '1.6' as const };
    const shown = text(await render(SessionsView, props({ station: station16, detail: failed })));
    expect(shown).toContain('Connector Connector 1');
    expect(shown).toContain('idTag APP-USER-1');
    expect(shown).not.toContain('remoteStartId');
    expect(shown).toContain('Not authorized (Invalid)');
    expect(shown).toContain('No start messages recorded.');
  });

  it('offers a remote start only when the station uses the built-in CSMS', async () => {
    expect(
      await render(SessionsView, props({ station: { ...station201, csms: 'builtin' } })),
    ).toContain('Remote start via the built-in CSMS');
    const external = text(
      await render(SessionsView, props({ station: { ...station201, csms: 'external' } })),
    );
    expect(external).not.toContain('Remote start via the built-in CSMS');
    expect(external).toContain('Remote starts come from the station');
  });
});

describe('the energy panel', () => {
  const T0 = Date.parse('2026-11-15T10:00:00Z');
  const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
  const detail: SessionDetail = {
    session: {
      stationId: 'SIM-201',
      n: 1,
      ocpp: '2.0.1',
      state: 'running',
      source: 'remote',
      requestedAt: at(0),
      startedAt: at(0),
      timeline: [],
      samples: [
        { at: at(10), seq: 1, energyWh: 1200, powerW: 7200, offeredW: 11000, socPercent: 32 },
        { at: at(20), seq: 2, energyWh: 2400, powerW: 7300, offeredW: 11000, socPercent: 34 },
      ],
      truth: [
        { at: at(20), socPercent: 34.6, energyWh: 2400, powerW: 7300, msUntilFull: 30 * 60_000 },
      ],
      states: [{ at: at(0), state: 'charging' }],
      costs: [],
    },
    summary: {
      stationId: 'SIM-201',
      n: 1,
      ocpp: '2.0.1',
      state: 'running',
      source: 'remote',
      requestedAt: at(0),
      energyWh: 2400,
      socPercent: 34,
    },
    estimate: {
      targetSoc: 100,
      targetFrom: 'default',
      taperSoc: 80,
      socPercent: 34,
      at: at(20),
      etaAt: at(70),
      msToTarget: 50 * 60_000,
    },
    truth: { at: at(20), socPercent: 34.6, msToTarget: 30 * 60_000, etaAt: at(50) },
    gap: { gapMs: 20 * 60_000, off: true },
    durations: { charging: 20 * 60_000, suspendedEV: 0, suspendedEVSE: 0, idle: 0 },
    price: { tariffId: 'reference', currency: 'NZD', items: [], exclTax: 0, tax: 0, inclTax: 0 },
  };

  it('shows the reported figures and the estimate, and the truth only when asked', async () => {
    const csms = text(
      await render(EnergyPanel, { detail, showTruth: false, now: T0 + 20 * 60_000 }),
    );
    expect(csms).toContain('Delivered reported 2.40 kWh');
    expect(csms).toContain('Power reported 7.3 kW');
    expect(csms).toContain('SoC reported 34 %');
    expect(csms).toContain('To 100 % (assumed) estimate');
    expect(csms).toContain('in 50 min');
    expect(csms).not.toContain('truth');
    const truth = text(
      await render(EnergyPanel, { detail, showTruth: true, now: T0 + 20 * 60_000 }),
    );
    expect(truth).toContain('truth 34.6 %');
    expect(truth).toContain('truth');
    expect(truth).toContain('in 30 min');
    expect(truth).toContain('the estimate is off by 20 min');
    expect(await render(EnergyPanel, { detail, showTruth: true, now: T0 })).toContain(
      'class="power truth"',
    );
  });

  it('says when times are wall-clock under an energy multiplier', async () => {
    const fast = { ...detail, energyMultiplier: 60 };
    const shown = text(
      await render(EnergyPanel, { detail: fast, showTruth: false, now: T0 + 20 * 60_000 }),
    );
    expect(shown).toContain('energy ×60: times are wall-clock');
    // 50 simulated minutes left at ×60 is 50 seconds.
    expect(shown).toContain('in 50 s');
  });

  it('sums up a finished session and says when there is no estimate', async () => {
    const finished: SessionDetail = {
      ...detail,
      session: {
        ...detail.session,
        state: 'finished',
        endedAt: at(30),
        stopReason: 'EVDisconnected',
      },
      estimate: { targetSoc: 100, targetFrom: 'default', taperSoc: 80, reason: 'no SoC reported' },
    };
    const shown = text(await render(EnergyPanel, { detail: finished, showTruth: false, now: T0 }));
    expect(shown).toContain('Total 2.40 kWh');
    expect(shown).toContain('Peak power 7.3 kW');
    expect(shown).toContain('SoC 32 % → 34 %');
    expect(shown).toContain('Stop reason EVDisconnected');
    const running = { ...finished, session: { ...finished.session, state: 'running' as const } };
    expect(
      text(await render(EnergyPanel, { detail: running, showTruth: false, now: T0 })),
    ).toContain('cannot estimate: no SoC reported');
  });
});

describe('the vehicle card', () => {
  it('lists every vehicle item with its source, availability and, on demand, the truth', async () => {
    const T0 = Date.parse('2026-11-15T10:00:00Z');
    const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
    const detail: SessionDetail = {
      session: {
        stationId: 'SIM-16',
        n: 1,
        ocpp: '1.6',
        state: 'running',
        source: 'local',
        requestedAt: at(0),
        startedAt: at(0),
        timeline: [],
        samples: [{ at: at(5), seq: 9, energyWh: 600, socPercent: 31 }],
        truth: [{ at: at(5), socPercent: 31.2, energyWh: 600, powerW: 7200 }],
        states: [],
        costs: [],
      },
      summary: {
        stationId: 'SIM-16',
        n: 1,
        ocpp: '1.6',
        state: 'running',
        source: 'local',
        requestedAt: at(0),
        energyWh: 600,
      },
      estimate: {
        targetSoc: 100,
        targetFrom: 'default',
        taperSoc: 80,
        reason: 'SoC has not risen enough',
      },
      durations: { charging: 0, suspendedEV: 0, suspendedEVSE: 0, idle: 0 },
      price: { tariffId: 'reference', currency: 'NZD', items: [], exclTax: 0, tax: 0, inclTax: 0 },
    };
    const ev = {
      soc: 31.2,
      profile: { capacityKWh: 40, initialSoc: 30, maxPowerW: 7400, phases: 1 },
    };
    const csms = await render(VehicleCard, { detail, version: '1.6', ev, showTruth: false });
    const shown = text(csms);
    expect(shown).toContain('State of charge 31 % reported');
    expect(shown).toContain('Battery capacity not in this version');
    expect(shown).toContain('Target / full SoC 100 % assumed estimate');
    expect(shown).not.toContain('truth');
    expect(csms).toContain('title="Open the frame it came from"');
    const withTruth = text(
      await render(VehicleCard, { detail, version: '1.6', ev, showTruth: true }),
    );
    expect(withTruth).toContain('truth 40 kWh');
    expect(withTruth).toContain('truth 31.2 %');
  });
});

describe('the price card', () => {
  const T0 = Date.parse('2026-11-15T10:00:00Z');
  const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
  const base: SessionDetail = {
    session: {
      stationId: 'SIM-201',
      n: 1,
      ocpp: '2.0.1',
      state: 'finished',
      source: 'remote',
      requestedAt: at(0),
      startedAt: at(0),
      endedAt: at(60),
      timeline: [],
      samples: [],
      truth: [],
      states: [],
      costs: [
        { at: at(30), seq: 20, totalCost: 2.1, from: 'CostUpdated' },
        { at: at(60), seq: 40, totalCost: 5.82, from: 'TransactionEventResponse' },
      ],
    },
    summary: {
      stationId: 'SIM-201',
      n: 1,
      ocpp: '2.0.1',
      state: 'finished',
      source: 'remote',
      requestedAt: at(0),
      energyWh: 12_000,
    },
    estimate: { targetSoc: 100, targetFrom: 'default', taperSoc: 80 },
    durations: { charging: 3_600_000, suspendedEV: 0, suspendedEVSE: 0, idle: 0 },
    price: {
      tariffId: 'reference',
      currency: 'NZD',
      items: [
        {
          part: 'fixedFee',
          quantity: 1,
          unit: 'session',
          unitPrice: 1,
          exclTax: 1,
          tax: 0,
          inclTax: 1,
          frames: [3],
        },
        {
          part: 'energy',
          quantity: 12,
          unit: 'kWh',
          unitPrice: 0.35,
          exclTax: 4.2,
          tax: 0.63,
          inclTax: 4.83,
          frames: [3, 39],
        },
      ],
      exclTax: 5.2,
      tax: 0.63,
      inclTax: 5.83,
    },
  };

  it('puts the CSMS cost next to the reference price, item by item', async () => {
    const shown = text(await render(PriceCard, { detail: base, version: '2.0.1' }));
    expect(shown).toContain('CSMS cost reported 5.82 NZD TransactionEventResponse');
    expect(shown).toContain('Reference price estimate 5.83 NZD 5.20 NZD + tax 0.63 NZD');
    expect(shown).toContain('The CSMS cost is 0.01 NZD below the reference price.');
    expect(shown).toContain('Energy 12 kWh 0.35 4.20 0.63 #3 #39');
    expect(shown).toContain('2 cost updates from the CSMS');
    const same = {
      ...base,
      session: {
        ...base.session,
        costs: [{ at: at(60), seq: 40, totalCost: 5.83, from: 'TransactionEventResponse' }],
      },
    };
    expect(text(await render(PriceCard, { detail: same, version: '2.0.1' }))).toContain(
      'The CSMS cost matches the reference price.',
    );
  });

  it('compares only once the session is over', async () => {
    const running = { ...base, session: { ...base.session, state: 'running' as const } };
    const shown = text(await render(PriceCard, { detail: running, version: '2.0.1' }));
    expect(shown).not.toContain('below the reference price');
    expect(shown).toContain('compared when the session ends');
  });

  it('says when the version has no cost messages or the CSMS sent none', async () => {
    const none = { ...base, session: { ...base.session, costs: [] } };
    expect(text(await render(PriceCard, { detail: none, version: '1.6' }))).toContain(
      'OCPP 1.6 has no cost messages',
    );
    expect(text(await render(PriceCard, { detail: none, version: '2.0.1' }))).toContain(
      'the CSMS sent no cost',
    );
  });
});

describe('the session log', () => {
  it('shows the session frames with answers and log lines, and the export link', async () => {
    const at = (ms: number) => new Date(Date.parse('2026-11-15T10:00:00Z') + ms).toISOString();
    const frames = [
      {
        kind: 'frame' as const,
        seq: 1,
        stationId: 'SIM',
        at: at(0),
        direction: 'csms-to-cp' as const,
        messageType: 2 as const,
        uniqueId: 'r',
        action: 'RequestStartTransaction',
        payload: { remoteStartId: 1 },
        ocpp: '2.0.1' as const,
        text: '[2]',
      },
      {
        kind: 'frame' as const,
        seq: 2,
        stationId: 'SIM',
        at: at(40),
        direction: 'cp-to-csms' as const,
        messageType: 3 as const,
        uniqueId: 'r',
        action: 'RequestStartTransaction',
        payload: { status: 'Accepted' },
        ocpp: '2.0.1' as const,
        text: '[3]',
      },
    ];
    const html = await render(SessionLog, {
      frames,
      sessionLogLines: [
        { kind: 'log', seq: 3, stationId: 'SIM', at: at(500), message: 'connection open' },
      ],
      stationFrames: [],
      stationLogLines: [],
      exportUrl: '/api/stations/SIM/sessions/1/frames?format=jsonl',
      exportName: 'SIM-session-1.jsonl',
    });
    const shown = text(html);
    expect(shown).toContain('CSMS → CP 2.0.1 RequestStartTransaction');
    expect(shown).toContain('40 ms');
    expect(shown).toContain('connection open');
    expect(html).toContain('href="/api/stations/SIM/sessions/1/frames?format=jsonl"');
    expect(shown).toContain('This session Whole station');
  });
});

describe('the 2.1 views', () => {
  const station21: StationSnapshot = { ...station201, id: 'SIM-21', ocpp: '2.1' };
  const persona21 = {
    id: 'pay-2.1',
    ocpp: '2.1' as const,
    features: ['Core', 'TariffAndCost', 'Payment', 'WebPayments'],
    connectors: 2,
    faults: [],
    evs: {},
    warnings: [],
  };

  it('offers the payment terminal, priority charging and the payment URL on a 2.1 station', async () => {
    const html = await render(StationDetail, { station: station21, persona: persona21 });
    const shown = text(html);
    expect(shown).toContain('OCPP 2.1');
    expect(html).toContain('aria-label="Card brand"');
    expect(shown).toContain('Pay by card');
    expect(shown).toContain('Stop payment');
    expect(shown).toContain('Priority on');
    expect(shown).toContain('Payment URL');
    // The virtual display (I01 to I06).
    const showing = {
      ...station21,
      connectors: station21.connectors.map((c, i) =>
        i === 0
          ? {
              ...c,
              display: { at: '2026-11-16T10:00:00Z', kind: 'totalCost', text: 'Total 4.50 EUR' },
            }
          : c,
      ),
    };
    expect(text(await render(StationDetail, { station: showing, persona: persona21 }))).toContain(
      'Display Total 4.50 EUR',
    );
    // Without the feature groups only priority charging is left; 2.0.1 has none of it.
    const plain = text(
      await render(StationDetail, {
        station: station21,
        persona: { ...persona21, features: ['Core'] },
      }),
    );
    expect(plain).not.toContain('Pay by card');
    expect(plain).not.toContain('Payment URL');
    expect(plain).toContain('Priority on');
    expect(
      text(await render(StationDetail, { station: station201, persona: undefined })),
    ).not.toContain('Priority on');
  });

  it("puts the station's own cost next to the CSMS cost and the reference price", async () => {
    const T0 = Date.parse('2026-11-16T10:00:00Z');
    const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
    const detail: SessionDetail = {
      session: {
        stationId: 'SIM-21',
        n: 1,
        ocpp: '2.1',
        state: 'finished',
        source: 'payment',
        requestedAt: at(0),
        startedAt: at(0),
        endedAt: at(30),
        timeline: [],
        samples: [],
        truth: [],
        states: [],
        costs: [{ at: at(30), seq: 40, totalCost: 4.8, from: 'TransactionEventResponse' }],
        stationCost: {
          at: at(30),
          seq: 39,
          totalCost: 4.83,
          currency: 'NZD',
          typeOfCost: 'NormalCost',
          final: true,
        },
        limits: { at: at(0), seq: 3, maxCost: 50, maxEnergy: 20_000 },
        settlement: {
          at: at(31),
          seq: 41,
          pspRef: 'psp-1',
          status: 'Settled',
          amount: 4.83,
          receiptUrl: 'https://receipts.example.com/R-1',
        },
      },
      summary: {
        stationId: 'SIM-21',
        n: 1,
        ocpp: '2.1',
        state: 'finished',
        source: 'payment',
        requestedAt: at(0),
        energyWh: 12_000,
      },
      estimate: { targetSoc: 100, targetFrom: 'default', taperSoc: 80 },
      durations: { charging: 1_800_000, suspendedEV: 0, suspendedEVSE: 0, idle: 0 },
      price: {
        tariffId: 'reference',
        currency: 'NZD',
        items: [],
        exclTax: 4.2,
        tax: 0.63,
        inclTax: 4.83,
      },
    };
    const price = text(await render(PriceCard, { detail, version: '2.1' }));
    expect(price).toContain('CSMS cost reported 4.80 NZD');
    expect(price).toContain('Station cost reported 4.83 NZD costDetails, final');
    expect(price).toContain('Reference price estimate 4.83 NZD');
    const header = text(
      await render(SessionHeader, { detail, version: '2.1', now: T0 + 3_600_000 }),
    );
    expect(header).toContain('Payment');
    expect(header).toContain('Limits 50.00 NZD, 20.0 kWh');
    expect(header).toContain('Settlement Settled 4.83 receipt');
  });
});
