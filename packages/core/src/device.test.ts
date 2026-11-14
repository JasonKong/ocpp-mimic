import { describe, expect, it } from 'vitest';
import {
  createStation,
  findConnector,
  reduce,
  type DeviceEvent,
  type StationState,
  type StatusNotificationRequest,
} from './device.js';

const T0 = Date.parse('2026-11-14T10:00:00Z');

/** Applies events in order and returns the final state and every message sent on the way. */
function run(events: DeviceEvent[], station: StationState = createStation(2)) {
  const sent: StatusNotificationRequest[][] = [];
  let state = station;
  events.forEach((event, index) => {
    const result = reduce(state, event, T0 + index * 1000);
    expect(result.error).toBeUndefined();
    state = result.state;
    sent.push(result.messages);
  });
  return { state, sent };
}

/** `connectorId:status` for each message, for compact assertions. */
const statuses = (messages: StatusNotificationRequest[]) =>
  messages.map((m) => `${m.connectorId}:${m.status}`);

describe('device model', () => {
  it('builds one EVSE per connector, matching OCPP 1.6 connectorIds', () => {
    const station = createStation(2);
    expect(station.evses.map((evse) => [evse.id, evse.connectors[0]?.connectorId])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(() => createStation(0)).toThrow(RangeError);
  });

  it('reports connectorId 0 and every connector on ReportAll, with timestamps', () => {
    const { sent } = run([{ type: 'ReportAll' }]);
    expect(sent[0]).toEqual([
      {
        connectorId: 0,
        status: 'Available',
        errorCode: 'NoError',
        timestamp: '2026-11-14T10:00:00.000Z',
      },
      {
        connectorId: 1,
        status: 'Available',
        errorCode: 'NoError',
        timestamp: '2026-11-14T10:00:00.000Z',
      },
      {
        connectorId: 2,
        status: 'Available',
        errorCode: 'NoError',
        timestamp: '2026-11-14T10:00:00.000Z',
      },
    ]);
  });

  it('walks a normal session: Preparing, Charging, Finishing, Available', () => {
    const { sent } = run([
      { type: 'ReportAll' },
      { type: 'Plug', connectorId: 1 },
      { type: 'TransactionStarted', connectorId: 1, transactionId: 7 },
      { type: 'TransactionEnded', connectorId: 1 },
      { type: 'Unplug', connectorId: 1 },
    ]);
    expect(sent.slice(1).map(statuses)).toEqual([
      ['1:Preparing'],
      ['1:Charging'],
      ['1:Finishing'],
      ['1:Available'],
    ]);
  });

  it('goes to Preparing when authorized before the cable is plugged, and back when cancelled', () => {
    const { sent } = run([
      { type: 'ReportAll' },
      { type: 'Prepare', connectorId: 1 },
      { type: 'CancelPrepare', connectorId: 1 },
    ]);
    expect(sent.slice(1).map(statuses)).toEqual([['1:Preparing'], ['1:Available']]);
  });

  it('reports EV and EVSE suspension during a transaction', () => {
    const { sent } = run([
      { type: 'ReportAll' },
      { type: 'Plug', connectorId: 1 },
      { type: 'TransactionStarted', connectorId: 1, transactionId: 1 },
      { type: 'EvSuspend', connectorId: 1 },
      { type: 'EvResume', connectorId: 1 },
      { type: 'EvseSuspend', connectorId: 1 },
      { type: 'EvseResume', connectorId: 1 },
    ]);
    expect(sent.slice(3).map(statuses)).toEqual([
      ['1:SuspendedEV'],
      ['1:Charging'],
      ['1:SuspendedEVSE'],
      ['1:Charging'],
    ]);
  });

  it('reports Finishing when the EV side disconnects mid-transaction, Available once it ends', () => {
    const { sent } = run([
      { type: 'ReportAll' },
      { type: 'Plug', connectorId: 1 },
      { type: 'TransactionStarted', connectorId: 1, transactionId: 1 },
      { type: 'Unplug', connectorId: 1 },
      { type: 'TransactionEnded', connectorId: 1 },
    ]);
    expect(sent.slice(3).map(statuses)).toEqual([['1:Finishing'], ['1:Available']]);
  });

  it('reports a connector fault with its error details and recovers to the derived status', () => {
    const { sent } = run([
      { type: 'ReportAll' },
      { type: 'Plug', connectorId: 1 },
      {
        type: 'FaultRaised',
        connectorId: 1,
        errorCode: 'GroundFailure',
        info: 'GND_FAULT',
        vendorErrorCode: 'E101',
      },
      { type: 'FaultCleared', connectorId: 1 },
    ]);
    expect(sent[2]).toEqual([
      {
        connectorId: 1,
        status: 'Faulted',
        errorCode: 'GroundFailure',
        info: 'GND_FAULT',
        vendorErrorCode: 'E101',
        timestamp: '2026-11-14T10:00:02.000Z',
      },
    ]);
    expect(statuses(sent[3] ?? [])).toEqual(['1:Preparing']);
  });

  it('faults every connector when the whole charge point faults', () => {
    const { sent } = run([
      { type: 'ReportAll' },
      { type: 'FaultRaised', connectorId: 0, errorCode: 'InternalError' },
      { type: 'FaultCleared', connectorId: 0 },
    ]);
    expect(statuses(sent[1] ?? [])).toEqual(['0:Faulted', '1:Faulted', '2:Faulted']);
    expect(statuses(sent[2] ?? [])).toEqual(['0:Available', '1:Available', '2:Available']);
  });

  it('applies ChangeAvailability at once on an idle connector', () => {
    const start = run([{ type: 'ReportAll' }]).state;
    const result = reduce(
      start,
      { type: 'ChangeAvailability', connectorId: 2, availability: 'Inoperative' },
      T0,
    );
    expect(result.changeAvailability).toBe('Accepted');
    expect(statuses(result.messages)).toEqual(['2:Unavailable']);
  });

  it('schedules ChangeAvailability during a transaction and applies it when the transaction ends', () => {
    const charging = run([
      { type: 'ReportAll' },
      { type: 'Plug', connectorId: 1 },
      { type: 'TransactionStarted', connectorId: 1, transactionId: 1 },
    ]).state;
    const change = reduce(
      charging,
      { type: 'ChangeAvailability', connectorId: 1, availability: 'Inoperative' },
      T0,
    );
    expect(change.changeAvailability).toBe('Scheduled');
    expect(change.messages).toEqual([]);
    const ended = reduce(change.state, { type: 'TransactionEnded', connectorId: 1 }, T0);
    expect(statuses(ended.messages)).toEqual(['1:Unavailable']);
    expect(findConnector(ended.state, 1)?.scheduledAvailability).toBeUndefined();
  });

  it('makes the whole charge point Unavailable through connectorId 0', () => {
    const start = run([{ type: 'ReportAll' }]).state;
    const result = reduce(
      start,
      { type: 'ChangeAvailability', connectorId: 0, availability: 'Inoperative' },
      T0,
    );
    expect(statuses(result.messages)).toEqual(['0:Unavailable', '1:Unavailable', '2:Unavailable']);
  });

  it('keeps connectors independent', () => {
    const { sent } = run([
      { type: 'ReportAll' },
      { type: 'Plug', connectorId: 2 },
      { type: 'TransactionStarted', connectorId: 2, transactionId: 9 },
      { type: 'Plug', connectorId: 1 },
    ]);
    expect(sent.slice(1).map(statuses)).toEqual([['2:Preparing'], ['2:Charging'], ['1:Preparing']]);
  });

  it('sends nothing when no status changes', () => {
    const start = run([{ type: 'ReportAll' }]).state;
    expect(reduce(start, { type: 'Lock', connectorId: 1 }, T0).messages).toEqual([]);
    expect(
      findConnector(reduce(start, { type: 'Lock', connectorId: 1 }, T0).state, 1)?.locked,
    ).toBe(true);
  });

  it('rejects events for unknown connectors and leaves the state alone', () => {
    const start = createStation(1);
    for (const event of [
      { type: 'Plug', connectorId: 3 },
      { type: 'Plug', connectorId: 0 },
    ] satisfies DeviceEvent[]) {
      const result = reduce(start, event, T0);
      expect(result.error).toMatch(/unknown connector/);
      expect(result.state).toBe(start);
      expect(result.messages).toEqual([]);
    }
  });
});
