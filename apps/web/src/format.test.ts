import { describe, expect, it } from 'vitest';
import type { FrameRecord } from './api.js';
import { formatEnergy, formatPower, messageTypeLabel, summarize } from './format.js';

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
