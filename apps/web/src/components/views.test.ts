/**
 * Component tests: the 2.0.1 views rendered to HTML with Vue's server
 * renderer, from the props the app gives them.
 */
import { describe, expect, it } from 'vitest';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { DeviceModelEntry, RecordEntry, StationSnapshot, StationSummary } from '../api.js';
import DeviceModelBrowser from './DeviceModelBrowser.vue';
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

  it('marks 2.0.1 stations in the list', async () => {
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
        connectors: [{ connectorId: 1, status: 'Occupied' }],
      },
    ];
    const shown = text(
      await render(StationList, { stations, personas: [], selectedId: undefined }),
    );
    expect(shown).toContain('SIM-1 Accepted');
    expect(shown).toContain('SIM-2 2.0.1 Charging 1');
  });
});
