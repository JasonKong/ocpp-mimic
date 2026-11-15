import { describe, expect, it } from 'vitest';
import { OCPP201_RPC_ERROR_CODES, OCPP201_SUBPROTOCOL } from './constants.js';
import {
  OCPP201_CHARGING_STATION_ACTIONS,
  OCPP201_CSMS_ACTIONS,
  OCPP201_MESSAGES,
  isOcpp201Action,
  validateOcpp201Request,
  validateOcpp201Response,
  type Ocpp201RequestOf,
} from './messages.js';

describe('OCPP 2.0.1 message definitions', () => {
  it('define all 64 actions, each in its direction (DataTransfer in both)', () => {
    const defined = Object.keys(OCPP201_MESSAGES).sort();
    expect(defined).toHaveLength(64);
    expect(
      [...new Set([...OCPP201_CHARGING_STATION_ACTIONS, ...OCPP201_CSMS_ACTIONS])].sort(),
    ).toEqual(defined);
    expect(OCPP201_CHARGING_STATION_ACTIONS).toHaveLength(25);
    expect(OCPP201_CSMS_ACTIONS).toHaveLength(40);
    expect(isOcpp201Action('TransactionEvent')).toBe(true);
    expect(isOcpp201Action('StartTransaction')).toBe(false);
    expect(isOcpp201Action('hasOwnProperty')).toBe(false);
    expect(OCPP201_SUBPROTOCOL).toBe('ocpp2.0.1');
    expect(OCPP201_RPC_ERROR_CODES).toContain('FormatViolation');
    expect(OCPP201_RPC_ERROR_CODES).not.toContain('FormationViolation');
  });

  it('validate a BootNotification and its answer', () => {
    const boot: Ocpp201RequestOf<'BootNotification'> = {
      reason: 'PowerUp',
      chargingStation: { model: 'AC-7', vendorName: 'VendorX', serialNumber: 'SN-1' },
    };
    expect(validateOcpp201Request('BootNotification', boot).ok).toBe(true);
    expect(validateOcpp201Request('BootNotification', { ...boot, reason: 'Booted' })).toMatchObject(
      { ok: false, errorCode: 'PropertyConstraintViolation' },
    );
    expect(
      validateOcpp201Response('BootNotification', {
        currentTime: '2026-11-15T10:00:00Z',
        interval: 300,
        status: 'Accepted',
      }).ok,
    ).toBe(true);
  });

  it('validate a TransactionEvent with meter values', () => {
    const event: Ocpp201RequestOf<'TransactionEvent'> = {
      eventType: 'Started',
      timestamp: '2026-11-15T10:00:00Z',
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-1', chargingState: 'EVConnected' },
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
      evse: { id: 1, connectorId: 1 },
      meterValue: [
        {
          timestamp: '2026-11-15T10:00:00Z',
          sampledValue: [
            { value: 0, context: 'Transaction.Begin', measurand: 'Energy.Active.Import.Register' },
          ],
        },
      ],
    };
    expect(validateOcpp201Request('TransactionEvent', event).ok).toBe(true);
    // A transactionId longer than identifierString[0..36].
    expect(
      validateOcpp201Request('TransactionEvent', {
        ...event,
        transactionInfo: { transactionId: 'x'.repeat(37) },
      }),
    ).toMatchObject({ ok: false, errorCode: 'PropertyConstraintViolation' });
  });

  it('limit arrays to their cardinality and use the 2.0.1 error code spellings', () => {
    const variable = {
      component: { name: 'OCPPCommCtrlr' },
      variable: { name: 'HeartbeatInterval' },
    };
    expect(validateOcpp201Request('GetVariables', { getVariableData: [variable] }).ok).toBe(true);
    expect(validateOcpp201Request('GetVariables', { getVariableData: [] })).toMatchObject({
      ok: false,
      errorCode: 'OccurrenceConstraintViolation',
    });
    // CertificateHashDataChainType.childCertificateHashData is 0..4.
    const hash = {
      hashAlgorithm: 'SHA256',
      issuerNameHash: 'a',
      issuerKeyHash: 'b',
      serialNumber: '1',
    };
    const chain = (children: number) => ({
      status: 'Accepted',
      certificateHashDataChain: [
        {
          certificateType: 'CSMSRootCertificate',
          certificateHashData: hash,
          childCertificateHashData: Array.from({ length: children }, () => hash),
        },
      ],
    });
    expect(validateOcpp201Response('GetInstalledCertificateIds', chain(4)).ok).toBe(true);
    expect(validateOcpp201Response('GetInstalledCertificateIds', chain(5))).toMatchObject({
      ok: false,
      errorCode: 'OccurrenceConstraintViolation',
    });
    expect(validateOcpp201Request('Heartbeat', { unexpected: true })).toMatchObject({
      ok: false,
      errorCode: 'FormatViolation',
      issues: [{ path: '$.unexpected', errorCode: 'FormatViolation' }],
    });
  });

  it('accept customData on every class and any value in DataTransfer data', () => {
    expect(
      validateOcpp201Request('StatusNotification', {
        timestamp: '2026-11-15T10:00:00Z',
        connectorStatus: 'Occupied',
        evseId: 1,
        connectorId: 1,
        customData: { vendorId: 'acme', temperature: 41 },
      }).ok,
    ).toBe(true);
    expect(validateOcpp201Request('Heartbeat', { customData: { temperature: 41 } })).toMatchObject({
      ok: false,
      errorCode: 'OccurrenceConstraintViolation',
    });
    for (const data of [{ a: [1, 2] }, 'text', 42, null]) {
      expect(validateOcpp201Request('DataTransfer', { vendorId: 'acme', data }).ok).toBe(true);
    }
  });
});
