import { describe, expect, it } from 'vitest';
import { createConfig } from './config.js';
import { createMeter, withPower } from './meter.js';
import { validateRequest } from './ocpp16-messages.js';
import {
  applyStartResponse,
  meterValuesRequest,
  startTransaction,
  stopTransactionRequest,
} from './transaction.js';

const T0 = Date.parse('2026-11-14T10:00:00Z');
const HOUR = 3_600_000;
const config = createConfig({ numberOfConnectors: 1 });
const charging = withPower(createMeter({ now: T0, energyWh: 1000 }), T0, 7000);

describe('starting a transaction', () => {
  it('builds a valid StartTransaction request from the meter', () => {
    const { transaction, request } = startTransaction({
      connectorId: 1,
      idTag: 'TAG-1',
      meter: charging,
      config,
      now: T0,
    });
    expect(request).toEqual({
      connectorId: 1,
      idTag: 'TAG-1',
      meterStart: 1000,
      timestamp: '2026-11-14T10:00:00.000Z',
    });
    expect(validateRequest('StartTransaction', request).ok).toBe(true);
    expect(transaction).toMatchObject({ connectorId: 1, startedAt: T0, meterStartWh: 1000 });
    expect(transaction.transactionId).toBeUndefined();
  });

  it('continues when accepted, and stops or suspends otherwise per StopTransactionOnInvalidId', () => {
    const { transaction } = startTransaction({
      connectorId: 1,
      idTag: 'T',
      meter: charging,
      config,
      now: T0,
    });
    const accepted = applyStartResponse(
      transaction,
      { transactionId: 42, idTagInfo: { status: 'Accepted' } },
      config,
      T0,
    );
    expect(accepted).toMatchObject({ decision: 'continue', transaction: { transactionId: 42 } });

    const blocked = { transactionId: 43, idTagInfo: { status: 'Blocked' as const } };
    expect(applyStartResponse(transaction, blocked, config, T0).decision).toBe('stop');
    const lenient = createConfig({
      numberOfConnectors: 1,
      values: { StopTransactionOnInvalidId: 'false' },
    });
    expect(applyStartResponse(transaction, blocked, lenient, T0).decision).toBe('suspend');

    const expired = {
      transactionId: 44,
      idTagInfo: { status: 'Accepted' as const, expiryDate: '2026-11-13T00:00:00Z' },
    };
    expect(applyStartResponse(transaction, expired, config, T0).decision).toBe('stop');
  });
});

describe('stopping a transaction', () => {
  const started = startTransaction({
    connectorId: 1,
    idTag: 'T',
    meter: charging,
    config,
    now: T0,
  });
  const { transaction } = applyStartResponse(
    started.transaction,
    { transactionId: 42, idTagInfo: { status: 'Accepted' } },
    config,
    T0,
  );

  it('reports meterStop, reason and the Begin / End samples of StopTxnSampledData', () => {
    const request = stopTransactionRequest({
      transaction,
      meter: charging,
      config,
      now: T0 + HOUR,
      reason: 'Remote',
    });
    expect(validateRequest('StopTransaction', request).ok).toBe(true);
    expect(request).toMatchObject({ transactionId: 42, meterStop: 8000, reason: 'Remote' });
    expect(
      request.transactionData?.map((v) => [v.sampledValue[0]?.context, v.sampledValue[0]?.value]),
    ).toEqual([
      ['Transaction.Begin', '1000'],
      ['Transaction.End', '8000'],
    ]);
  });

  it('includes the stopping idTag and leaves out transactionData when StopTxnSampledData is empty', () => {
    const plain = createConfig({ numberOfConnectors: 1, values: { StopTxnSampledData: '' } });
    const { transaction: plainTx } = applyStartResponse(
      startTransaction({ connectorId: 1, idTag: 'T', meter: charging, config: plain, now: T0 })
        .transaction,
      { transactionId: 7, idTagInfo: { status: 'Accepted' } },
      plain,
      T0,
    );
    const request = stopTransactionRequest({
      transaction: plainTx,
      meter: charging,
      config: plain,
      now: T0 + HOUR,
      reason: 'Local',
      idTag: 'T',
    });
    expect(request.idTag).toBe('T');
    expect(request.transactionData).toBeUndefined();
  });

  it('refuses to stop a transaction the CSMS has not given an id', () => {
    expect(() =>
      stopTransactionRequest({
        transaction: started.transaction,
        meter: charging,
        config,
        now: T0,
        reason: 'Local',
      }),
    ).toThrow(/has not given an id/);
  });
});

describe('MeterValues', () => {
  it('builds a valid request from the configured measurands', () => {
    const request = meterValuesRequest({
      connectorId: 1,
      meter: charging,
      config,
      now: T0 + HOUR / 4,
      configKey: 'MeterValuesSampledData',
      context: 'Sample.Periodic',
      transactionId: 42,
    });
    expect(request).toBeDefined();
    expect(validateRequest('MeterValues', request).ok).toBe(true);
    expect(request?.meterValue[0]?.sampledValue[0]).toMatchObject({
      value: '2750',
      context: 'Sample.Periodic',
    });
  });

  it('returns nothing when no configured measurand can be sampled', () => {
    const socOnly = createConfig({
      numberOfConnectors: 1,
      values: { MeterValuesSampledData: 'SoC' },
    });
    expect(
      meterValuesRequest({
        connectorId: 1,
        meter: charging,
        config: socOnly,
        now: T0,
        configKey: 'MeterValuesSampledData',
        context: 'Sample.Periodic',
      }),
    ).toBeUndefined();
  });
});
