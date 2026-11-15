/**
 * An OCPP 2.0.1 charging station, built on the same pure parts as the 1.6
 * charge point (device facts, timers, outbox, energy) with 2.0.1's messages:
 * boot and registration, heartbeats, StatusNotification per EVSE and
 * connector, ChangeAvailability for the station, an EVSE or a connector, the
 * Device Model (GetVariables, SetVariables, GetBaseReport, GetReport), and
 * transactions (TransactionEvent per the Tx start and stop points, meter
 * values, offline delivery, GetTransactionStatus) with basic authorization.
 * Later M5 tasks add the authorization cache and local list, remote control
 * and the feature profiles.
 *
 * It does no IO and implements the engine's ChargePoint interface, so the
 * fleet, scenarios and the API drive it like a 1.6 station. Connector `n`
 * is EVSE `n`'s only connector.
 */
import {
  DEFAULT_BEHAVIOUR,
  DEFAULT_TIMING,
  type ChargePoint,
  type ChargePointBehaviour,
  type ChargePointEvent,
  type ChargePointSnapshot,
  type ChargePointTiming,
  type IdTagResult,
  type PluggedEv,
  type Registration,
} from '../charge-point.js';
import type { Clock, TimerHandle } from '../clock.js';
import {
  connectors,
  createStation,
  findConnector,
  reduce,
  type Availability,
  type DeviceEvent,
  type ReduceResult,
  type StationState,
} from '../device.js';
import { createEnergy } from '../energy.js';
import { nextAlignedSample, nextPeriodicSample } from '../meter.js';
import type { IdGenerator } from '../ids.js';
import { OCPP201_MESSAGE_SET, type Ocpp201RpcTypes } from '../message-set.js';
import { createOutbox, type OutboxEntry } from '../outbox.js';
import {
  createRpc,
  RpcCallError,
  type CallOutcome,
  type Rpc,
  type RpcHandlers,
  type RpcOutcome,
} from '../rpc.js';
import { createStationTimers } from '../station-timers.js';
import type {
  BootReasonEnumType,
  ChargingStateEnumType,
  ChargingStationType,
  IdTokenEnumType,
  IdTokenType,
  MeterValueType,
  ReadingContextEnumType,
  ReasonEnumType,
  TransactionEventEnumType,
  TriggerReasonEnumType,
  Ocpp201RequestOf,
  Ocpp201ResponseOf,
} from './messages.js';
import {
  applyOverrides,
  componentKey,
  createDeviceModel,
  parseComponentKey,
  variableKey,
  type DeviceModelOverrides,
} from './device-model.js';
import { sampleMeter201 } from './meter-values.js';
import { standardVariables } from './standard-variables.js';
import { chargingState, parseTxPoints, startPoint, stopPoint } from './transaction.js';
import { connectorStatus201, stationStatus201, type ConnectorStatus201 } from './status.js';

type Out = Ocpp201RpcTypes['out'];

/** The certification profiles a 2.0.1 station can support (Part 5). */
export const CERTIFICATION_PROFILES = [
  'Core',
  'AdvancedSecurity',
  'LocalAuthListManagement',
  'SmartCharging',
  'Reservation',
] as const;

export interface ChargePoint201Options {
  clock: Clock;
  ids: IdGenerator;
  /** BootNotification's chargingStation block: model, vendor, serial number, firmware. */
  boot: ChargingStationType;
  /** EVSEs, each with one connector. */
  connectors: number;
  /** Certification profiles the station supports (the persona's `features`). Default Core. */
  features?: readonly string[];
  /** Device Model overrides: the persona's and the station's `deviceModel`. */
  deviceModel?: DeviceModelOverrides;
  timing?: Partial<ChargePointTiming>;
  /** Power each connector offers, in W. Default 7360 (32 A at 230 V). */
  offeredPowerW?: number;
  /** Power drawn without an EV when allowed, in W. Default: everything offered. */
  evPowerW?: number;
  send: (text: string) => void;
  /** Asks the transport to drop the connection and reconnect after `downtimeMs`. */
  restart?: (downtimeMs: number) => void;
  /** Asks the transport to reconnect at once with the current security settings. */
  reconnect?: () => void;
  onEvent?: (event: ChargePointEvent) => void;
  behaviour?: Partial<ChargePointBehaviour>;
  energyMultiplier?: number;
  /** State saved by persistentState() before a restart. */
  restore?: PersistedChargePoint201;
}

/** Everything a 2.0.1 station keeps across an engine restart. */
export interface PersistedChargePoint201 {
  version: 1;
  ocpp: '2.0.1';
  savedAt: number;
  /** connectorId → energy register in Wh. */
  meters: Record<string, number>;
  outbox: OutboxEntry[];
  sequence: number;
  behaviour: ChargePointBehaviour;
  energyMultiplier: number;
  /** Availability set by the CSMS persists across reboots (B11.FR.02, B12.FR.06). */
  availability: { station: Availability; connectors: Record<string, Availability> };
  /** Persistent Device Model values: `component/variable/attribute` → value. */
  deviceModel: Record<string, string>;
  /** Transactions running at the save; they end with PowerLoss after the restart. */
  transactions: PersistedTransaction201[];
}

export interface PersistedTransaction201 {
  connectorId: number;
  transactionId: string;
  /** The seqNo of the next event. */
  seqNo: number;
  startedAt: number;
  meterStartWh: number;
  idToken?: IdTokenType;
  remoteStartId?: number;
  /** Why it stops, when it was deauthorized but keeps running (TxStopPoint without Authorized). */
  stoppedReason?: ReasonEnumType;
}

/** A token authorized at a connector. */
interface Authorization {
  idToken: IdTokenType;
  remoteStartId?: number;
}

