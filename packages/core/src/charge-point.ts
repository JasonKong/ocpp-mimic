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
  configList,
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
import {
  acceptedPowerW,
  advanceEv,
  createEv,
  evPowerW as evDrawW,
  msUntilFull,
  type EvProfile,
  type EvState,
} from './ev.js';
import {
  clearProfiles,
  compositeSchedule,
  connectorLimit,
  endTransactionProfiles,
  installProfile,
  stationLimit,
  toWatts,
  type ChargingRateUnit,
  type InstallContext,
  type InstalledProfile,
} from './charging-profile.js';
import type { IdGenerator } from './ids.js';
import { OCPP16_ACTION_PROFILES } from './ocpp16.js';
import {
  applySendLocalList,
  EMPTY_LOCAL_LIST,
  localListVersion,
  type LocalAuthList,
} from './local-list.js';
import {
  createMeter,
  meterAt,
  nextAlignedSample,
  nextPeriodicSample,
  withPower,
  type MeterState,
} from './meter.js';
import type { IdTagInfo, RequestOf, ResponseOf, StopReason } from './ocpp16-messages.js';
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

/** Test switches a station can flip at run time. */
export interface ChargePointBehaviour {
  /** Answer every RemoteStartTransaction with Rejected, to test how the CSMS handles it. */
  refuseRemoteStart: boolean;
  /**
   * Lock the cable while a transaction runs. A locked cable cannot be
   * unplugged; UnlockConnector or the end of the transaction releases it.
   */
  cableLock: boolean;
}

export const DEFAULT_BEHAVIOUR: ChargePointBehaviour = {
  refuseRemoteStart: false,
  cableLock: false,
};

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
  /** Missing in states saved before the switches existed. */
  behaviour?: ChargePointBehaviour;
  /** Missing in states saved before the energy multiplier existed. */
  energyMultiplier?: number;
  /** The Local Authorization List; missing in states saved before it existed. */
  localList?: LocalAuthList;
  /** Reservations not yet used or expired; missing in states saved before they existed. */
  reservations?: Reservation[];
  /** Installed charging profiles; missing in states saved before Smart Charging. */
  chargingProfiles?: InstalledProfile[];
}

/** A ReserveNow the station holds: a connector, or any connector with connectorId 0. */
export interface Reservation {
  reservationId: number;
  connectorId: number;
  idTag: string;
  parentIdTag?: string;
  /** expiryDate, as ms since the epoch. */
  expiresAt: number;
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
  /** Initial test switches; a restored state's switches take precedence. */
  behaviour?: Partial<ChargePointBehaviour>;
  /**
   * Energy (and SoC) advance this many times faster than real time; every
   * timestamp stays real. Default 1; a restored state's value takes precedence.
   */
  energyMultiplier?: number;
  /**
   * State saved by persistentState() before a restart. Configuration, meters,
   * the authorization cache and queued messages carry over; transactions that
   * were running end with a StopTransaction (reason PowerLoss) at the time of
   * the save, as after a power cut.
   */
  restore?: PersistedChargePoint;
}

/** An EV plugged into a connector: a profile, with the persona's name for it when it has one. */
export interface PluggedEv {
  name?: string;
  profile: EvProfile;
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
  /** The plugged-in EV, when the cable was plugged in with one. */
  ev?: { name?: string; soc: number; profile: EvProfile };
  /** The Smart Charging limit in force, in W, when a charging profile applies. */
  limitW?: number;
}

export interface ChargePointSnapshot {
  registration: Registration;
  connected: boolean;
  station: { status: string; errorCode: string };
  connectors: ConnectorSnapshot[];
  config: Readonly<Record<string, string>>;
  /** Transaction messages waiting to be sent. */
  queuedMessages: number;
  behaviour: ChargePointBehaviour;
  energyMultiplier: number;
  /** GetLocalListVersion's answer and the number of entries. */
  localList: { version: number; size: number };
  reservations: { reservationId: number; connectorId: number; idTag: string; expiryDate: string }[];
  chargingProfiles: {
    chargingProfileId: number;
    connectorId: number;
    purpose: string;
    stackLevel: number;
  }[];
}

export type IdTagResult = 'stopping' | 'authorized' | 'rejected' | 'busy' | 'unknown-connector';
export type UnplugResult = 'unplugged' | 'locked' | 'unknown-connector';

