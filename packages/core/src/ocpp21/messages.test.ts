import { describe, expect, it } from 'vitest';
import type { Ocpp201Action, Ocpp201RequestOf, Ocpp201ResponseOf } from '../ocpp201/messages.js';
import { OCPP201_MESSAGES } from '../ocpp201/messages.js';
import { OCPP21_ID_TOKEN_TYPES, OCPP21_SUBPROTOCOL } from './constants.js';
import {
  OCPP21_CHARGING_STATION_ACTIONS,
  OCPP21_CSMS_ACTIONS,
  OCPP21_MESSAGES,
  OCPP21_UNCONFIRMED_ACTIONS,
  isOcpp21Action,
  validateOcpp21Request,
  validateOcpp21Response,
  type Ocpp21RequestOf,
  type Ocpp21ResponseOf,
} from './messages.js';

/**
 * Actions whose 2.0.1 request (or response) type is not assignable to the 2.1
 * one. The only one is NotifyMonitoringReport: 2.1 made
 * VariableMonitoringType.eventNotificationType required (N02).
 */
type NarrowedRequests = {
  [
    A in Exclude<Ocpp201Action, 'NotifyMonitoringReport'>
  ]: Ocpp201RequestOf<A> extends Ocpp21RequestOf<A> ? never : A;
}[Exclude<Ocpp201Action, 'NotifyMonitoringReport'>];
type MonitoringReportWidens =
  Ocpp201RequestOf<'NotifyMonitoringReport'> extends Ocpp21RequestOf<'NotifyMonitoringReport'>
    ? true
    : false;
const monitoringReportNarrows: MonitoringReportWidens = false;
type NarrowedResponses = {
  [A in Ocpp201Action]: Ocpp201ResponseOf<A> extends Ocpp21ResponseOf<A> ? never : A;
}[Ocpp201Action];
const requestsWiden: [NarrowedRequests] extends [never] ? true : NarrowedRequests = true;
const responsesWiden: [NarrowedResponses] extends [never] ? true : NarrowedResponses = true;

const NEW_IN_21 = [
  'AFRRSignal',
  'AdjustPeriodicEventStream',
  'BatterySwap',
  'ChangeTransactionTariff',
  'ClearDERControl',
  'ClearTariffs',
  'ClosePeriodicEventStream',
  'GetCertificateChainStatus',
  'GetDERControl',
  'GetPeriodicEventStream',
  'GetTariffs',
  'NotifyAllowedEnergyTransfer',
  'NotifyDERAlarm',
  'NotifyDERStartStop',
  'NotifyPeriodicEventStream',
  'NotifyPriorityCharging',
  'NotifySettlement',
  'NotifyWebPaymentStarted',
  'OpenPeriodicEventStream',
  'PullDynamicScheduleUpdate',
  'ReportDERControl',
  'RequestBatterySwap',
  'SetDERControl',
  'SetDefaultTariff',
  'UpdateDynamicSchedule',
  'UsePriorityCharging',
  'VatNumberValidation',
];