/** A running transaction. */
interface Transaction201 {
  id: string;
  seqNo: number;
  startedAt: number;
  meterStartWh: number;
  idToken?: IdTokenType;
  remoteStartId?: number;
  /** The charging state the last event reported. */
  chargingState: ChargingStateEnumType;
  /** Set when it was deauthorized but keeps running; the Ended event reports it. */
  stoppedReason?: ReasonEnumType;
  /** Samples for the Ended event (TxEndedMeasurands, every TxEndedInterval). */
  endedValues: MeterValueType[];
  /** MaxEnergyOnInvalidId: the energy (register, Wh) at which charging stops. */
  energyLimitWh?: number;
  limitReached?: boolean;
  periodicTimer?: TimerHandle | undefined;
  endedTimer?: TimerHandle | undefined;
  limitTimer?: TimerHandle | undefined;
}

/** The stoppedReason an ending trigger implies. */
function reasonFor(trigger: TriggerReasonEnumType): ReasonEnumType {
  switch (trigger) {
    case 'StopAuthorized':
      return 'Local';
    case 'Deauthorized':
      return 'DeAuthorized';
    case 'RemoteStop':
      return 'Remote';
    case 'EVCommunicationLost':
      return 'EVDisconnected';
    case 'EVConnectTimeout':
      return 'Timeout';
    case 'ResetCommand':
      return 'ImmediateReset';
    case 'EnergyLimitReached':
      return 'EnergyLimitReached';
    default:
      return 'Other';
  }
}

function checkedMultiplier(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new RangeError(`the energy multiplier must be above 0, got ${value}`);
  }
  return value;
}

/** A 2.0.1 charging station: its saved state is a 2.0.1 state. */
export interface ChargePoint201 extends ChargePoint {
  persistentState(): PersistedChargePoint201;
}