export interface ChargePoint {
  connected(): void;
  disconnected(): void;
  receive(text: string): void;
  /** Cable in; with an EV, power and SoC follow the EV model instead of a fixed power. */
  plugIn(connectorId: number, ev?: PluggedEv): void;
  /** Takes the cable out, unless the cable lock holds it. */
  unplug(connectorId: number): UnplugResult;
  /** A card presented at `connectorId`: starts, or stops the transaction the card started. */
  presentIdTag(connectorId: number, idTag: string): Promise<IdTagResult>;
  evSuspend(connectorId: number): void;
  evResume(connectorId: number): void;
  raiseFault(connectorId: number, fault: Fault): void;
  clearFault(connectorId: number): void;
  /** Changes test switches; turning the cable lock on or off applies to running transactions too. */
  setBehaviour(changes: Partial<ChargePointBehaviour>): void;
  /** Changes the energy multiplier from now on. Throws a RangeError unless it is above 0. */
  setEnergyMultiplier(multiplier: number): void;
  dataTransfer(request: RequestOf<'DataTransfer'>): Promise<CallOutcome<'DataTransfer'>>;
  snapshot(): ChargePointSnapshot;
  /** The state to save for a restart; see ChargePointOptions.restore. */
  persistentState(): PersistedChargePoint;
}