describe('OCPP 2.1 message definitions', () => {
  it("define all 91 actions: 2.0.1's 64 and 27 new ones, each in its direction", () => {
    const defined = Object.keys(OCPP21_MESSAGES).sort();
    expect(defined).toHaveLength(91);
    expect(defined).toEqual([...Object.keys(OCPP201_MESSAGES), ...NEW_IN_21].sort());
    expect(
      [...new Set([...OCPP21_CHARGING_STATION_ACTIONS, ...OCPP21_CSMS_ACTIONS])].sort(),
    ).toEqual(defined);
    expect(OCPP21_CHARGING_STATION_ACTIONS).toHaveLength(37);
    expect(OCPP21_CSMS_ACTIONS).toHaveLength(55);
    expect(OCPP21_CHARGING_STATION_ACTIONS).toContain('NotifySettlement');
    expect(OCPP21_CSMS_ACTIONS).toContain('SetDefaultTariff');
    expect(OCPP21_UNCONFIRMED_ACTIONS).toEqual(['NotifyPeriodicEventStream']);
    expect(isOcpp21Action('PullDynamicScheduleUpdate')).toBe(true);
    expect(isOcpp21Action('StartTransaction')).toBe(false);
    expect(isOcpp21Action('hasOwnProperty')).toBe(false);
    expect(OCPP21_SUBPROTOCOL).toBe('ocpp2.1');
  });

  it("accept every 2.0.1 payload type but NotifyMonitoringReport's: 2.1 widens 2.0.1's messages", () => {
    // Checked by the compiler; see NarrowedRequests and NarrowedResponses.
    expect(requestsWiden).toBe(true);
    expect(responsesWiden).toBe(true);
    expect(monitoringReportNarrows).toBe(false);
  });

  it('take any idToken type of up to 20 characters and tokens of up to 255', () => {
    const authorize = (idToken: string, type: string) =>
      validateOcpp21Request('Authorize', { idToken: { idToken, type } });
    for (const type of OCPP21_ID_TOKEN_TYPES) expect(authorize('TAG-1', type).ok).toBe(true);
    expect(authorize('5YJ3E1EA7KF000001', 'VIN').ok).toBe(true);
    expect(authorize('x'.repeat(255), 'VendorSpecific').ok).toBe(true);
    expect(authorize('x'.repeat(256), 'ISO14443')).toMatchObject({
      ok: false,
      errorCode: 'PropertyConstraintViolation',
    });
    expect(authorize('TAG-1', 'x'.repeat(21)).ok).toBe(false);
  });

  it('carry transaction limits and the cost the station calculated', () => {
    const ended: Ocpp21RequestOf<'TransactionEvent'> = {
      eventType: 'Ended',
      timestamp: '2026-11-16T10:30:00Z',
      triggerReason: 'CostLimitReached',
      seqNo: 4,
      transactionInfo: {
        transactionId: 'tx-1',
        tariffId: 'T-1',
        transactionLimit: { maxCost: 5 },
        stoppedReason: 'Local',
      },
      costDetails: {
        chargingPeriods: [
          {
            tariffId: 'T-1',
            startPeriod: '2026-11-16T10:00:00Z',
            dimensions: [{ type: 'Energy', volume: 12000 }],
          },
        ],
        totalCost: {
          currency: 'NZD',
          typeOfCost: 'MaxCost',
          energy: { exclTax: 4.35, inclTax: 5, taxRates: [{ type: 'GST', tax: 15 }] },
          total: { exclTax: 4.35, inclTax: 5 },
        },
        totalUsage: { energy: 12000, chargingTime: 1800, idleTime: 0 },
      },
    };
    expect(validateOcpp21Request('TransactionEvent', ended)).toMatchObject({ ok: true });
    expect(
      validateOcpp21Response('TransactionEvent', {
        transactionLimit: { maxEnergy: 20000, maxSoC: 80 },
      }).ok,
    ).toBe(true);
    expect(
      validateOcpp21Response('TransactionEvent', { transactionLimit: { maxSoC: 101 } }),
    ).toMatchObject({ ok: false, errorCode: 'PropertyConstraintViolation' });
  });

  it('validate a default tariff with conditions', () => {
    const request: Ocpp21RequestOf<'SetDefaultTariff'> = {
      evseId: 0,
      tariff: {
        tariffId: 'T-1',
        currency: 'NZD',
        energy: {
          prices: [
            { priceKwh: 0.45, conditions: { startTimeOfDay: '07:00', endTimeOfDay: '22:00' } },
            { priceKwh: 0.25 },
          ],
          taxRates: [{ type: 'GST', tax: 15 }],
        },
        idleTime: { prices: [{ priceMinute: 0.5, conditions: { dayOfWeek: ['Monday'] } }] },
      },
    };
    expect(validateOcpp21Request('SetDefaultTariff', request).ok).toBe(true);
    expect(validateOcpp21Response('SetDefaultTariff', { status: 'DuplicateTariffId' }).ok).toBe(
      true,
    );
    expect(
      validateOcpp21Request('SetDefaultTariff', {
        ...request,
        tariff: { ...request.tariff, energy: { prices: [] } },
      }),
    ).toMatchObject({ ok: false, errorCode: 'OccurrenceConstraintViolation' });
  });

  it('check the bounds of decimals, such as a discharge limit that must not be positive', () => {
    const update = (dischargeLimit: number) =>
      validateOcpp21Request('UpdateDynamicSchedule', {
        chargingProfileId: 7,
        scheduleUpdate: { limit: 11000, dischargeLimit },
      });
    expect(update(-3000).ok).toBe(true);
    expect(update(3000)).toMatchObject({ ok: false, errorCode: 'PropertyConstraintViolation' });
  });

  it('give the unconfirmed NotifyPeriodicEventStream a request and no response', () => {
    expect(
      validateOcpp21Request('NotifyPeriodicEventStream', {
        id: 1,
        pending: 0,
        basetime: '2026-11-16T10:00:00Z',
        data: [{ t: 0, v: '230.4' }],
      }).ok,
    ).toBe(true);
    expect(OCPP21_MESSAGES.NotifyPeriodicEventStream.response).toBeUndefined();
    expect(validateOcpp21Response('NotifyPeriodicEventStream', {})).toMatchObject({ ok: false });
  });

  it('report the OCPP-J 2.x error code spellings', () => {
    expect(validateOcpp21Request('Heartbeat', { extra: 1 })).toMatchObject({
      ok: false,
      errorCode: 'FormatViolation',
    });
    expect(validateOcpp21Request('NotifySettlement', { pspRef: 'P-1' })).toMatchObject({
      ok: false,
      errorCode: 'OccurrenceConstraintViolation',
    });
  });
});