export function createChargePoint201(options: ChargePoint201Options): ChargePoint201 {
  const { clock, ids } = options;
  const timing: ChargePointTiming = { ...DEFAULT_TIMING, ...options.timing };
  const offeredW = options.offeredPowerW ?? 7360;
  const emit = options.onEvent ?? (() => {});
  const log = (message: string) => emit({ type: 'log', message });
  const changed = () => emit({ type: 'changed' });
  const now = () => clock.now();
  const timestamp = () => new Date(now()).toISOString();

  let station: StationState = createStation(options.connectors);
  let behaviour: ChargePointBehaviour = {
    ...DEFAULT_BEHAVIOUR,
    ...options.behaviour,
    ...options.restore?.behaviour,
  };
  let sequence = options.restore?.sequence ?? 0;
  const nextKey = (prefix: string) => `${prefix}-${++sequence}`;

  let rpc: Rpc<Ocpp201RpcTypes> | undefined;
  let registration: Registration = 'Offline';
  let heartbeatTimer: TimerHandle | undefined;
  let bootTimer: TimerHandle | undefined;
  /** Why the next BootNotification is sent. */
  let bootReason: BootReasonEnumType = 'PowerUp';
  const online = () => rpc !== undefined && registration === 'Accepted';

  const timers = createStationTimers(clock);
  const { later } = timers;
  const stopTimer = timers.stop;

  const energy = createEnergy({
    clock,
    timers,
    connectorIds: connectors(station).map((c) => c.connectorId),
    offeredW,
    evPowerW: options.evPowerW ?? offeredW,
    multiplier: checkedMultiplier(
      options.restore?.energyMultiplier ?? options.energyMultiplier ?? 1,
    ),
    ...(options.restore !== undefined && { registers: options.restore.meters }),
    onFull(connectorId) {
      if (applyDevice({ type: 'EvSuspend', connectorId }).error === undefined) {
        updatePower(connectorId);
      }
    },
    log,
  });

  // ---- Device Model ---------------------------------------------------------

  const applied = applyOverrides(
    standardVariables({
      connectors: options.connectors,
      features: options.features ?? ['Core'],
      offeredW,
    }),
    options.deviceModel,
  );
  if (!applied.ok) throw new Error(`deviceModel: ${applied.problems.join('; ')}`);
  const deviceModel = createDeviceModel({
    definitions: applied.definitions,
    ...(options.restore !== undefined && { saved: options.restore.deviceModel }),
    read(key) {
      if (key === 'ClockCtrlr/DateTime') return timestamp();
      const [componentText = '', variableName] = key.split('/');
      const component = parseComponentKey(componentText);
      if (component === undefined) return undefined;
      if (component.name === 'ChargingStation' && variableName === 'AvailabilityState') {
        return stationStatus201(station);
      }
      const connector =
        component.evse === undefined ? undefined : findConnector(station, component.evse.id);
      if (connector === undefined) return undefined;
      if (variableName === 'AvailabilityState') return connectorStatus201(connector, station);
      if (variableName === 'Power') {
        return String(Math.round(energy.sync(connector.connectorId).powerW));
      }
      return undefined;
    },
  });
  const dmInt = (component: string, variable: string) =>
    Number(deviceModel.get(component, variable) ?? '0');
  /** The message limits of DeviceDataCtrlr, per request type (B06.FR.16, .17 and the like). */
  function checkLimits(
    kind: 'GetVariables' | 'SetVariables' | 'GetReport',
    items: number,
    request: unknown,
  ): void {
    const maxItems = dmInt('DeviceDataCtrlr', `ItemsPerMessage:${kind}`);
    if (maxItems > 0 && items > maxItems) {
      throw new RpcCallError(
        'OccurenceConstraintViolation',
        `more than ${maxItems} items (ItemsPerMessage${kind})`,
      );
    }
    const maxBytes = dmInt('DeviceDataCtrlr', `BytesPerMessage:${kind}`);
    if (maxBytes > 0 && JSON.stringify(request).length > maxBytes) {
      throw new RpcCallError(
        'FormationViolation',
        `longer than ${maxBytes} bytes (BytesPerMessage${kind})`,
      );
    }
  }

  // ---- Sending ------------------------------------------------------------

  /** Sends now when registered; otherwise drops the message (status reports, heartbeats). */
  function sendIfOnline<A extends Out>(
    action: A,
    payload: Ocpp201RequestOf<A>,
  ): Promise<RpcOutcome<Ocpp201ResponseOf<A>>> | undefined {
    return online()
      ? (rpc?.call(action, payload as never) as Promise<RpcOutcome<Ocpp201ResponseOf<A>>>)
      : undefined;
  }

  /** Messages with guaranteed delivery; transaction events join them with transactions. */
  const outbox = createOutbox({
    timers,
    online,
    call: (action, payload) => rpc?.call(action as Out, payload as never),
    retryPolicy: () => ({
      attempts: dmInt('OCPPCommCtrlr', 'MessageAttempts:TransactionEvent'),
      intervalS: dmInt('OCPPCommCtrlr', 'MessageAttemptInterval:TransactionEvent'),
    }),
    nextKey: () => nextKey('msg'),
    log,
    changed,
  });

  // ---- Status -------------------------------------------------------------

  /** What a StatusNotification last reported, by connector. */
  const reported = new Map<number, ConnectorStatus201>();

  /**
   * Reports every connector whose status changed, or all of them. Offline,
   * reports are dropped (the next boot reports all), or queued with
   * OCPPCommCtrlr.QueueAllMessages.
   */
  function reportStatuses(all = false): void {
    const queueAll = deviceModel.get('OCPPCommCtrlr', 'QueueAllMessages') === 'true';
    if (!online() && !queueAll) return;
    for (const connector of connectors(station)) {
      const status = connectorStatus201(connector, station);
      if (!all && reported.get(connector.connectorId) === status) continue;
      reported.set(connector.connectorId, status);
      const payload = {
        timestamp: timestamp(),
        connectorStatus: status,
        evseId: connector.connectorId,
        connectorId: 1,
      };
      if (online()) void sendIfOnline('StatusNotification', payload);
      else void outbox.enqueue('StatusNotification', payload);
    }
  }

  function applyDevice(event: DeviceEvent): ReduceResult {
    const result = reduce(station, event, now());
    if (result.error !== undefined) {
      log(result.error);
      return result;
    }
    station = result.state;
    // The reducer's messages are 1.6 StatusNotifications; 2.0.1 reports its own view.
    reportStatuses();
    changed();
    return result;
  }

  // ---- Transactions ---------------------------------------------------------

  /** The token authorized at each connector, until its session ends. */
  const authorizations = new Map<number, Authorization>();
  /** EVConnectionTimeOut: an authorization waiting for the cable. */
  const connectTimers = new Map<number, TimerHandle>();
  const transactions = new Map<number, Transaction201>();
  let alignedTimer: TimerHandle | undefined;
  let alignedEndedTimer: TimerHandle | undefined;

  const dmValue = (component: string, variable: string) =>
    deviceModel.get(component, variable) ?? '';
  const sample = (connectorId: number, measurands: string, context: ReadingContextEnumType) =>
    sampleMeter201(
      energy.sync(connectorId),
      now(),
      measurands,
      context,
      energy.extras(connectorId),
    );

  /**
   * Whether a connector may draw power: a cable, an authorized token, no
   * suspension or fault, operative, and no energy limit reached.
   */
  function mayCharge(connectorId: number): boolean {
    const connector = findConnector(station, connectorId);
    if (connector === undefined) return false;
    return (
      connector.plugged &&
      authorizations.has(connectorId) &&
      !connector.evSuspended &&
      !connector.evseSuspended &&
      connector.fault === undefined &&
      station.fault === undefined &&
      connector.availability === 'Operative' &&
      station.availability === 'Operative' &&
      transactions.get(connectorId)?.limitReached !== true
    );
  }

  function updatePower(connectorId: number): void {
    energy.update(connectorId, mayCharge(connectorId), undefined);
  }

  function currentChargingState(connectorId: number): ChargingStateEnumType {
    const connector = findConnector(station, connectorId);
    const ev = energy.ev(connectorId);
    return chargingState({
      plugged: connector?.plugged ?? false,
      authorized: authorizations.has(connectorId),
      evSuspended: connector?.evSuspended ?? false,
      evseSuspended: !mayCharge(connectorId) && connector?.evSuspended !== true,
      powerW: energy.meter(connectorId).powerW,
      evFull: ev !== undefined && !energy.canResume(connectorId),
    });
  }

  /**
   * Sends a TransactionEvent through the outbox: in order, kept while
   * offline (marked `offline`), retried per MessageAttempts. A not-Accepted
   * idTokenInfo in the answer deauthorizes the transaction.
   */
  function sendEvent(
    connectorId: number,
    tx: Transaction201,
    eventType: TransactionEventEnumType,
    triggerReason: TriggerReasonEnumType,
    extra: {
      idToken?: IdTokenType;
      meterValue?: MeterValueType[];
      stoppedReason?: ReasonEnumType;
    } = {},
  ): void {
    tx.chargingState = eventType === 'Ended' ? tx.chargingState : currentChargingState(connectorId);
    const meterValue = extra.meterValue?.filter((m) => m !== undefined) ?? [];
    const [firstValue, ...otherValues] = meterValue;
    const payload: Ocpp201RequestOf<'TransactionEvent'> = {
      eventType,
      timestamp: timestamp(),
      triggerReason,
      seqNo: tx.seqNo++,
      transactionInfo: {
        transactionId: tx.id,
        chargingState: eventType === 'Ended' ? currentChargingState(connectorId) : tx.chargingState,
        ...(extra.stoppedReason !== undefined && { stoppedReason: extra.stoppedReason }),
        ...(eventType === 'Started' &&
          tx.remoteStartId !== undefined && { remoteStartId: tx.remoteStartId }),
      },
      ...(!online() && { offline: true }),
      evse: { id: connectorId, connectorId: 1 },
      ...(extra.idToken !== undefined && { idToken: extra.idToken }),
      ...(firstValue !== undefined && { meterValue: [firstValue, ...otherValues] }),
    };
    void outbox.enqueue('TransactionEvent', payload, tx.id).then((outcome) => {
      if (!outcome.ok || eventType === 'Ended') return;
      const info = (outcome.payload as Ocpp201ResponseOf<'TransactionEvent'>).idTokenInfo;
      if (info === undefined || info.status === 'Accepted') return;
      if (transactions.get(connectorId) !== tx) return;
      log(`connector ${connectorId}: the CSMS answered ${info.status} for the transaction's token`);
      invalidated(connectorId, tx);
    });
    changed();
  }

  /** The CSMS no longer accepts the token (E05): stop, or cap the energy at MaxEnergyOnInvalidId. */
  function invalidated(connectorId: number, tx: Transaction201): void {
    if (dmValue('TxCtrlr', 'StopTxOnInvalidId') !== 'false') {
      deauthorize(connectorId, 'Deauthorized', 'DeAuthorized');
      return;
    }
    tx.energyLimitWh = tx.meterStartWh + dmInt('TxCtrlr', 'MaxEnergyOnInvalidId');
    checkEnergyLimit(connectorId, tx);
  }

  function checkEnergyLimit(connectorId: number, tx: Transaction201): void {
    stopTimer(tx.limitTimer);
    tx.limitTimer = undefined;
    if (tx.energyLimitWh === undefined || tx.limitReached === true) return;
    const reading = energy.sync(connectorId);
    if (reading.energyWh >= tx.energyLimitWh) {
      tx.limitReached = true;
      updatePower(connectorId);
      sendEvent(connectorId, tx, 'Updated', 'EnergyLimitReached');
      return;
    }
    if (reading.powerW <= 0) return;
    const ms = ((tx.energyLimitWh - reading.energyWh) / reading.powerW) * 3_600_000;
    tx.limitTimer = later(Math.ceil(ms / energy.multiplier), () =>
      checkEnergyLimit(connectorId, tx),
    );
  }

  function updateLock(connectorId: number): void {
    const connector = findConnector(station, connectorId);
    if (connector === undefined) return;
    const shouldLock = behaviour.cableLock && transactions.has(connectorId);
    if (shouldLock && !connector.locked) applyDevice({ type: 'Lock', connectorId });
    if (!shouldLock && connector.locked) applyDevice({ type: 'Unlock', connectorId });
  }

  /** Periodic samples of a running transaction: TxUpdated events and the TxEnded collection. */
  function schedulePeriodic(connectorId: number, tx: Transaction201): void {
    scheduleUpdated(connectorId, tx);
    scheduleEnded(connectorId, tx);
  }

  function scheduleUpdated(connectorId: number, tx: Transaction201): void {
    stopTimer(tx.periodicTimer);
    tx.periodicTimer = undefined;
    const due = nextPeriodicSample(
      tx.startedAt,
      dmInt('SampledDataCtrlr', 'TxUpdatedInterval'),
      now(),
    );
    if (due === undefined) return;
    tx.periodicTimer = later(due - now(), () => {
      if (transactions.get(connectorId) !== tx) return;
      const value = sample(
        connectorId,
        dmValue('SampledDataCtrlr', 'TxUpdatedMeasurands'),
        'Sample.Periodic',
      );
      sendEvent(connectorId, tx, 'Updated', 'MeterValuePeriodic', {
        ...(value !== undefined && { meterValue: [value] }),
      });
      scheduleUpdated(connectorId, tx);
    });
  }

  function scheduleEnded(connectorId: number, tx: Transaction201): void {
    stopTimer(tx.endedTimer);
    tx.endedTimer = undefined;
    const due = nextPeriodicSample(
      tx.startedAt,
      dmInt('SampledDataCtrlr', 'TxEndedInterval'),
      now(),
    );
    if (due === undefined) return;
    tx.endedTimer = later(due - now(), () => {
      if (transactions.get(connectorId) !== tx) return;
      const value = sample(
        connectorId,
        dmValue('SampledDataCtrlr', 'TxEndedMeasurands'),
        'Sample.Periodic',
      );
      if (value !== undefined) tx.endedValues.push(value);
      scheduleEnded(connectorId, tx);
    });
  }

  /** Clock-aligned samples: MeterValueClock events, idle MeterValues, and the aligned TxEnded collection. */
  function scheduleAligned(): void {
    stopTimer(alignedTimer);
    stopTimer(alignedEndedTimer);
    alignedTimer = alignedEndedTimer = undefined;
    const due = nextAlignedSample(dmInt('AlignedDataCtrlr', 'Interval'), now());
    if (due !== undefined) {
      alignedTimer = later(due - now(), () => {
        const measurands = dmValue('AlignedDataCtrlr', 'Measurands');
        for (const connector of connectors(station)) {
          const id = connector.connectorId;
          const tx = transactions.get(id);
          const value = sample(id, measurands, 'Sample.Clock');
          if (value === undefined) continue;
          if (tx !== undefined) {
            sendEvent(id, tx, 'Updated', 'MeterValueClock', { meterValue: [value] });
          } else if (dmValue('AlignedDataCtrlr', 'SendDuringIdle') === 'true') {
            void sendIfOnline('MeterValues', { evseId: id, meterValue: [value] });
          }
        }
        scheduleAligned();
      });
    }
    const endedDue = nextAlignedSample(dmInt('AlignedDataCtrlr', 'TxEndedInterval'), now());
    if (endedDue !== undefined) {
      alignedEndedTimer = later(endedDue - now(), () => {
        for (const [id, tx] of transactions) {
          const value = sample(
            id,
            dmValue('AlignedDataCtrlr', 'TxEndedMeasurands'),
            'Sample.Clock',
          );
          if (value !== undefined) tx.endedValues.push(value);
        }
        scheduleAligned();
      });
    }
  }

  function startTransaction(connectorId: number, trigger: TriggerReasonEnumType): void {
    const auth = authorizations.get(connectorId);
    const tx: Transaction201 = {
      id: ids(),
      seqNo: 0,
      startedAt: now(),
      meterStartWh: energy.sync(connectorId).energyWh,
      ...(auth !== undefined && { idToken: auth.idToken }),
      ...(auth?.remoteStartId !== undefined && { remoteStartId: auth.remoteStartId }),
      chargingState: currentChargingState(connectorId),
      endedValues: [],
    };
    transactions.set(connectorId, tx);
    applyDevice({ type: 'TransactionStarted', connectorId, transactionId: 1 });
    updateLock(connectorId);
    const value = sample(
      connectorId,
      dmValue('SampledDataCtrlr', 'TxStartedMeasurands'),
      'Transaction.Begin',
    );
    sendEvent(
      connectorId,
      tx,
      'Started',
      auth?.remoteStartId !== undefined && trigger === 'Authorized' ? 'RemoteStart' : trigger,
      {
        ...(auth !== undefined && { idToken: auth.idToken }),
        ...(value !== undefined && { meterValue: [value] }),
      },
    );
    schedulePeriodic(connectorId, tx);
  }

  function endTransaction(
    connectorId: number,
    trigger: TriggerReasonEnumType,
    stoppedReason: ReasonEnumType,
    idToken?: IdTokenType,
  ): void {
    const tx = transactions.get(connectorId);
    if (tx === undefined) return;
    transactions.delete(connectorId);
    for (const timer of [tx.periodicTimer, tx.endedTimer, tx.limitTimer]) stopTimer(timer);
    // The session is over: a new one needs a new authorization.
    authorizations.delete(connectorId);
    stopTimer(connectTimers.get(connectorId));
    connectTimers.delete(connectorId);
    const final = sample(
      connectorId,
      dmValue('SampledDataCtrlr', 'TxEndedMeasurands'),
      'Transaction.End',
    );
    updatePower(connectorId);
    sendEvent(connectorId, tx, 'Ended', trigger, {
      stoppedReason: tx.stoppedReason ?? stoppedReason,
      ...(idToken !== undefined && { idToken }),
      meterValue: [...tx.endedValues, ...(final === undefined ? [] : [final])],
    });
    applyDevice({ type: 'TransactionEnded', connectorId });
    updateLock(connectorId);
    changed();
  }

  /**
   * Re-evaluates a connector after `trigger`: power, then the start or stop
   * points, then an Updated event for what the trigger changed.
   */
  function evaluate(
    connectorId: number,
    trigger: TriggerReasonEnumType,
    idToken?: IdTokenType,
  ): void {
    updatePower(connectorId);
    const connector = findConnector(station, connectorId);
    if (connector === undefined) return;
    const conditions = {
      evConnected: connector.plugged,
      authorized: authorizations.has(connectorId),
      energyTransfer: energy.meter(connectorId).powerW > 0,
    };
    const tx = transactions.get(connectorId);
    if (tx === undefined) {
      if (startPoint(parseTxPoints(dmValue('TxCtrlr', 'TxStartPoint')), conditions) !== undefined) {
        startTransaction(connectorId, trigger);
      }
      return;
    }
    if (stopPoint(parseTxPoints(dmValue('TxCtrlr', 'TxStopPoint')), conditions) !== undefined) {
      endTransaction(connectorId, trigger, reasonFor(trigger), idToken);
      return;
    }
    const state = currentChargingState(connectorId);
    if (trigger !== 'ChargingStateChanged') {
      if (trigger === 'Authorized' && tx.idToken === undefined && idToken !== undefined)
        tx.idToken = idToken;
      sendEvent(connectorId, tx, 'Updated', trigger, { ...(idToken !== undefined && { idToken }) });
    } else if (state !== tx.chargingState) {
      sendEvent(connectorId, tx, 'Updated', 'ChargingStateChanged');
    }
    if (tx.energyLimitWh !== undefined) checkEnergyLimit(connectorId, tx);
  }

  /** The token of the session ends (card, CSMS, timeout); the stop points decide whether the transaction ends. */
  function deauthorize(
    connectorId: number,
    trigger: TriggerReasonEnumType,
    stoppedReason: ReasonEnumType,
    idToken?: IdTokenType,
  ): void {
    authorizations.delete(connectorId);
    stopTimer(connectTimers.get(connectorId));
    connectTimers.delete(connectorId);
    const tx = transactions.get(connectorId);
    if (tx !== undefined) tx.stoppedReason = stoppedReason;
    evaluate(connectorId, trigger, idToken);
  }

  /** Asks whether a token may charge: Authorize online; offline only with OfflineTxForUnknownIdEnabled. */
  async function authorize(idToken: IdTokenType): Promise<boolean> {
    if (dmValue('AuthCtrlr', 'Enabled') === 'false') return true;
    if (!online()) return dmValue('AuthCtrlr', 'OfflineTxForUnknownIdEnabled') === 'true';
    const outcome = await sendIfOnline('Authorize', { idToken });
    return outcome?.ok === true && outcome.payload.idTokenInfo.status === 'Accepted';
  }

  /** An authorization waits EVConnectionTimeOut for the cable (E03.FR.05). */
  function awaitCable(connectorId: number): void {
    stopTimer(connectTimers.get(connectorId));
    connectTimers.delete(connectorId);
    const timeoutS = dmInt('TxCtrlr', 'EVConnectionTimeOut');
    if (timeoutS <= 0) return;
    connectTimers.set(
      connectorId,
      later(timeoutS * 1000, () => {
        connectTimers.delete(connectorId);
        if (findConnector(station, connectorId)?.plugged === true) return;
        log(`connector ${connectorId}: no cable within EVConnectionTimeOut`);
        if (transactions.has(connectorId)) {
          authorizations.delete(connectorId);
          endTransaction(connectorId, 'EVConnectTimeout', 'Timeout');
        } else {
          authorizations.delete(connectorId);
          changed();
        }
      }),
    );
  }

  // ---- Registration and heartbeats ----------------------------------------

  async function boot(): Promise<void> {
    const current = rpc;
    if (current === undefined) return;
    registration = 'Booting';
    changed();
    const outcome = await current.call('BootNotification', {
      reason: bootReason,
      chargingStation: options.boot,
    });
    if (rpc !== current) return; // the connection changed meanwhile
    if (!outcome.ok) {
      log(`BootNotification failed: ${outcome.failure.kind}`);
      bootTimer = later(timing.bootRetryMs, boot);
      return;
    }
    const { status, interval } = outcome.payload;
    registration = status;
    changed();
    if (status !== 'Accepted') {
      bootTimer = later(interval > 0 ? interval * 1000 : timing.bootRetryMs, boot);
      return;
    }
    bootReason = 'PowerUp';
    // The CSMS's interval becomes HeartbeatInterval (B01.FR.04).
    if (interval > 0) deviceModel.set('OCPPCommCtrlr', 'HeartbeatInterval', String(interval));
    startHeartbeat();
    reportStatuses(true);
    outbox.pump();
  }

  function startHeartbeat(): void {
    stopTimer(heartbeatTimer);
    heartbeatTimer = undefined;
    const intervalS = dmInt('OCPPCommCtrlr', 'HeartbeatInterval');
    if (intervalS <= 0 || !online()) return;
    heartbeatTimer = later(intervalS * 1000, () => {
      void sendIfOnline('Heartbeat', {});
      startHeartbeat();
    });
  }

  /** A Device Model value changed by SetVariables: apply what depends on it. */
  function variableChanged(key: string): void {
    if (key === 'OCPPCommCtrlr/HeartbeatInterval') startHeartbeat();
    if (key.startsWith('AlignedDataCtrlr/')) scheduleAligned();
    if (
      key === 'SampledDataCtrlr/TxUpdatedInterval' ||
      key === 'SampledDataCtrlr/TxEndedInterval'
    ) {
      for (const [id, tx] of transactions) schedulePeriodic(id, tx);
    }
  }

  type ReportData = NonNullable<Ocpp201RequestOf<'NotifyReport'>['reportData']>;

  /**
   * Sends a report in NotifyReport pages of ItemsPerMessageGetReport entries,
   * numbered from 0, `tbc` on all but the last. Sent once connected, also
   * while the boot is Pending: a CSMS may ask for a report before accepting.
   */
  function sendReport(requestId: number, data: ReportData): void {
    const size = Math.max(1, dmInt('DeviceDataCtrlr', 'ItemsPerMessage:GetReport'));
    const generatedAt = timestamp();
    const pages = Math.max(1, Math.ceil(data.length / size));
    later(0, () => {
      for (let seqNo = 0; seqNo < pages; seqNo++) {
        void rpc?.call('NotifyReport', {
          requestId,
          generatedAt,
          seqNo,
          ...(seqNo < pages - 1 && { tbc: true }),
          reportData: data.slice(seqNo * size, (seqNo + 1) * size),
        });
      }
    });
  }

  // ---- Commands from the CSMS ---------------------------------------------

  const handlers: RpcHandlers<Ocpp201RpcTypes> = {
    GetTransactionStatus(request) {
      const queued = outbox.entries.some(
        (e) =>
          e.action === 'TransactionEvent' &&
          (request.transactionId === undefined || e.txRef === request.transactionId),
      );
      return {
        messagesInQueue: queued,
        ...(request.transactionId !== undefined && {
          ongoingIndicator: [...transactions.values()].some((t) => t.id === request.transactionId),
        }),
      };
    },

    GetVariables(request) {
      checkLimits('GetVariables', request.getVariableData.length, request);
      return {
        getVariableResult: deviceModel.getVariables(request.getVariableData) as [
          ReturnType<typeof deviceModel.getVariables>[number],
          ...ReturnType<typeof deviceModel.getVariables>,
        ],
      };
    },

    SetVariables(request) {
      checkLimits('SetVariables', request.setVariableData.length, request);
      const { results, changed: keys } = deviceModel.setVariables(request.setVariableData);
      for (const key of keys) variableChanged(key);
      if (keys.length > 0) changed();
      return { setVariableResult: results as typeof results & [unknown] };
    },

    GetBaseReport(request) {
      const report = deviceModel.baseReport(request.reportBase);
      if (report === undefined) return { status: 'NotSupported' };
      sendReport(request.requestId, report);
      return { status: 'Accepted' };
    },

    GetReport(request) {
      checkLimits('GetReport', request.componentVariable?.length ?? 0, request);
      const report = deviceModel.customReport(request.componentCriteria, request.componentVariable);
      if (report.length === 0) return { status: 'EmptyResultSet' };
      sendReport(request.requestId, report);
      return { status: 'Accepted' };
    },

    ChangeAvailability(request) {
      const availability: Availability = request.operationalStatus;
      // No EVSE: the whole station. An EVSE: its connector (one per EVSE).
      let connectorId = 0;
      if (request.evse !== undefined) {
        const connector = findConnector(station, request.evse.id);
        if (connector === undefined || (request.evse.connectorId ?? 1) !== 1) {
          return { status: 'Rejected' };
        }
        connectorId = connector.connectorId;
      }
      const result = reduce(
        station,
        { type: 'ChangeAvailability', connectorId, availability },
        now(),
      );
      if (result.error !== undefined) return { status: 'Rejected' };
      // Answer first, then apply and report (B11.FR.04).
      later(timing.actionDelaysMs?.ChangeAvailability ?? timing.actionDelayMs, () =>
        applyDevice({ type: 'ChangeAvailability', connectorId, availability }),
      );
      return { status: result.changeAvailability ?? 'Accepted' };
    },
  };

  // ---- Restore after a restart --------------------------------------------

  const restored = options.restore;
  if (restored !== undefined) {
    outbox.restore(restored.outbox);
    // Transactions the power cut interrupted end now, as of the save (E06.FR.16).
    for (const saved of restored.transactions ?? []) {
      const final = sampleMeter201(
        energy.meter(saved.connectorId),
        restored.savedAt,
        dmValue('SampledDataCtrlr', 'TxEndedMeasurands'),
        'Transaction.End',
      );
      void outbox.restore([
        {
          key: nextKey('msg'),
          action: 'TransactionEvent',
          txRef: saved.transactionId,
          attempts: 0,
          payload: {
            eventType: 'Ended',
            timestamp: new Date(restored.savedAt).toISOString(),
            triggerReason: 'AbnormalCondition',
            seqNo: saved.seqNo,
            transactionInfo: {
              transactionId: saved.transactionId,
              stoppedReason: saved.stoppedReason ?? 'PowerLoss',
            },
            offline: true,
            evse: { id: saved.connectorId, connectorId: 1 },
            ...(final !== undefined && { meterValue: [final] }),
          },
        },
      ]);
    }
    for (const [id, availability] of Object.entries(restored.availability.connectors)) {
      const connectorId = Number(id);
      if (availability === 'Inoperative' && findConnector(station, connectorId) !== undefined) {
        station = reduce(
          station,
          { type: 'ChangeAvailability', connectorId, availability },
          now(),
        ).state;
      }
    }
    if (restored.availability.station === 'Inoperative') {
      station = reduce(
        station,
        { type: 'ChangeAvailability', connectorId: 0, availability: 'Inoperative' },
        now(),
      ).state;
    }
  }

  // ---- Public interface ---------------------------------------------------

  // Clock-aligned sampling runs from the start, offline too: its events queue.
  scheduleAligned();

  return {
    ocpp: '2.0.1',

    connected() {
      rpc?.close();
      rpc = createRpc<Ocpp201RpcTypes>({
        clock,
        ids,
        send: options.send,
        messages: OCPP201_MESSAGE_SET,
        handlers,
        onEvent: (event) => emit({ type: 'rpc', event }),
      });
      void boot();
    },

    disconnected() {
      rpc?.close();
      rpc = undefined;
      registration = 'Offline';
      for (const timer of [heartbeatTimer, bootTimer]) stopTimer(timer);
      heartbeatTimer = bootTimer = undefined;
      outbox.pause();
      changed();
    },

    halt() {
      timers.halt();
      rpc?.close();
      rpc = undefined;
    },

    receive(text) {
      rpc?.receive(text);
    },

    plugIn(connectorId, ev?: PluggedEv) {
      if (findConnector(station, connectorId) === undefined) {
        log(`Plug: unknown connector ${connectorId}`);
        return;
      }
      // Throws a RangeError for an unusable profile, before anything changes.
      if (ev !== undefined) energy.plugEv(connectorId, ev);
      if (applyDevice({ type: 'Plug', connectorId }).error !== undefined) return;
      stopTimer(connectTimers.get(connectorId));
      connectTimers.delete(connectorId);
      evaluate(connectorId, 'CablePluggedIn');
    },

    unplug(connectorId) {
      const connector = findConnector(station, connectorId);
      if (connector === undefined) {
        log(`Unplug: unknown connector ${connectorId}`);
        return 'unknown-connector';
      }
      if (connector.locked) {
        log(`connector ${connectorId}: the cable is locked`);
        return 'locked';
      }
      energy.sync(connectorId);
      applyDevice({ type: 'Unplug', connectorId });
      if (
        transactions.has(connectorId) &&
        dmValue('TxCtrlr', 'StopTxOnEVSideDisconnect') !== 'false'
      ) {
        // The EV left: the transaction ends whatever the stop points say (E09).
        endTransaction(connectorId, 'EVCommunicationLost', 'EVDisconnected');
      } else {
        evaluate(connectorId, 'EVCommunicationLost');
      }
      if (energy.removeEv(connectorId)) changed();
      return 'unplugged';
    },

    async presentIdTag(connectorId, token, type = 'ISO14443'): Promise<IdTagResult> {
      const connector = findConnector(station, connectorId);
      if (connector === undefined) return 'unknown-connector';
      const idToken: IdTokenType = { idToken: token, type: type as IdTokenEnumType };
      const current =
        authorizations.get(connectorId)?.idToken ?? transactions.get(connectorId)?.idToken;
      if (current !== undefined) {
        // The same token ends the session (E07); another one is refused here.
        if (current.idToken !== token || current.type !== idToken.type) return 'busy';
        deauthorize(connectorId, 'StopAuthorized', 'Local', idToken);
        return 'stopping';
      }
      if (!(await authorize(idToken))) {
        log(`connector ${connectorId}: ${token} rejected`);
        return 'rejected';
      }
      authorizations.set(connectorId, { idToken });
      if (!connector.plugged) awaitCable(connectorId);
      evaluate(connectorId, 'Authorized', idToken);
      return 'authorized';
    },

    evSuspend(connectorId) {
      if (applyDevice({ type: 'EvSuspend', connectorId }).error === undefined) {
        evaluate(connectorId, 'ChargingStateChanged');
      }
    },

    evResume(connectorId) {
      if (!energy.canResume(connectorId)) {
        log(`connector ${connectorId}: the EV is full and does not resume`);
        return;
      }
      if (applyDevice({ type: 'EvResume', connectorId }).error === undefined) {
        evaluate(connectorId, 'ChargingStateChanged');
      }
    },

    setMeterRegister(connectorId, energyWh) {
      if (findConnector(station, connectorId) === undefined) {
        log(`meter: unknown connector ${connectorId}`);
        return;
      }
      const before = energy.setRegister(connectorId, energyWh);
      log(
        `meter of connector ${connectorId} set from ${Math.round(before)} to ${Math.round(Math.max(0, energyWh))} Wh`,
      );
      changed();
    },

    raiseFault(connectorId, fault) {
      if (applyDevice({ type: 'FaultRaised', connectorId, ...fault }).error !== undefined) return;
      // A fault stops the transactions it affects (E06.FR.16).
      const affected = connectorId === 0 ? [...transactions.keys()] : [connectorId];
      for (const id of affected) {
        if (transactions.has(id)) endTransaction(id, 'AbnormalCondition', 'Other');
        else updatePower(id);
      }
    },

    clearFault(connectorId) {
      if (applyDevice({ type: 'FaultCleared', connectorId }).error !== undefined) return;
      for (const connector of connectors(station)) updatePower(connector.connectorId);
    },

    dataTransfer(request) {
      const sent = sendIfOnline('DataTransfer', request as Ocpp201RequestOf<'DataTransfer'>);
      return (sent ?? Promise.resolve({ ok: false, failure: { kind: 'Closed' } })) as Promise<
        CallOutcome<'DataTransfer'>
      >;
    },

    setBehaviour(changes) {
      behaviour = { ...behaviour, ...changes };
      for (const connector of connectors(station)) updateLock(connector.connectorId);
      changed();
    },

    setEnergyMultiplier(multiplier) {
      energy.setMultiplier(checkedMultiplier(multiplier));
      changed();
    },

    snapshot(): ChargePointSnapshot {
      return {
        ocpp: '2.0.1',
        registration,
        connected: rpc !== undefined,
        station: { status: stationStatus201(station), errorCode: 'NoError' },
        connectors: connectors(station).map((connector) => {
          const reading = energy.sync(connector.connectorId);
          const ev = energy.ev(connector.connectorId);
          const tx = transactions.get(connector.connectorId);
          const token = authorizations.get(connector.connectorId)?.idToken ?? tx?.idToken;
          return {
            connectorId: connector.connectorId,
            evseId: connector.connectorId,
            status: connectorStatus201(connector, station),
            errorCode: connector.fault === undefined ? 'NoError' : connector.fault.errorCode,
            plugged: connector.plugged,
            locked: connector.locked,
            chargingState: currentChargingState(connector.connectorId),
            ...(tx !== undefined && { transactionId: tx.id }),
            ...(token !== undefined && { idTag: token.idToken }),
            energyWh: reading.energyWh,
            powerW: reading.powerW,
            ...(ev !== undefined && {
              ev: {
                ...(ev.name !== undefined && { name: ev.name }),
                soc: ev.state.soc,
                profile: ev.state.profile,
              },
            }),
          };
        }),
        // The Device Model's readable Actual values, keyed `component/variable`.
        config: Object.fromEntries(
          deviceModel
            .definitions()
            .filter((d) => d.attributes.Actual?.mutability !== 'WriteOnly')
            .map((d) => {
              const component = componentKey(d.component);
              const variable = variableKey(d.variable);
              return [`${component}/${variable}`, deviceModel.get(component, variable) ?? ''];
            }),
        ),
        queuedMessages: outbox.entries.length,
        ...(options.boot.firmwareVersion !== undefined && {
          firmwareVersion: options.boot.firmwareVersion,
        }),
        firmwareStatus: 'Idle',
        diagnosticsStatus: 'Idle',
        logStatus: 'Idle',
        signedFirmwareStatus: 'Idle',
        certificates: { centralSystemRoots: 0, manufacturerRoots: 0, chargePoint: false },
        securityEvents: [],
        behaviour: { ...behaviour },
        energyMultiplier: energy.multiplier,
        localList: { version: 0, size: 0 },
        reservations: [],
        chargingProfiles: [],
      };
    },

    persistentState(): PersistedChargePoint201 {
      return {
        version: 1,
        ocpp: '2.0.1',
        savedAt: now(),
        meters: energy.registers(),
        outbox: outbox.entries.map((entry) => ({ ...entry })),
        sequence,
        behaviour: { ...behaviour },
        energyMultiplier: energy.multiplier,
        availability: {
          station: station.scheduledAvailability ?? station.availability,
          connectors: Object.fromEntries(
            connectors(station).map((c) => [
              String(c.connectorId),
              c.scheduledAvailability ?? c.availability,
            ]),
          ),
        },
        deviceModel: deviceModel.persistentValues(),
        transactions: [...transactions].map(([connectorId, tx]) => ({
          connectorId,
          transactionId: tx.id,
          seqNo: tx.seqNo,
          startedAt: tx.startedAt,
          meterStartWh: tx.meterStartWh,
          ...(tx.idToken !== undefined && { idToken: tx.idToken }),
          ...(tx.remoteStartId !== undefined && { remoteStartId: tx.remoteStartId }),
          ...(tx.stoppedReason !== undefined && { stoppedReason: tx.stoppedReason }),
        })),
      };
    },

    connectionSecurity() {
      return { profile: 0, centralSystemRoots: [] };
    },

    securityEvent(type, techInfo) {
      log(`security event ${type}${techInfo === undefined ? '' : ` (${techInfo})`}`);
    },

    connectionFailed() {},
  };
}
