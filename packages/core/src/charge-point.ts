/**
 * A complete OCPP 1.6J charge point for M1 (the Core profile plus
 * TriggerMessage), assembled from the pure modules: device model,
 * configuration, authorization, meter, transactions and RPC.
 *
 * It does no IO. The engine connects it to a socket: it calls `connected()`
 * / `disconnected()` / `receive()` and passes `send` and `restart`. Physical
 * actions (plug, unplug, cards, faults, EV suspension) come in through the
 * methods below. Timers run on the injected clock.
 */
import {
  cachedAuthorization,
  clearAuthorizationCache,
  decideLocalAuthorization,
  EMPTY_AUTHORIZATION_CACHE,
  isAccepted,
  rememberAuthorization,
  type AuthorizationCache,
} from './auth.js';
import type { Clock, TimerHandle } from './clock.js';
import {
  changeConfiguration,
  configBool,
  configInt,
  createConfig,
  getConfiguration,
  type ConfigKeyDefinition,
  type ConfigState,
} from './config.js';
import {
  connectorStatus,
  connectors,
  createStation,
  findConnector,
  reduce,
  stationStatus,
  type DeviceEvent,
  type Fault,
  type ReduceResult,
  type StationState,
} from './device.js';
import type { IdGenerator } from './ids.js';
import {
  createMeter,
  meterAt,
  nextAlignedSample,
  nextPeriodicSample,
  withPower,
  type MeterState,
} from './meter.js';
import type { RequestOf, ResponseOf, StopReason } from './ocpp16-messages.js';
import type { JsonObject } from './ocppj.js';
import {
  createRpc,
  type CallOutcome,
  type ChargePointAction,
  type CsmsHandlers,
  type Rpc,
  type RpcEvent,
} from './rpc.js';
import {
  applyStartResponse,
  meterValuesRequest,
  startTransaction,
  stopTransactionRequest,
  type Transaction,
} from './transaction.js';

export interface ChargePointTiming {
  /** Delay between a connector becoming ready (authorized and plugged in) and StartTransaction. */
  startTransactionDelayMs: number;
  /** Delay between answering a CSMS command (RemoteStop, Reset, Unlock, Trigger) and acting on it. */
  actionDelayMs: number;
  /** Per-command overrides of actionDelayMs. */
  actionDelaysMs?: Partial<Record<DelayedCommand, number>>;
  /** How long the charge point stays offline during a reset, by reset type. */
  resetDowntimeMs: { Soft: number; Hard: number };
  /** Retry delay for BootNotification when the CSMS gives no usable interval. */
  bootRetryMs: number;
}

/** CSMS commands the charge point answers first and acts on after a delay. */
export type DelayedCommand =
  | 'ChangeAvailability'
  | 'RemoteStartTransaction'
  | 'RemoteStopTransaction'
  | 'Reset'
  | 'UnlockConnector'
  | 'TriggerMessage';

export const DEFAULT_TIMING: ChargePointTiming = {
  startTransactionDelayMs: 500,
  actionDelayMs: 100,
  resetDowntimeMs: { Soft: 30_000, Hard: 180_000 },
  bootRetryMs: 60_000,
};

export type Registration = 'Offline' | 'Booting' | 'Pending' | 'Rejected' | 'Accepted';

export type ChargePointEvent =
  | { type: 'rpc'; event: RpcEvent }
  | { type: 'log'; message: string }
  /** Something observable changed (status, transaction, registration). */
  | { type: 'changed' };

type TransactionAction = 'StartTransaction' | 'StopTransaction' | 'MeterValues';

/** A transaction-related message waiting to be sent; kept across restarts. */
export interface OutboxEntry {
  key: string;
  action: TransactionAction;
  payload: JsonObject;
  /** Local reference of the transaction whose CSMS id is put into payload.transactionId on sending. */
  txRef?: string;
  /** Failed attempts so far (TransactionMessageAttempts). */
  attempts: number;
}

export interface PersistedTransaction {
  connectorId: number;
  ref: string;
  idTag: string;
  startedAt: number;
  meterStartWh: number;
  transactionId?: number;
}

