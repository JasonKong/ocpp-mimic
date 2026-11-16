import { describe, expect, it } from 'vitest';
import {
  evseLabel,
  isCharging,
  unavailable,
  VEHICLE_FIELD_LABELS,
  VEHICLE_FIELDS,
  VERSIONS,
  versionInfo,
} from './versions.js';

describe('version capability table', () => {
  it('describes every vehicle field for every version', () => {
    for (const info of Object.values(VERSIONS)) {
      expect(Object.keys(info.vehicle).sort()).toEqual([...VEHICLE_FIELDS].sort());
      for (const field of VEHICLE_FIELDS) expect(info.vehicle[field].note).not.toBe('');
    }
    expect(Object.keys(VEHICLE_FIELD_LABELS).sort()).toEqual([...VEHICLE_FIELDS].sort());
  });

  it('names things as each version does', () => {
    expect(versionInfo('1.6').terms).toEqual({
      evse: 'Connector',
      token: 'idTag',
      transactionId: 'number',
    });
    expect(versionInfo('2.0.1').terms).toEqual({
      evse: 'EVSE',
      token: 'idToken',
      transactionId: 'string',
    });
    expect(evseLabel('1.6', 2)).toBe('Connector 2');
    expect(evseLabel('2.0.1', 2)).toBe('EVSE 2 · connector 1');
    expect([versionInfo('1.6').remoteStartId, versionInfo('2.0.1').remoteStartId]).toEqual([
      false,
      true,
    ]);
    expect([versionInfo('1.6').totalCost, versionInfo('2.0.1').totalCost]).toEqual([false, true]);
    // 2.1 is 2.0.1's terms, a station that prices sessions itself, and the ISO 15118-20 data.
    expect(versionInfo('2.1')).toMatchObject({
      label: 'OCPP 2.1',
      tone: 'v21',
      terms: versionInfo('2.0.1').terms,
      tariffs: true,
    });
    expect(unavailable('2.1', 'timeToTarget')).toBeUndefined();
    expect(unavailable('2.0.1', 'timeToTarget')).toBeDefined();
  });

  it('counts 1.6 statuses and 2.0.1 charging states as charging', () => {
    expect(isCharging('1.6', { status: 'Charging' })).toBe(true);
    expect(isCharging('1.6', { status: 'SuspendedEVSE' })).toBe(true);
    expect(isCharging('1.6', { status: 'Preparing' })).toBe(false);
    expect(isCharging('2.0.1', { status: 'Occupied', chargingState: 'SuspendedEV' })).toBe(true);
    expect(isCharging('2.0.1', { status: 'Occupied', chargingState: 'EVConnected' })).toBe(false);
    expect(isCharging('2.0.1', { status: 'Occupied' })).toBe(false);
  });

  it('says what a version cannot carry', () => {
    expect(unavailable('1.6', 'capacity')).toBe('not in this version');
    expect(unavailable('2.0.1', 'capacity')).toBeUndefined();
    expect(unavailable('2.0.1', 'timeToTarget')).toBe('not in this version');
    expect(unavailable('1.6', 'evLimits')).toContain('actual current');
  });
});
