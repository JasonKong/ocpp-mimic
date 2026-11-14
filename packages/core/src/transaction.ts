/**
 * Transactions: building StartTransaction / StopTransaction / MeterValues
 * requests from the meter, and deciding what to do with the CSMS's answer to
 * StartTransaction.
 */
import { isAccepted } from './auth.js';
import { configBool, configList, type ConfigState } from './config.js';
import { meterAt, registerWh, sampleMeter, type MeterState, type SampleExtras } from './meter.js';
import type {
  MeterValue,
  ReadingContext,
  RequestOf,
  ResponseOf,
  StopReason,
} from './ocpp16-messages.js';

export interface Transaction {
  readonly connectorId: number;
  readonly idTag: string;
  /** Assigned by the CSMS in the StartTransaction answer. */
  readonly transactionId?: number;
  readonly startedAt: number;
  readonly meterStartWh: number;
  /** The Transaction.Begin sample of StopTxnSampledData, sent back in StopTransaction. */
  readonly beginSample?: MeterValue;
}

export interface StartedTransaction {
  transaction: Transaction;
  request: RequestOf<'StartTransaction'>;
}

/** Starts a transaction at `now` and builds its StartTransaction request. */
export function startTransaction(input: {
  connectorId: number;
  idTag: string;
  meter: MeterState;
  config: ConfigState;
  now: number;
  reservationId?: number;
  /** Readings outside the meter, such as the EV's SoC. */
  extras?: SampleExtras;
}): StartedTransaction {
  const meter = meterAt(input.meter, input.now);
  const meterStartWh = registerWh(meter);
  const beginSample = sampleMeter(
    meter,
    input.now,
    configList(input.config, 'StopTxnSampledData'),
    'Transaction.Begin',
    input.extras,
  );
  return {
    transaction: {
      connectorId: input.connectorId,
      idTag: input.idTag,
      startedAt: input.now,
      meterStartWh,
      ...(beginSample !== undefined && { beginSample }),
    },
    request: {
      connectorId: input.connectorId,
      idTag: input.idTag,
      meterStart: meterStartWh,
      timestamp: new Date(input.now).toISOString(),
      ...(input.reservationId !== undefined && { reservationId: input.reservationId }),
    },
  };
}

export type StartDecision =
  /** Accepted: keep charging. */
  | 'continue'
  /** Not accepted and StopTransactionOnInvalidId is true: stop with reason DeAuthorized. */
  | 'stop'
  /** Not accepted and StopTransactionOnInvalidId is false: keep the transaction, offer no energy. */
  | 'suspend';

/** Records the CSMS's transactionId and decides how to carry on. */
export function applyStartResponse(
  transaction: Transaction,
  response: ResponseOf<'StartTransaction'>,
  config: ConfigState,
  now: number,
): { transaction: Transaction; decision: StartDecision } {
  const updated = { ...transaction, transactionId: response.transactionId };
  if (isAccepted(response.idTagInfo, now)) return { transaction: updated, decision: 'continue' };
  return {
    transaction: updated,
    decision: configBool(config, 'StopTransactionOnInvalidId') ? 'stop' : 'suspend',
  };
}

/**
 * Builds the StopTransaction request ending `transaction` at `now`. When
 * StopTxnSampledData lists supported measurands, transactionData carries the
 * Transaction.Begin and Transaction.End samples.
 */
export function stopTransactionRequest(input: {
  transaction: Transaction;
  meter: MeterState;
  config: ConfigState;
  now: number;
  reason: StopReason;
  /** The idTag that stopped the transaction, when it was stopped by a card. */
  idTag?: string;
  extras?: SampleExtras;
}): RequestOf<'StopTransaction'> {
  const { transaction, now } = input;
  if (transaction.transactionId === undefined) {
    throw new Error('cannot stop a transaction the CSMS has not given an id yet');
  }
  const meter = meterAt(input.meter, now);
  const endSample = sampleMeter(
    meter,
    now,
    configList(input.config, 'StopTxnSampledData'),
    'Transaction.End',
    input.extras,
  );
  const transactionData = [transaction.beginSample, endSample].filter(
    (sample): sample is MeterValue => sample !== undefined,
  );
  return {
    transactionId: transaction.transactionId,
    // A meter that rolled back reports less than meterStart, as a real faulty one would.
    meterStop: registerWh(meter),
    timestamp: new Date(now).toISOString(),
    reason: input.reason,
    ...(input.idTag !== undefined && { idTag: input.idTag }),
    ...(transactionData.length > 0 && { transactionData }),
  };
}

/**
 * Builds a MeterValues request for `connectorId` with the measurands of
 * `configKey` (MeterValuesSampledData or MeterValuesAlignedData), or
 * undefined when none of them can be sampled.
 */
export function meterValuesRequest(input: {
  connectorId: number;
  meter: MeterState;
  config: ConfigState;
  now: number;
  configKey: 'MeterValuesSampledData' | 'MeterValuesAlignedData';
  context: ReadingContext;
  transactionId?: number;
  extras?: SampleExtras;
}): RequestOf<'MeterValues'> | undefined {
  const sample = sampleMeter(
    input.meter,
    input.now,
    configList(input.config, input.configKey),
    input.context,
    input.extras,
  );
  if (sample === undefined) return undefined;
  return {
    connectorId: input.connectorId,
    meterValue: [sample],
    ...(input.transactionId !== undefined && { transactionId: input.transactionId }),
  };
}