/** Everything a charge point keeps across an engine restart. */
export interface PersistedChargePoint {
  version: 1;
  /** When the state was taken (ms since the epoch); restored transactions end at this time. */
  savedAt: number;
  config: Record<string, string>;
  /** connectorId → energy register in Wh. */
  meters: Record<string, number>;
  authCache: AuthorizationCache;
  transactions: PersistedTransaction[];
  outbox: OutboxEntry[];
  /** Transaction reference → transactionId given by the CSMS. */
  csmsIds: Record<string, number>;
  sequence: number;
}

export interface ChargePointOptions {
  clock: Clock;
  ids: IdGenerator;
  /** The BootNotification payload: vendor, model, serial numbers, firmware. */
  boot: RequestOf<'BootNotification'>;
  connectors: number;
  config?: {
    definitions?: Readonly<Record<string, ConfigKeyDefinition>>;
    values?: Readonly<Record<string, string>>;
  };
  timing?: Partial<ChargePointTiming>;
  /** Power each connector offers, in W. Default 7360 (32 A at 230 V). */
  offeredPowerW?: number;
  /** Power the EV draws when allowed, in W. Default: everything offered. */
  evPowerW?: number;
  /** Sends a text frame over the connection. */
  send: (text: string) => void;
  /** Asks the transport to drop the connection and reconnect after `downtimeMs` (reset). */
  restart?: (downtimeMs: number) => void;
  onEvent?: (event: ChargePointEvent) => void;
  /**
   * State saved by persistentState() before a restart. Configuration, meters,
   * the authorization cache and queued messages carry over; transactions that
   * were running end with a StopTransaction (reason PowerLoss) at the time of
   * the save, as after a power cut.
   */
  restore?: PersistedChargePoint;
}

export interface ConnectorSnapshot {
  connectorId: number;
  status: string;
  errorCode: string;
  plugged: boolean;
  locked: boolean;
  transactionId?: number;
  idTag?: string;
  energyWh: number;
  powerW: number;
}

export interface ChargePointSnapshot {
  registration: Registration;
  connected: boolean;
  station: { status: string; errorCode: string };
  connectors: ConnectorSnapshot[];
  config: Readonly<Record<string, string>>;
  /** Transaction messages waiting to be sent. */
  queuedMessages: number;
}

export type IdTagResult = 'stopping' | 'authorized' | 'rejected' | 'busy' | 'unknown-connector';

export interface ChargePoint {
  connected(): void;
  disconnected(): void;
  receive(text: string): void;
  plugIn(connectorId: number): void;
  unplug(connectorId: number): void;
  /** A card presented at `connectorId`: starts, or stops the transaction the card started. */
  presentIdTag(connectorId: number, idTag: string): Promise<IdTagResult>;
  evSuspend(connectorId: number): void;
  evResume(connectorId: number): void;
  raiseFault(connectorId: number, fault: Fault): void;
  clearFault(connectorId: number): void;
  dataTransfer(request: RequestOf<'DataTransfer'>): Promise<CallOutcome<'DataTransfer'>>;
  snapshot(): ChargePointSnapshot;
  /** The state to save for a restart; see ChargePointOptions.restore. */
  persistentState(): PersistedChargePoint;
}

