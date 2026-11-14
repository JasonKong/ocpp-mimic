import { describe, expect, it } from 'vitest';
import {
  CHARGE_POINT_ACTIONS,
  CSMS_ACTIONS,
  OCPP16_MESSAGES,
  isOcpp16Action,
  validateRequest,
  validateResponse,
  type RequestOf,
} from './ocpp16-messages.js';

describe('OCPP 1.6 message definitions', () => {
  it('lists every defined action in its direction (DataTransfer in both)', () => {
    const defined = Object.keys(OCPP16_MESSAGES).sort();
    expect([...new Set([...CHARGE_POINT_ACTIONS, ...CSMS_ACTIONS])].sort()).toEqual(defined);
    expect(CHARGE_POINT_ACTIONS.length + CSMS_ACTIONS.length).toBe(defined.length + 1);
    expect(isOcpp16Action('BootNotification')).toBe(true);
    expect(isOcpp16Action('UpdateFirmware')).toBe(false);
    expect(isOcpp16Action('toString')).toBe(false);
  });

  it('validates BootNotification', () => {
    expect(
      validateRequest('BootNotification', {
        chargePointVendor: 'VendorX',
        chargePointModel: 'AC-7',
        firmwareVersion: '2.5.0',
      }).ok,
    ).toBe(true);
    expect(validateRequest('BootNotification', { chargePointVendor: 'VendorX' })).toMatchObject({
      ok: false,
      errorCode: 'OccurenceConstraintViolation',
    });
    expect(
      validateRequest('BootNotification', {
        chargePointVendor: 'A vendor name that is far too long',
        chargePointModel: 'AC-7',
      }),
    ).toMatchObject({ ok: false, errorCode: 'PropertyConstraintViolation' });
    expect(
      validateResponse('BootNotification', {
        status: 'Pending',
        currentTime: '2026-11-14T10:00:00.000Z',
        interval: 60,
      }).ok,
    ).toBe(true);
  });

  it('validates StatusNotification', () => {
    const valid: RequestOf<'StatusNotification'> = {
      connectorId: 0,
      errorCode: 'NoError',
      status: 'Available',
      timestamp: '2026-11-14T10:00:00Z',
    };
    expect(validateRequest('StatusNotification', valid).ok).toBe(true);
    expect(validateRequest('StatusNotification', { ...valid, status: 'Offline' })).toMatchObject({
      ok: false,
      errorCode: 'PropertyConstraintViolation',
    });
    expect(validateRequest('StatusNotification', { ...valid, connectorId: '1' })).toMatchObject({
      ok: false,
      errorCode: 'TypeConstraintViolation',
    });
  });

  it('validates MeterValues with nested sampled values', () => {
    const request = {
      connectorId: 1,
      transactionId: 42,
      meterValue: [
        {
          timestamp: '2026-11-14T10:05:00Z',
          sampledValue: [
            { value: '1520', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
            { value: '21.5', measurand: 'Temperature', unit: 'Celsius', location: 'Body' },
          ],
        },
      ],
    };
    expect(validateRequest('MeterValues', request).ok).toBe(true);
    expect(
      validateRequest('MeterValues', {
        ...request,
        meterValue: [{ ...request.meterValue[0], sampledValue: [] }],
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ path: '$.meterValue[0].sampledValue', errorCode: 'OccurenceConstraintViolation' }],
    });
  });

  it('accepts RemoteStartTransaction with a charging profile', () => {
    expect(
      validateRequest('RemoteStartTransaction', {
        idTag: 'TAG-1',
        connectorId: 1,
        chargingProfile: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Relative',
          chargingSchedule: {
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
          },
        },
      }).ok,
    ).toBe(true);
  });

  it('rejects unknown fields the way the 1.6 schemas do', () => {
    expect(validateRequest('Reset', { type: 'Hard', delay: 5 })).toMatchObject({
      ok: false,
      errorCode: 'FormationViolation',
    });
  });

  it('accepts empty payloads where the spec defines none', () => {
    expect(validateRequest('Heartbeat', {}).ok).toBe(true);
    expect(validateResponse('StatusNotification', {}).ok).toBe(true);
    expect(validateResponse('StopTransaction', {}).ok).toBe(true);
  });
});