function checkedMultiplier(value: number): number {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`the energy multiplier must be a number above 0, got ${value}`);
  }
  return value;
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
  let behaviour: ChargePointBehaviour = {
    ...DEFAULT_BEHAVIOUR,
    ...options.behaviour,
    ...options.restore?.behaviour,
  };
  let energyMultiplier = checkedMultiplier(
    options.restore?.energyMultiplier ?? options.energyMultiplier ?? 1,
  );
  let authCache: AuthorizationCache = EMPTY_AUTHORIZATION_CACHE;
  let localList: LocalAuthList = options.restore?.localList ?? EMPTY_LOCAL_LIST;
  /** Whether the station advertises a feature profile in SupportedFeatureProfiles. */
  const supports = (profile: string) =>
    configList(config, 'SupportedFeatureProfiles').includes(profile);
  /** Caches an IdTagInfo answer, except for cards on the local list (section 3.5.3). */
  const remember = (idTag: string, info: IdTagInfo) => {
    if (localList.entries[idTag] !== undefined) return;
    authCache = rememberAuthorization(authCache, config, idTag, info);
  };
  const meters = new Map<number, MeterState>(
    connectors(station).map((c) => [c.connectorId, createMeter({ now: clock.now(), offeredW })]),
  );
  const transactions = new Map<number, Transaction>();
  /** Plugged-in EVs; `drawing` says whether the meter's power currently flows into the battery. */
  const evs = new Map<number, { name?: string; state: EvState; drawing: boolean }>();
  const fullTimers = new Map<number, TimerHandle>();
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

  // ---- Smart Charging -----------------------------------------------------

  // TxProfiles belonged to transactions that a restart ends.
  let chargingProfiles: InstalledProfile[] = (options.restore?.chargingProfiles ?? []).filter(
    (p) => p.profile.chargingProfilePurpose !== 'TxProfile',
  );
  let limitTimer: TimerHandle | undefined;
  /** connectorId → the TxProfile a RemoteStartTransaction brought, installed when its transaction starts. */
  const pendingTxProfiles = new Map<number, InstalledProfile['profile']>();

  const txInfo = (connectorId: number) => {
    const transaction = transactions.get(connectorId);
    if (transaction === undefined) return undefined;
    return {
      ...(transaction.transactionId !== undefined && { id: transaction.transactionId }),
      startedAt: transaction.startedAt,
    };
  };
  const conversionFor = (connectorId: number) => ({
    voltageV: meters.get(connectorId)?.voltageV ?? 230,
    phases: evs.get(connectorId)?.state.profile.phases ?? 3,
  });

  function profileContext(): InstallContext {
    const units = configList(config, 'ChargingScheduleAllowedChargingRateUnit')
      .map((unit) => (unit === 'Current' ? 'A' : unit === 'Power' ? 'W' : undefined))
      .filter((unit): unit is ChargingRateUnit => unit !== undefined);
    return {
      maxStackLevel: configInt(config, 'ChargeProfileMaxStackLevel'),
      maxPeriods: configInt(config, 'ChargingScheduleMaxPeriods'),
      maxInstalled: configInt(config, 'MaxChargingProfilesInstalled'),
      allowedUnits: units,
      connectorIds: connectors(station).map((c) => c.connectorId),
      transactionId: (connectorId) =>
        transactions.has(connectorId)
          ? (transactions.get(connectorId)?.transactionId ?? 0)
          : undefined,
      now: now(),
    };
  }

  /**
   * The Smart Charging limit on a connector now, in W: its TxProfile or
   * TxDefaultProfile, and its share of the ChargePointMaxProfile, which the
   * connectors with a transaction split equally. Undefined without profiles.
   */
  function profileLimitW(connectorId: number): number | undefined {
    const at = now();
    const conversion = conversionFor(connectorId);
    const own = connectorLimit(chargingProfiles, connectorId, at, txInfo(connectorId));
    let watts = own.limit === undefined ? undefined : toWatts(own.limit, conversion);
    const total = stationLimit(chargingProfiles, at).limit;
    if (total !== undefined) {
      const share = toWatts(total, conversion) / Math.max(1, transactions.size);
      watts = watts === undefined ? share : Math.min(watts, share);
    }
    return watts;
  }

  /** Re-evaluates every connector at the next moment a limit changes. */
  function scheduleLimitChange(): void {
    stopTimer(limitTimer);
    limitTimer = undefined;
    const at = now();
    const changes = [
      stationLimit(chargingProfiles, at).next,
      ...connectors(station).map(
        (c) => connectorLimit(chargingProfiles, c.connectorId, at, txInfo(c.connectorId)).next,
      ),
    ].filter((t): t is number => t !== undefined && t > at);
    if (changes.length === 0) return;
    limitTimer = later(Math.min(...changes) - at, () => {
      limitTimer = undefined;
      updateAllPowers();
    });
  }

  function updateAllPowers(): void {
    for (const connector of connectors(station)) updatePower(connector.connectorId);
    scheduleLimitChange();
    changed();
  }

  // ---- Reservations -------------------------------------------------------

  const reservations = new Map<number, Reservation>();
  const reservationTimers = new Map<number, TimerHandle>();
  /** connectorId → the reservation a presented card is using, until its transaction starts. */
  const sessionReservations = new Map<number, number>();

  function scheduleExpiry(reservation: Reservation): void {
    stopTimer(reservationTimers.get(reservation.reservationId));
    reservationTimers.set(
      reservation.reservationId,
      later(Math.max(0, reservation.expiresAt - now()), () =>
        endReservation(reservation.reservationId, 'expired'),
      ),
    );
  }

  function endReservation(reservationId: number, why: string): void {
    const reservation = reservations.get(reservationId);
    if (reservation === undefined) return;
    reservations.delete(reservationId);
    stopTimer(reservationTimers.get(reservationId));
    reservationTimers.delete(reservationId);
    for (const [connectorId, id] of sessionReservations) {
      if (id === reservationId) sessionReservations.delete(connectorId);
    }
    if (reservation.connectorId !== 0) {
      applyDevice({ type: 'Unreserve', connectorId: reservation.connectorId });
    }
    log(`reservation ${reservationId} ${why}`);
    changed();
  }

  /** A reservation ends when its connector (or, for connectorId 0, the station) becomes Faulted or Unavailable. */
  function checkReservations(): void {
    for (const reservation of [...reservations.values()]) {
      const status =
        reservation.connectorId === 0
          ? stationStatus(station).status
          : connectorStatus(
              findConnector(station, reservation.connectorId) ?? connectors(station)[0]!,
              station,
            ).status;
      if (status === 'Faulted' || status === 'Unavailable') {
        endReservation(reservation.reservationId, `ended: ${status}`);
      }
    }
  }

  /** The parent of an idTag as far as the local list or the cache know it. */
  const parentOf = (idTag: string) =>
    localList.entries[idTag]?.parentIdTag ??
    cachedAuthorization(authCache, config, idTag)?.parentIdTag;

  const belongsTo = (reservation: Reservation, idTag: string) =>
    idTag === reservation.idTag ||
    (reservation.parentIdTag !== undefined && parentOf(idTag) === reservation.parentIdTag);

  /** Connectors free for a new session: Available, so neither in use nor reserved. */
  const freeConnectors = () =>
    connectors(station)
      .filter((c) => connectorStatus(c, station).status === 'Available')
      .map((c) => c.connectorId);

  /**
   * Whether a card may use a connector given the reservations: a reserved
   * connector only takes its reservation's idTag (or parentIdTag); each
   * reservation on connectorId 0 keeps one free connector for its card.
   */
  function reservationCheck(
    connectorId: number,
    idTag: string,
  ): { ok: boolean; reservationId?: number } {
    const own = [...reservations.values()].find((r) => r.connectorId === connectorId);
    if (own !== undefined) {
      return belongsTo(own, idTag) ? { ok: true, reservationId: own.reservationId } : { ok: false };
    }
    const anywhere = [...reservations.values()].filter((r) => r.connectorId === 0);
    const mine = anywhere.find((r) => belongsTo(r, idTag));
    if (mine !== undefined) return { ok: true, reservationId: mine.reservationId };
    const othersFree = freeConnectors().filter((id) => id !== connectorId).length;
    return { ok: othersFree >= anywhere.length };
  }

  async function reservationAllows(
    connectorId: number,
    idTag: string,
  ): Promise<{ ok: boolean; reservationId?: number }> {
    const own = [...reservations.values()].find((r) => r.connectorId === connectorId);
    // The parent may only be known after asking the CSMS (section 5.13).
    if (
      own !== undefined &&
      !belongsTo(own, idTag) &&
      own.parentIdTag !== undefined &&
      parentOf(idTag) === undefined
    ) {
      await authorizeWithCsms(idTag);
    }
    return reservationCheck(connectorId, idTag);
  }

  /** Locks or releases the cable as the switch and the running transaction require. */
  function updateLock(connectorId: number): void {
    const connector = findConnector(station, connectorId);
    if (connector === undefined) return;
    const shouldLock = behaviour.cableLock && transactions.has(connectorId);
    if (shouldLock && !connector.locked) applyDevice({ type: 'Lock', connectorId });
    if (!shouldLock && connector.locked) applyDevice({ type: 'Unlock', connectorId });
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

  /**
   * Brings the meter (and the EV's SoC) up to now and returns it. Without an
   * EV the power is constant between changes; with one the energy comes from
   * the EV model, so the power follows the charging curve.
   */
  function syncMeter(connectorId: number): MeterState {
    const current = meter(connectorId);
    const ev = evs.get(connectorId);
    let next: MeterState;
    if (ev === undefined || !ev.drawing) {
      next = meterAt(current, now(), energyMultiplier);
    } else {
      const elapsed = Math.max(0, now() - current.updatedAt);
      const step = advanceEv(ev.state, current.offeredW, elapsed * energyMultiplier);
      ev.state = step.ev;
      next = {
        ...current,
        energyWh: current.energyWh + step.energyWh,
        powerW: step.powerW,
        updatedAt: Math.max(now(), current.updatedAt),
      };
    }
    meters.set(connectorId, next);
    return next;
  }

  /** Readings outside the meter for samples: the EV's SoC. */
  function extras(connectorId: number): { socPercent?: number; phases?: number } {
    const ev = evs.get(connectorId);
    return ev === undefined ? {} : { socPercent: ev.state.soc, phases: ev.state.profile.phases };
  }

  function setPower(connectorId: number, powerW: number): void {
    meters.set(connectorId, withPower(syncMeter(connectorId), now(), powerW));
    const ev = evs.get(connectorId);
    if (ev !== undefined) ev.drawing = powerW > 0;
    scheduleFull(connectorId);
  }

  /** Power the EV draws on a connector, given its transaction and suspension state. */
  function updatePower(connectorId: number): void {
    const connector = findConnector(station, connectorId);
    const running =
      connector?.transactionId !== undefined &&
      connector.plugged &&
      !connector.evSuspended &&
      !connector.evseSuspended;
    const ev = evs.get(connectorId);
    // The Smart Charging limit becomes the power offered (and Power.Offered).
    const current = syncMeter(connectorId);
    const offered = Math.max(0, Math.min(offeredW, profileLimitW(connectorId) ?? Infinity));
    if (current.offeredW !== offered) meters.set(connectorId, { ...current, offeredW: offered });
    if (ev === undefined) {
      setPower(connectorId, running ? Math.min(evPowerW, offered) : 0);
      return;
    }
    setPower(connectorId, running ? evDrawW(ev.state, offered) : 0);
  }

  /** While an EV draws power, a timer moves the connector to SuspendedEV when the battery is full. */
  function scheduleFull(connectorId: number): void {
    stopTimer(fullTimers.get(connectorId));
    fullTimers.delete(connectorId);
    const ev = evs.get(connectorId);
    if (ev === undefined || !ev.drawing) return;
    const energyMs = msUntilFull(ev.state, meter(connectorId).offeredW);
    if (energyMs === undefined) return;
    const ms = Math.ceil(energyMs / energyMultiplier);
    fullTimers.set(
      connectorId,
      later(ms, () => {
        fullTimers.delete(connectorId);
        syncMeter(connectorId);
        // Real timers can fire a moment early; wait for the rest.
        const rest = msUntilFull(ev.state, meter(connectorId).offeredW) ?? 0;
        if (rest > 0) {
          scheduleFull(connectorId);
          return;
        }
        log(`connector ${connectorId}: the EV is full`);
        if (applyDevice({ type: 'EvSuspend', connectorId }).error === undefined) {
          updatePower(connectorId);
        }
      }),
    );
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
      meter: syncMeter(connectorId),
      config,
      now: now(),
      configKey,
      context,
      extras: extras(connectorId),
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
    const reservationId = sessionReservations.get(connectorId);
    const started = startTransaction({
      connectorId,
      idTag,
      meter: syncMeter(connectorId),
      config,
      now: now(),
      extras: extras(connectorId),
      ...(reservationId !== undefined && { reservationId }),
    });
    // A reservation ends when its transaction starts; StartTransaction carries its id.
    if (reservationId !== undefined) endReservation(reservationId, `used by ${idTag}`);
    const ref = nextKey('tx');
    transactions.set(connectorId, started.transaction);
    refs.set(connectorId, ref);
    // Charging starts now, also offline (section 3.5.4): the transaction runs
    // with a placeholder id until the CSMS answers StartTransaction.
    applyDevice({ type: 'TransactionStarted', connectorId, transactionId: 0 });
    const remoteProfile = pendingTxProfiles.get(connectorId);
    pendingTxProfiles.delete(connectorId);
    if (remoteProfile !== undefined) {
      const installed = installProfile(
        chargingProfiles,
        connectorId,
        remoteProfile,
        profileContext(),
      );
      if (installed.status === 'Accepted') chargingProfiles = installed.profiles;
      else log(`TxProfile from RemoteStartTransaction not installed: ${installed.reason ?? ''}`);
    }
    updateAllPowers();
    schedulePeriodic(connectorId);
    updateLock(connectorId);

    const outcome = await enqueue('StartTransaction', started.request, ref);
    const stillRunning = transactions.get(connectorId) === started.transaction;
    if (!outcome.ok) {
      log(`StartTransaction failed: ${outcome.failure.kind}`);
      if (stillRunning) {
        transactions.delete(connectorId);
        refs.delete(connectorId);
        stopTimer(sampleTimers.get(connectorId));
        sampleTimers.delete(connectorId);
        applyDevice({ type: 'TransactionEnded', connectorId });
        updatePower(connectorId);
        updateLock(connectorId);
      }
      return;
    }
    remember(idTag, outcome.payload.idTagInfo);
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
        changed();
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
    const meterAtStop = syncMeter(connectorId);
    const extrasAtStop = extras(connectorId);
    setPower(connectorId, 0);

    const request = stopTransactionRequest({
      transaction: { ...transaction, transactionId: transaction.transactionId ?? 0 },
      meter: meterAtStop,
      config,
      now: stoppedAt,
      reason,
      extras: extrasAtStop,
      ...(idTag !== undefined && { idTag }),
    });
    // The transactionId is filled in from the StartTransaction answer when sent.
    const stopCall = ref !== undefined ? enqueue('StopTransaction', request, ref) : undefined;
    applyDevice({ type: 'TransactionEnded', connectorId });
    updateLock(connectorId);
    chargingProfiles = endTransactionProfiles(chargingProfiles, connectorId);
    updateAllPowers();

    const outcome = await stopCall;
    if (outcome?.ok === true && outcome.payload.idTagInfo !== undefined) {
      remember(transaction.idTag, outcome.payload.idTagInfo);
    }
  }

  async function authorizeWithCsms(idTag: string): Promise<boolean> {
    const outcome = await sendIfOnline('Authorize', { idTag });
    if (outcome === undefined || !outcome.ok) return false;
    remember(idTag, outcome.payload.idTagInfo);
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
    ReserveNow(request) {
      const { connectorId, reservationId } = request;
      const existing = reservations.get(reservationId);
      if (connectorId === 0) {
        if (!configBool(config, 'ReserveConnectorZeroSupported')) return { status: 'Rejected' };
        const status = stationStatus(station).status;
        if (status === 'Faulted') return { status: 'Faulted' };
        if (status === 'Unavailable') return { status: 'Unavailable' };
        const others = [...reservations.values()].filter(
          (r) => r.connectorId === 0 && r.reservationId !== reservationId,
        ).length;
        const free =
          freeConnectors().length + (existing !== undefined && existing.connectorId !== 0 ? 1 : 0);
        if (free <= others) return { status: 'Occupied' };
      } else {
        const connector = findConnector(station, connectorId);
        if (connector === undefined) return { status: 'Rejected' };
        const status = connectorStatus(connector, station).status;
        if (status === 'Faulted') return { status: 'Faulted' };
        if (status === 'Unavailable') return { status: 'Unavailable' };
        const ownReservation = connector.reservationId === reservationId;
        if (status !== 'Available' && !ownReservation) return { status: 'Occupied' };
      }
      // The same reservationId replaces the earlier reservation.
      if (existing !== undefined) endReservation(reservationId, 'replaced');
      const reservation: Reservation = {
        reservationId,
        connectorId,
        idTag: request.idTag,
        ...(request.parentIdTag !== undefined && { parentIdTag: request.parentIdTag }),
        expiresAt: Date.parse(request.expiryDate),
      };
      reservations.set(reservationId, reservation);
      if (connectorId !== 0) applyDevice({ type: 'Reserve', connectorId, reservationId });
      scheduleExpiry(reservation);
      changed();
      return { status: 'Accepted' };
    },

    SetChargingProfile(request) {
      const result = installProfile(
        chargingProfiles,
        request.connectorId,
        request.csChargingProfiles,
        profileContext(),
      );
      if (result.status !== 'Accepted') {
        log(
          `SetChargingProfile ${request.csChargingProfiles.chargingProfileId} rejected: ${result.reason ?? ''}`,
        );
        return { status: 'Rejected' };
      }
      chargingProfiles = result.profiles;
      updateAllPowers();
      return { status: 'Accepted' };
    },

    ClearChargingProfile(request) {
      const result = clearProfiles(chargingProfiles, {
        ...(request.id !== undefined && { id: request.id }),
        ...(request.connectorId !== undefined && { connectorId: request.connectorId }),
        ...(request.chargingProfilePurpose !== undefined && {
          purpose: request.chargingProfilePurpose,
        }),
        ...(request.stackLevel !== undefined && { stackLevel: request.stackLevel }),
      });
      if (result.status === 'Accepted') {
        chargingProfiles = result.profiles;
        updateAllPowers();
      }
      return { status: result.status };
    },

    GetCompositeSchedule(request) {
      const { connectorId } = request;
      if (connectorId !== 0 && findConnector(station, connectorId) === undefined) {
        return { status: 'Rejected' };
      }
      const ids = connectors(station).map((c) => c.connectorId);
      const chargingSchedule = compositeSchedule(chargingProfiles, {
        connectorId,
        from: now(),
        durationS: request.duration,
        unit: request.chargingRateUnit ?? 'W',
        conversion: connectorId === 0 ? { voltageV: 230, phases: 3 } : conversionFor(connectorId),
        ratingW: connectorId === 0 ? offeredW * ids.length : offeredW,
        connectorIds: ids,
        transaction: txInfo,
      });
      return {
        status: 'Accepted',
        connectorId,
        scheduleStart: new Date(now()).toISOString(),
        chargingSchedule,
      };
    },

    CancelReservation(request) {
      if (!reservations.has(request.reservationId)) return { status: 'Rejected' };
      endReservation(request.reservationId, 'cancelled');
      return { status: 'Accepted' };
    },

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
      later(delayFor('ChangeAvailability'), () => {
        applyDevice(event);
        checkReservations();
      });
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

    GetLocalListVersion() {
      // -1 tells the CSMS the station has no local list (section 5.10).
      if (!supports('LocalAuthListManagement')) return { listVersion: -1 };
      return { listVersion: localListVersion(localList) };
    },

    SendLocalList(request) {
      if (!supports('LocalAuthListManagement')) return { status: 'NotSupported' };
      const result = applySendLocalList(localList, request, {
        sendMax: configInt(config, 'SendLocalListMaxLength'),
        listMax: configInt(config, 'LocalAuthListMaxLength'),
      });
      if (result.status !== 'Accepted') {
        log(`SendLocalList ${request.updateType} version ${request.listVersion}: ${result.status}`);
        return { status: result.status };
      }
      localList = result.list;
      changed();
      return { status: 'Accepted' };
    },

    RemoteStartTransaction(request) {
      if (behaviour.refuseRemoteStart) {
        log('remote start refused: the refuse-remote-start switch is on');
        return { status: 'Rejected' };
      }
      // A connector reserved for this idTag counts as free for it.
      const usable = (id: number) => {
        const connector = findConnector(station, id);
        const reservedForMe =
          connector?.reservationId !== undefined &&
          !transactions.has(id) &&
          connectorStatus(connector, station).status === 'Reserved' &&
          reservationCheck(id, request.idTag).ok;
        return (idle(id) || reservedForMe) && reservationCheck(id, request.idTag).ok;
      };
      const reservedForIdTag = [...reservations.values()].find(
        (r) => r.connectorId !== 0 && belongsTo(r, request.idTag),
      )?.connectorId;
      const connectorId =
        request.connectorId ??
        reservedForIdTag ??
        connectors(station).find((c) => usable(c.connectorId))?.connectorId;
      if (
        connectorId === undefined ||
        connectorId === 0 ||
        !usable(connectorId) ||
        authorized.has(connectorId)
      ) {
        return { status: 'Rejected' };
      }
      if (request.chargingProfile !== undefined) {
        // Section 5.16.2: only a TxProfile, without transactionId.
        const remote = request.chargingProfile;
        if (remote.chargingProfilePurpose !== 'TxProfile' || remote.transactionId !== undefined) {
          return { status: 'Rejected' };
        }
        if (!supports('SmartCharging')) return { status: 'Rejected' };
        pendingTxProfiles.set(connectorId, remote);
      }
      const reservationId = reservationCheck(connectorId, request.idTag).reservationId;
      if (reservationId !== undefined) sessionReservations.set(connectorId, reservationId);
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
  for (const reservation of restored?.reservations ?? []) {
    if (reservation.expiresAt <= now()) continue;
    reservations.set(reservation.reservationId, { ...reservation });
    if (reservation.connectorId !== 0) {
      station = reduce(
        station,
        {
          type: 'Reserve',
          connectorId: reservation.connectorId,
          reservationId: reservation.reservationId,
        },
        now(),
      ).state;
    }
    scheduleExpiry(reservation);
  }
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
        // The local list answers for itself without the profile (NotSupported, -1).
        supports: (action) =>
          action === 'SendLocalList' ||
          action === 'GetLocalListVersion' ||
          supports(OCPP16_ACTION_PROFILES[action]),
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

    plugIn(connectorId, ev) {
      if (findConnector(station, connectorId) === undefined) {
        log(`Plug: unknown connector ${connectorId}`);
        return;
      }
      if (ev !== undefined) {
        // Throws a RangeError for an unusable profile, before anything changes.
        const state = createEv(ev.profile);
        syncMeter(connectorId);
        evs.set(connectorId, {
          ...(ev.name !== undefined && { name: ev.name }),
          state,
          drawing: false,
        });
      }
      if (applyDevice({ type: 'Plug', connectorId }).error !== undefined) return;
      if (authorized.has(connectorId)) {
        clearPrepare(connectorId);
        later(timing.startTransactionDelayMs, () => beginTransaction(connectorId));
      }
    },

    unplug(connectorId) {
      if (findConnector(station, connectorId)?.locked === true) {
        log(`connector ${connectorId}: the cable is locked`);
        return 'locked';
      }
      if (findConnector(station, connectorId) === undefined) {
        log(`Unplug: unknown connector ${connectorId}`);
        return 'unknown-connector';
      }
      syncMeter(connectorId);
      applyDevice({ type: 'Unplug', connectorId });
      authorized.delete(connectorId);
      clearPrepare(connectorId);
      if (transactions.has(connectorId)) {
        if (configBool(config, 'StopTransactionOnEVSideDisconnect')) {
          void endTransaction(connectorId, 'EVDisconnected');
        } else {
          updatePower(connectorId);
        }
      }
      // The EV leaves with the cable.
      if (evs.has(connectorId)) {
        setPower(connectorId, 0);
        evs.delete(connectorId);
        scheduleFull(connectorId);
        changed();
      }
      return 'unplugged';
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
      const reserved = await reservationAllows(connectorId, idTag);
      if (!reserved.ok) {
        log(`connector ${connectorId}: ${idTag} refused, the connector is reserved`);
        return 'rejected';
      }
      const decision = decideLocalAuthorization({
        cache: authCache,
        config,
        idTag,
        online: online(),
        now: now(),
        localList: localList.entries,
      });
      const accepted =
        decision === 'start' || (decision === 'ask' && (await authorizeWithCsms(idTag)));
      if (!accepted) {
        log(`connector ${connectorId}: ${idTag} rejected`);
        return 'rejected';
      }
      if (reserved.reservationId !== undefined) {
        sessionReservations.set(connectorId, reserved.reservationId);
      }
      authorizeConnector(connectorId, idTag);
      return 'authorized';
    },

    evSuspend(connectorId) {
      if (applyDevice({ type: 'EvSuspend', connectorId }).error === undefined)
        updatePower(connectorId);
    },

    evResume(connectorId) {
      const ev = evs.get(connectorId);
      if (ev !== undefined) {
        syncMeter(connectorId);
        if (acceptedPowerW(ev.state.profile, ev.state.soc) === 0) {
          log(`connector ${connectorId}: the EV is full and does not resume`);
          return;
        }
      }
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
      checkReservations();
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

    setBehaviour(changes) {
      behaviour = { ...behaviour, ...changes };
      for (const connector of connectors(station)) updateLock(connector.connectorId);
      changed();
    },

    setEnergyMultiplier(multiplier) {
      const next = checkedMultiplier(multiplier);
      // Energy so far counts at the old rate.
      for (const id of meters.keys()) syncMeter(id);
      energyMultiplier = next;
      for (const id of meters.keys()) scheduleFull(id);
      changed();
    },

    snapshot() {
      const station0 = stationStatus(station);
      return {
        registration,
        connected: rpc !== undefined,
        station: { status: station0.status, errorCode: station0.errorCode },
        connectors: connectors(station).map((connector) => {
          const status = connectorStatus(connector, station);
          const reading = syncMeter(connector.connectorId);
          const ev = evs.get(connector.connectorId);
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
            ...(ev !== undefined && {
              ev: {
                ...(ev.name !== undefined && { name: ev.name }),
                soc: ev.state.soc,
                profile: ev.state.profile,
              },
            }),
            ...((limit) => (limit === undefined ? {} : { limitW: Math.round(limit * 10) / 10 }))(
              profileLimitW(connector.connectorId),
            ),
          };
        }),
        config: config.values,
        queuedMessages: outbox.length,
        behaviour: { ...behaviour },
        energyMultiplier,
        localList: {
          version: localListVersion(localList),
          size: Object.keys(localList.entries).length,
        },
        reservations: [...reservations.values()].map((r) => ({
          reservationId: r.reservationId,
          connectorId: r.connectorId,
          idTag: r.idTag,
          expiryDate: new Date(r.expiresAt).toISOString(),
        })),
        chargingProfiles: chargingProfiles.map((p) => ({
          chargingProfileId: p.profile.chargingProfileId,
          connectorId: p.connectorId,
          purpose: p.profile.chargingProfilePurpose,
          stackLevel: p.profile.stackLevel,
        })),
      };
    },

    persistentState() {
      const savedAt = now();
      return {
        version: 1,
        savedAt,
        config: { ...config.values },
        meters: Object.fromEntries(
          [...meters.keys()].map((id) => [String(id), syncMeter(id).energyWh]),
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
        behaviour: { ...behaviour },
        energyMultiplier,
        localList,
        reservations: [...reservations.values()].map((r) => ({ ...r })),
        chargingProfiles: chargingProfiles.map((p) => ({ ...p })),
      };
    },
  };
}