export function createChargePoint(options: ChargePointOptions): ChargePoint {
  const { clock, ids } = options;
  const timing: ChargePointTiming = { ...DEFAULT_TIMING, ...options.timing };
  const offeredW = options.offeredPowerW ?? 7360;
  const evPowerW = options.evPowerW ?? offeredW;
  const emit = options.onEvent ?? (() => {});
  const log = (message: string) => emit({ type: 'log', message });
  const changed = () => emit({ type: 'changed' });

  let config: ConfigState = createConfig({
    numberOfConnectors: options.connectors,
    ...(options.config?.definitions !== undefined && { definitions: options.config.definitions }),
    ...(options.config?.values !== undefined && { values: options.config.values }),
  });
  let station: StationState = createStation(options.connectors);
  let authCache: AuthorizationCache = EMPTY_AUTHORIZATION_CACHE;
  const meters = new Map<number, MeterState>(
    connectors(station).map((c) => [c.connectorId, createMeter({ now: clock.now(), offeredW })]),
  );
  const transactions = new Map<number, Transaction>();
  /** connectorId → local reference of its running transaction. */
  const refs = new Map<number, string>();
  const outbox: OutboxEntry[] = [];
  const csmsIds = new Map<string, number>();
  const waiters = new Map<string, (outcome: CallOutcome<ChargePointAction>) => void>();
  let sequence = options.restore?.sequence ?? 0;
  const nextKey = (prefix: string) => `${prefix}-${++sequence}`;
  let pumping = false;
  let retryTimer: TimerHandle | undefined;
  /** Cards authorized at a connector whose transaction has not started yet. */
  const authorized = new Map<number, string>();
  const prepareTimers = new Map<number, TimerHandle>();
  const sampleTimers = new Map<number, TimerHandle>();

  let rpc: Rpc | undefined;
  let registration: Registration = 'Offline';
  let heartbeatTimer: TimerHandle | undefined;
  let bootTimer: TimerHandle | undefined;
  let alignedTimer: TimerHandle | undefined;

  const online = () => rpc !== undefined && registration === 'Accepted';
  const now = () => clock.now();
  const later = (delayMs: number, fn: () => unknown) => clock.setTimer(delayMs, () => void fn());
  const delayFor = (command: DelayedCommand) =>
    timing.actionDelaysMs?.[command] ?? timing.actionDelayMs;
  const stopTimer = (timer: TimerHandle | undefined) => {
    if (timer !== undefined) clock.clearTimer(timer);
  };

  // ---- Sending ------------------------------------------------------------

  /** Sends now when registered; otherwise drops the message (status reports, heartbeats). */
  function sendIfOnline<A extends ChargePointAction>(
    action: A,
    payload: RequestOf<A>,
  ): Promise<CallOutcome<A>> | undefined {
    return online() ? rpc?.call(action, payload) : undefined;
  }

  /**
   * Transaction messages go through the outbox: sent one at a time once
   * registered, kept while offline, retried TransactionMessageAttempts times
   * on failure (waiting TransactionMessageRetryInterval × attempts), and
   * persisted across restarts. When online and idle, the message is handed
   * to the RPC layer at once, so it goes out before later status reports.
   */
  function enqueue<A extends TransactionAction>(
    action: A,
    payload: RequestOf<A>,
    txRef?: string,
  ): Promise<CallOutcome<A>> {
    const key = nextKey('msg');
    outbox.push({
      key,
      action,
      payload: payload as JsonObject,
      ...(txRef !== undefined && { txRef }),
      attempts: 0,
    });
    const promise = new Promise<CallOutcome<A>>((resolve) =>
      waiters.set(key, resolve as (outcome: CallOutcome<ChargePointAction>) => void),
    );
    changed();
    pump();
    return promise;
  }

  function settleEntry(entry: OutboxEntry, outcome: CallOutcome<ChargePointAction>): void {
    if (outbox[0] === entry) outbox.shift();
    waiters.get(entry.key)?.(outcome);
    waiters.delete(entry.key);
    changed();
  }

  function pump(): void {
    if (pumping || retryTimer !== undefined || !online()) return;
    const entry = outbox[0];
    const current = rpc;
    if (entry === undefined || current === undefined) return;
    let payload = entry.payload;
    // StartTransaction obtains the id; the messages behind it carry it.
    if (entry.txRef !== undefined && entry.action !== 'StartTransaction') {
      const id = csmsIds.get(entry.txRef);
      if (id === undefined) {
        log(`${entry.action} dropped: its transaction never got an id from the CSMS`);
        settleEntry(entry, { ok: false, failure: { kind: 'Closed' } });
        pump();
        return;
      }
      payload = { ...payload, transactionId: id };
    }
    pumping = true;
    void current
      .call(entry.action, payload as never)
      .then((outcome: CallOutcome<ChargePointAction>) => {
        pumping = false;
        if (!outcome.ok) {
          if (outcome.failure.kind === 'Closed') return; // resumes after the next accepted boot
          if (outcome.failure.kind !== 'InvalidRequest') {
            entry.attempts += 1;
            if (entry.attempts < configInt(config, 'TransactionMessageAttempts')) {
              const delayMs =
                configInt(config, 'TransactionMessageRetryInterval') * 1000 * entry.attempts;
              log(`${entry.action} failed (${outcome.failure.kind}); retrying in ${delayMs} ms`);
              changed();
              retryTimer = later(delayMs, () => {
                retryTimer = undefined;
                pump();
              });
              return;
            }
            log(`${entry.action} dropped after ${entry.attempts} failed attempts`);
          }
        } else if (entry.action === 'StartTransaction' && entry.txRef !== undefined) {
          csmsIds.set(
            entry.txRef,
            (outcome.payload as ResponseOf<'StartTransaction'>).transactionId,
          );
        }
        settleEntry(entry, outcome);
        pump();
      });
  }

  function applyDevice(event: DeviceEvent): ReduceResult {
    const result = reduce(station, event, now());
    if (result.error !== undefined) {
      log(result.error);
      return result;
    }
    station = result.state;
    for (const message of result.messages) void sendIfOnline('StatusNotification', message);
    changed();
    return result;
  }

  // ---- Registration and heartbeats -------------------------------------

  async function boot(): Promise<void> {
    const current = rpc;
    if (current === undefined) return;
    registration = 'Booting';
    changed();
    const outcome = await current.call('BootNotification', options.boot);
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
    if (interval > 0) {
      config = changeConfiguration(config, {
        key: 'HeartbeatInterval',
        value: String(interval),
      }).config;
    }
    startHeartbeat();
    scheduleAligned();
    applyDevice({ type: 'ReportAll' });
    pump();
  }

  function startHeartbeat(): void {
    stopTimer(heartbeatTimer);
    heartbeatTimer = undefined;
    const intervalS = configInt(config, 'HeartbeatInterval');
    if (intervalS <= 0) return;
    heartbeatTimer = later(intervalS * 1000, () => {
      void sendIfOnline('Heartbeat', {});
      startHeartbeat();
    });
  }

  // ---- Metering ----------------------------------------------------------

  function meter(connectorId: number): MeterState {
    const value = meters.get(connectorId);
    if (value === undefined) throw new Error(`no meter for connector ${connectorId}`);
    return value;
  }

  function setPower(connectorId: number, powerW: number): void {
    meters.set(connectorId, withPower(meter(connectorId), now(), powerW));
  }

  /** Power the EV draws on a connector, given its transaction and suspension state. */
  function updatePower(connectorId: number): void {
    const connector = findConnector(station, connectorId);
    const running =
      connector?.transactionId !== undefined &&
      connector.plugged &&
      !connector.evSuspended &&
      !connector.evseSuspended;
    setPower(connectorId, running ? evPowerW : 0);
  }

  function sendMeterValues(
    connectorId: number,
    configKey: 'MeterValuesSampledData' | 'MeterValuesAlignedData',
    context: 'Sample.Periodic' | 'Sample.Clock' | 'Trigger',
  ): void {
    const transaction = transactions.get(connectorId);
    const ref = refs.get(connectorId);
    const transactionId = transaction?.transactionId;
    const request = meterValuesRequest({
      connectorId,
      meter: meter(connectorId),
      config,
      now: now(),
      configKey,
      context,
      ...(transactionId !== undefined && { transactionId }),
    });
    if (request === undefined) return;
    if (transaction !== undefined && ref !== undefined) {
      void enqueue('MeterValues', { ...request, transactionId: transactionId ?? 0 }, ref);
    } else {
      void sendIfOnline('MeterValues', request);
    }
  }

  function schedulePeriodic(connectorId: number): void {
    stopTimer(sampleTimers.get(connectorId));
    sampleTimers.delete(connectorId);
    const transaction = transactions.get(connectorId);
    if (transaction === undefined) return;
    const due = nextPeriodicSample(
      transaction.startedAt,
      configInt(config, 'MeterValueSampleInterval'),
      now(),
    );
    if (due === undefined) return;
    sampleTimers.set(
      connectorId,
      later(due - now(), () => {
        sendMeterValues(connectorId, 'MeterValuesSampledData', 'Sample.Periodic');
        schedulePeriodic(connectorId);
      }),
    );
  }

  function scheduleAligned(): void {
    stopTimer(alignedTimer);
    alignedTimer = undefined;
    const due = nextAlignedSample(configInt(config, 'ClockAlignedDataInterval'), now());
    if (due === undefined) return;
    alignedTimer = later(due - now(), () => {
      for (const connectorId of transactions.keys()) {
        sendMeterValues(connectorId, 'MeterValuesAlignedData', 'Sample.Clock');
      }
      scheduleAligned();
    });
  }

  // ---- Transactions ------------------------------------------------------

  function clearPrepare(connectorId: number): void {
    stopTimer(prepareTimers.get(connectorId));
    prepareTimers.delete(connectorId);
  }

  /** A card is authorized at a connector: start when plugged in, or wait ConnectionTimeOut for the cable. */
  function authorizeConnector(connectorId: number, idTag: string): void {
    authorized.set(connectorId, idTag);
    applyDevice({ type: 'Prepare', connectorId });
    if (findConnector(station, connectorId)?.plugged === true) {
      later(timing.startTransactionDelayMs, () => beginTransaction(connectorId));
      return;
    }
    clearPrepare(connectorId);
    const timeoutS = configInt(config, 'ConnectionTimeOut');
    if (timeoutS > 0) {
      prepareTimers.set(
        connectorId,
        later(timeoutS * 1000, () => {
          prepareTimers.delete(connectorId);
          if (authorized.delete(connectorId)) {
            log(`connector ${connectorId}: no cable within ConnectionTimeOut`);
            applyDevice({ type: 'CancelPrepare', connectorId });
          }
        }),
      );
    }
  }

  async function beginTransaction(connectorId: number): Promise<void> {
    const idTag = authorized.get(connectorId);
    const connector = findConnector(station, connectorId);
    if (
      idTag === undefined ||
      connector === undefined ||
      !connector.plugged ||
      transactions.has(connectorId)
    ) {
      return;
    }
    authorized.delete(connectorId);
    clearPrepare(connectorId);
    const started = startTransaction({
      connectorId,
      idTag,
      meter: meter(connectorId),
      config,
      now: now(),
    });
    const ref = nextKey('tx');
    transactions.set(connectorId, started.transaction);
    refs.set(connectorId, ref);
    changed();

    const outcome = await enqueue('StartTransaction', started.request, ref);
    const stillRunning = transactions.get(connectorId) === started.transaction;
    if (!outcome.ok) {
      log(`StartTransaction failed: ${outcome.failure.kind}`);
      if (stillRunning) {
        transactions.delete(connectorId);
        refs.delete(connectorId);
        applyDevice({ type: 'CancelPrepare', connectorId });
      }
      return;
    }
    authCache = rememberAuthorization(authCache, config, idTag, outcome.payload.idTagInfo);
    // Stopped while waiting for the answer: its StopTransaction is queued behind and gets this id.
    if (!stillRunning) return;
    const applied = applyStartResponse(started.transaction, outcome.payload, config, now());
    transactions.set(connectorId, applied.transaction);
    applyDevice({
      type: 'TransactionStarted',
      connectorId,
      transactionId: outcome.payload.transactionId,
    });

    switch (applied.decision) {
      case 'continue':
        updatePower(connectorId);
        schedulePeriodic(connectorId);
        break;
      case 'stop':
        await endTransaction(connectorId, 'DeAuthorized');
        break;
      case 'suspend':
        applyDevice({ type: 'EvseSuspend', connectorId });
        updatePower(connectorId);
        break;
    }
  }

  /** Ends the connector's transaction: StopTransaction first, then the status change. */
  async function endTransaction(
    connectorId: number,
    reason: StopReason,
    idTag?: string,
  ): Promise<void> {
    const transaction = transactions.get(connectorId);
    if (transaction === undefined) return;
    const ref = refs.get(connectorId);
    transactions.delete(connectorId);
    refs.delete(connectorId);
    stopTimer(sampleTimers.get(connectorId));
    sampleTimers.delete(connectorId);
    const stoppedAt = now();
    const meterAtStop = meterAt(meter(connectorId), stoppedAt);
    setPower(connectorId, 0);

    const request = stopTransactionRequest({
      transaction: { ...transaction, transactionId: transaction.transactionId ?? 0 },
      meter: meterAtStop,
      config,
      now: stoppedAt,
      reason,
      ...(idTag !== undefined && { idTag }),
    });
    // The transactionId is filled in from the StartTransaction answer when sent.
    const stopCall = ref !== undefined ? enqueue('StopTransaction', request, ref) : undefined;
    applyDevice({ type: 'TransactionEnded', connectorId });

    const outcome = await stopCall;
    if (outcome?.ok === true && outcome.payload.idTagInfo !== undefined) {
      authCache = rememberAuthorization(
        authCache,
        config,
        transaction.idTag,
        outcome.payload.idTagInfo,
      );
    }
  }

  async function authorizeWithCsms(idTag: string): Promise<boolean> {
    const outcome = await sendIfOnline('Authorize', { idTag });
    if (outcome === undefined || !outcome.ok) return false;
    authCache = rememberAuthorization(authCache, config, idTag, outcome.payload.idTagInfo);
    return isAccepted(outcome.payload.idTagInfo, now());
  }

  async function resetChargePoint(type: 'Soft' | 'Hard'): Promise<void> {
    const reason: StopReason = type === 'Soft' ? 'SoftReset' : 'HardReset';
    await Promise.all(
      [...transactions.keys()].map((connectorId) => endTransaction(connectorId, reason)),
    );
    for (const connectorId of [...authorized.keys()]) {
      authorized.delete(connectorId);
      clearPrepare(connectorId);
      applyDevice({ type: 'CancelPrepare', connectorId });
    }
    log(`${type} reset`);
    options.restart?.(timing.resetDowntimeMs[type]);
  }

  // ---- Commands from the CSMS ---------------------------------------------

  function idle(connectorId: number): boolean {
    const connector = findConnector(station, connectorId);
    if (connector === undefined || transactions.has(connectorId)) return false;
    const status = connectorStatus(connector, station).status;
    return status === 'Available' || status === 'Preparing';
  }

  const handlers: CsmsHandlers = {
    ChangeAvailability(request) {
      if (request.connectorId !== 0 && findConnector(station, request.connectorId) === undefined) {
        return { status: 'Rejected' };
      }
      const event: DeviceEvent = {
        type: 'ChangeAvailability',
        connectorId: request.connectorId,
        availability: request.type,
      };
      // Answer first and apply the change after the command delay, so the
      // StatusNotification follows the CALLRESULT as on real charge points.
      const preview = reduce(station, event, now());
      if (preview.error !== undefined) return { status: 'Rejected' };
      later(delayFor('ChangeAvailability'), () => applyDevice(event));
      return { status: preview.changeAvailability ?? 'Rejected' };
    },

    ChangeConfiguration(request) {
      const result = changeConfiguration(config, request);
      config = result.config;
      if (result.status === 'Accepted' || result.status === 'RebootRequired') {
        if (request.key === 'HeartbeatInterval') startHeartbeat();
        if (request.key === 'MeterValueSampleInterval')
          [...transactions.keys()].forEach(schedulePeriodic);
        if (request.key === 'ClockAlignedDataInterval') scheduleAligned();
        changed();
      }
      return { status: result.status };
    },

    ClearCache() {
      authCache = clearAuthorizationCache();
      return { status: 'Accepted' };
    },

    DataTransfer() {
      return { status: 'UnknownVendorId' };
    },

    GetConfiguration(request) {
      return getConfiguration(config, request);
    },

    RemoteStartTransaction(request) {
      const connectorId =
        request.connectorId ?? connectors(station).find((c) => idle(c.connectorId))?.connectorId;
      if (
        connectorId === undefined ||
        connectorId === 0 ||
        !idle(connectorId) ||
        authorized.has(connectorId)
      ) {
        return { status: 'Rejected' };
      }
      later(delayFor('RemoteStartTransaction'), async () => {
        if (
          configBool(config, 'AuthorizeRemoteTxRequests') &&
          !(await authorizeWithCsms(request.idTag))
        ) {
          log(`remote start: ${request.idTag} not authorized`);
          return;
        }
        authorizeConnector(connectorId, request.idTag);
      });
      return { status: 'Accepted' };
    },

    RemoteStopTransaction(request) {
      const connectorId = [...transactions.entries()].find(
        ([, transaction]) => transaction.transactionId === request.transactionId,
      )?.[0];
      if (connectorId === undefined) return { status: 'Rejected' };
      later(delayFor('RemoteStopTransaction'), () => endTransaction(connectorId, 'Remote'));
      return { status: 'Accepted' };
    },

    Reset(request) {
      later(delayFor('Reset'), () => resetChargePoint(request.type));
      return { status: 'Accepted' };
    },

    TriggerMessage(request) {
      const { connectorId } = request;
      if (
        connectorId !== undefined &&
        connectorId !== 0 &&
        findConnector(station, connectorId) === undefined
      ) {
        return { status: 'Rejected' };
      }
      const targets =
        connectorId === undefined || connectorId === 0
          ? connectors(station).map((c) => c.connectorId)
          : [connectorId];
      switch (request.requestedMessage) {
        case 'BootNotification':
          later(delayFor('TriggerMessage'), () => sendIfOnline('BootNotification', options.boot));
          return { status: 'Accepted' };
        case 'Heartbeat':
          later(delayFor('TriggerMessage'), () => sendIfOnline('Heartbeat', {}));
          return { status: 'Accepted' };
        case 'StatusNotification':
          later(delayFor('TriggerMessage'), () => {
            const timestamp = new Date(now()).toISOString();
            if (connectorId === undefined || connectorId === 0) {
              void sendIfOnline('StatusNotification', {
                connectorId: 0,
                ...stationStatus(station),
                timestamp,
              });
            }
            for (const id of targets) {
              const connector = findConnector(station, id);
              if (connector !== undefined) {
                void sendIfOnline('StatusNotification', {
                  connectorId: id,
                  ...connectorStatus(connector, station),
                  timestamp,
                });
              }
            }
          });
          return { status: 'Accepted' };
        case 'MeterValues':
          later(delayFor('TriggerMessage'), () =>
            targets.forEach((id) => sendMeterValues(id, 'MeterValuesSampledData', 'Trigger')),
          );
          return { status: 'Accepted' };
        default:
          return { status: 'NotImplemented' };
      }
    },

    UnlockConnector(request) {
      if (findConnector(station, request.connectorId) === undefined)
        return { status: 'NotSupported' };
      if (transactions.has(request.connectorId)) {
        later(delayFor('UnlockConnector'), () =>
          endTransaction(request.connectorId, 'UnlockCommand'),
        );
      }
      applyDevice({ type: 'Unlock', connectorId: request.connectorId });
      return { status: 'Unlocked' } satisfies ResponseOf<'UnlockConnector'>;
    },
  };

  // ---- Restore after a restart ------------------------------------------

  const restored = options.restore;
  if (restored !== undefined) {
    try {
      config = createConfig({
        numberOfConnectors: options.connectors,
        ...(options.config?.definitions !== undefined && {
          definitions: options.config.definitions,
        }),
        values: { ...options.config?.values, ...restored.config },
      });
    } catch (error) {
      log(
        `restored configuration ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const [id, energyWh] of Object.entries(restored.meters)) {
      const connectorId = Number(id);
      if (meters.has(connectorId)) {
        meters.set(connectorId, createMeter({ now: now(), offeredW, energyWh }));
      }
    }
    authCache = restored.authCache;
    outbox.push(...restored.outbox.map((entry) => ({ ...entry })));
    for (const [ref, id] of Object.entries(restored.csmsIds)) csmsIds.set(ref, id);
    for (const transaction of restored.transactions) {
      if (transaction.transactionId !== undefined)
        csmsIds.set(transaction.ref, transaction.transactionId);
      const energy = restored.meters[String(transaction.connectorId)] ?? transaction.meterStartWh;
      outbox.push({
        key: nextKey('msg'),
        action: 'StopTransaction',
        payload: {
          transactionId: transaction.transactionId ?? 0,
          meterStop: Math.max(transaction.meterStartWh, Math.round(energy)),
          timestamp: new Date(restored.savedAt).toISOString(),
          reason: 'PowerLoss',
        },
        txRef: transaction.ref,
        attempts: 0,
      });
    }
  }

  // ---- Public interface -------------------------------------------------

  return {
    connected() {
      rpc?.close();
      rpc = createRpc({
        clock,
        ids,
        send: options.send,
        handlers,
        onEvent: (event) => emit({ type: 'rpc', event }),
      });
      void boot();
    },

    disconnected() {
      rpc?.close();
      rpc = undefined;
      registration = 'Offline';
      for (const timer of [heartbeatTimer, bootTimer, alignedTimer, retryTimer]) stopTimer(timer);
      heartbeatTimer = bootTimer = alignedTimer = retryTimer = undefined;
      changed();
    },

    receive(text) {
      rpc?.receive(text);
    },

    plugIn(connectorId) {
      if (applyDevice({ type: 'Plug', connectorId }).error !== undefined) return;
      if (authorized.has(connectorId)) {
        clearPrepare(connectorId);
        later(timing.startTransactionDelayMs, () => beginTransaction(connectorId));
      }
    },

    unplug(connectorId) {
      if (applyDevice({ type: 'Unplug', connectorId }).error !== undefined) return;
      authorized.delete(connectorId);
      clearPrepare(connectorId);
      if (!transactions.has(connectorId)) return;
      if (configBool(config, 'StopTransactionOnEVSideDisconnect')) {
        void endTransaction(connectorId, 'EVDisconnected');
      } else {
        updatePower(connectorId);
      }
    },

    async presentIdTag(connectorId, idTag) {
      if (findConnector(station, connectorId) === undefined) return 'unknown-connector';
      const transaction = transactions.get(connectorId);
      if (transaction !== undefined) {
        const parent = cachedAuthorization(authCache, config, idTag)?.parentIdTag;
        const sameOwner =
          transaction.idTag === idTag ||
          (parent !== undefined &&
            parent === cachedAuthorization(authCache, config, transaction.idTag)?.parentIdTag);
        if (!sameOwner) return 'busy';
        void endTransaction(connectorId, 'Local', idTag);
        return 'stopping';
      }
      const decision = decideLocalAuthorization({
        cache: authCache,
        config,
        idTag,
        online: online(),
        now: now(),
      });
      const accepted =
        decision === 'start' || (decision === 'ask' && (await authorizeWithCsms(idTag)));
      if (!accepted) {
        log(`connector ${connectorId}: ${idTag} rejected`);
        return 'rejected';
      }
      authorizeConnector(connectorId, idTag);
      return 'authorized';
    },

    evSuspend(connectorId) {
      if (applyDevice({ type: 'EvSuspend', connectorId }).error === undefined)
        updatePower(connectorId);
    },

    evResume(connectorId) {
      if (applyDevice({ type: 'EvResume', connectorId }).error === undefined)
        updatePower(connectorId);
    },

    raiseFault(connectorId, fault) {
      if (applyDevice({ type: 'FaultRaised', connectorId, ...fault }).error !== undefined) return;
      const affected =
        connectorId === 0
          ? [...transactions.keys()]
          : transactions.has(connectorId)
            ? [connectorId]
            : [];
      affected.forEach((id) => void endTransaction(id, 'Other'));
    },

    clearFault(connectorId) {
      applyDevice({ type: 'FaultCleared', connectorId });
    },

    dataTransfer(request) {
      return (
        sendIfOnline('DataTransfer', request) ??
        Promise.resolve({ ok: false, failure: { kind: 'Closed' } })
      );
    },

    snapshot() {
      const station0 = stationStatus(station);
      return {
        registration,
        connected: rpc !== undefined,
        station: { status: station0.status, errorCode: station0.errorCode },
        connectors: connectors(station).map((connector) => {
          const status = connectorStatus(connector, station);
          const reading = meterAt(meter(connector.connectorId), now());
          const transaction = transactions.get(connector.connectorId);
          return {
            connectorId: connector.connectorId,
            status: status.status,
            errorCode: status.errorCode,
            plugged: connector.plugged,
            locked: connector.locked,
            ...(transaction?.transactionId !== undefined && {
              transactionId: transaction.transactionId,
            }),
            ...(transaction !== undefined && { idTag: transaction.idTag }),
            energyWh: reading.energyWh,
            powerW: reading.powerW,
          };
        }),
        config: config.values,
        queuedMessages: outbox.length,
      };
    },

    persistentState() {
      const savedAt = now();
      return {
        version: 1,
        savedAt,
        config: { ...config.values },
        meters: Object.fromEntries(
          [...meters].map(([id, value]) => [String(id), meterAt(value, savedAt).energyWh]),
        ),
        authCache,
        transactions: [...transactions].map(([connectorId, transaction]) => ({
          connectorId,
          ref: refs.get(connectorId) ?? '',
          idTag: transaction.idTag,
          startedAt: transaction.startedAt,
          meterStartWh: transaction.meterStartWh,
          ...(transaction.transactionId !== undefined && {
            transactionId: transaction.transactionId,
          }),
        })),
        outbox: outbox.map((entry) => ({ ...entry })),
        csmsIds: Object.fromEntries(csmsIds),
        sequence,
      };
    },
  };
}
