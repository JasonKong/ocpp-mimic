import { describe, expect, it } from 'vitest';
import type { DeviceModelEntry, FrameRecord } from './api.js';
import {
  formatEnergy,
  formatPower,
  groupDeviceModel,
  messageTypeLabel,
  statusTone,
  summarize,
  transactionEvents,
} from './format.js';

const frame = (fields: Partial<FrameRecord>): FrameRecord => ({
  kind: 'frame',
  seq: 1,
  stationId: 'SIM-1',
  at: '2026-11-14T10:00:00.000Z',
  direction: 'cp-to-csms',
  text: '',
  ...fields,
});

describe('message summaries', () => {
  it('summarizes the common calls', () => {
    expect(
      summarize(
        frame({
          messageType: 2,
          action: 'StatusNotification',
          payload: { connectorId: 1, status: 'Faulted', errorCode: 'GroundFailure' },
        }),
      ),
    ).toBe('connector 1 → Faulted (GroundFailure)');
    expect(
      summarize(
        frame({
          messageType: 2,
          action: 'StopTransaction',
          payload: { transactionId: 7, reason: 'Remote', meterStop: 1520 },
        }),
      ),
    ).toBe('tx 7 · Remote · 1520 Wh');
    expect(
      summarize(
        frame({
          messageType: 2,
          action: 'MeterValues',
          payload: {
            connectorId: 1,
            meterValue: [{ timestamp: '', sampledValue: [{ value: '123', unit: 'Wh' }] }],
          },
        }),
      ),
    ).toBe('123 Wh');
  });

  it('summarizes results and errors', () => {
    expect(
      summarize(
        frame({
          messageType: 3,
          action: 'StartTransaction',
          payload: { transactionId: 3, idTagInfo: { status: 'Accepted' } },
        }),
      ),
    ).toBe('tx 3 · idTag Accepted');
    expect(
      summarize(
        frame({ messageType: 4, payload: { errorCode: 'NotSupported', errorDescription: 'no' } }),
      ),
    ).toBe('NotSupported no');
    expect(messageTypeLabel(frame({ messageType: 4 }))).toBe('ERROR');
    expect(messageTypeLabel(frame({}))).toBe('INVALID');
  });
});

describe('units', () => {
  it('formats energy and power', () => {
    expect([formatEnergy(950), formatEnergy(12_345)]).toEqual(['950 Wh', '12.35 kWh']);
    expect([formatPower(500), formatPower(7360)]).toEqual(['500 W', '7.4 kW']);
  });
});

describe('OCPP 2.0.1 views', () => {
  const event = (seq: number, payload: Record<string, unknown>): FrameRecord =>
    frame({ seq, messageType: 2, action: 'TransactionEvent', payload });

  it('summarizes 2.0.1 messages', () => {
    expect(
      summarize(
        frame({
          messageType: 2,
          action: 'StatusNotification',
          payload: { evseId: 2, connectorId: 1, connectorStatus: 'Occupied' },
        }),
      ),
    ).toBe('EVSE 2/1 → Occupied');
    expect(
      summarize(
        event(1, {
          eventType: 'Ended',
          seqNo: 3,
          triggerReason: 'StopAuthorized',
          transactionInfo: {
            transactionId: 'tx-1',
            chargingState: 'EVConnected',
            stoppedReason: 'Local',
          },
        }),
      ),
    ).toBe('Ended #3 · StopAuthorized · EVConnected · Local');
    expect(
      summarize(
        frame({
          messageType: 2,
          action: 'Authorize',
          payload: { idToken: { idToken: 'TAG-1', type: 'ISO14443' } },
        }),
      ),
    ).toBe('TAG-1');
    expect(
      summarize(
        frame({
          messageType: 2,
          direction: 'csms-to-cp',
          action: 'SetVariables',
          payload: {
            setVariableData: [
              {
                component: { name: 'OCPPCommCtrlr' },
                variable: { name: 'HeartbeatInterval' },
                attributeValue: '60',
              },
            ],
          },
        }),
      ),
    ).toBe('OCPPCommCtrlr.HeartbeatInterval = 60');
    expect(
      summarize(frame({ messageType: 3, payload: { idTokenInfo: { status: 'Accepted' } } })),
    ).toBe('idToken Accepted');
  });

  it('lists the TransactionEvents a station sent, optionally of one EVSE', () => {
    const entries = [
      event(1, {
        eventType: 'Started',
        seqNo: 0,
        triggerReason: 'CablePluggedIn',
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken: 'TAG-1', type: 'ISO14443' },
        transactionInfo: { transactionId: 'tx-1', chargingState: 'Charging' },
      }),
      frame({ seq: 2, messageType: 3, action: 'TransactionEvent', payload: {} }),
      event(3, {
        eventType: 'Started',
        seqNo: 0,
        triggerReason: 'Authorized',
        offline: true,
        evse: { id: 2, connectorId: 1 },
        transactionInfo: { transactionId: 'tx-2', chargingState: 'EVConnected' },
      }),
    ];
    expect(transactionEvents(entries)).toHaveLength(2);
    expect(transactionEvents(entries, 1)).toEqual([
      {
        seq: 1,
        at: '2026-11-14T10:00:00.000Z',
        evseId: 1,
        transactionId: 'tx-1',
        seqNo: 0,
        eventType: 'Started',
        triggerReason: 'CablePluggedIn',
        chargingState: 'Charging',
        idToken: 'TAG-1',
        offline: false,
      },
    ]);
    expect(transactionEvents(entries, 2)[0]?.offline).toBe(true);
  });

  it('groups the Device Model by component and filters it', () => {
    const v = (component: string, variable: string, value?: string): DeviceModelEntry => ({
      component,
      variable,
      dataType: 'string',
      attributes: [
        { type: 'Actual', mutability: 'ReadOnly', ...(value !== undefined && { value }) },
      ],
    });
    const variables = [
      v('EVSE@2', 'Power'),
      v('Connector@1.1', 'ConnectorType', 'cType2'),
      v('OCPPCommCtrlr', 'HeartbeatInterval', '300'),
      v('EVSE@1', 'Power'),
      v('AuthCtrlr', 'Enabled', 'true'),
    ];
    expect(groupDeviceModel(variables).map((g) => g.component)).toEqual([
      'AuthCtrlr',
      'OCPPCommCtrlr',
      // An EVSE, then its connectors.
      'EVSE@1',
      'Connector@1.1',
      'EVSE@2',
    ]);
    expect(groupDeviceModel(variables, 'heart').map((g) => g.component)).toEqual(['OCPPCommCtrlr']);
    expect(groupDeviceModel(variables, 'ctype2')[0]?.variables[0]?.variable).toBe('ConnectorType');
  });

  it('gives 2.0.1 statuses and charging states a tone', () => {
    expect(
      ['Occupied', 'Reserved', 'SuspendedEVSE', 'Charging', 'Faulted', 'Available'].map(statusTone),
    ).toEqual(['warn', 'warn', 'warn', 'good', 'bad', '']);
  });
});
