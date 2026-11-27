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
import type { SessionHint, SessionSource } from './session.js';
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
  readableConfigValues,
  configBool,
  configValue,
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
import { createEnergy, type PluggedEv } from './energy.js';
import type { EvProfile } from './ev.js';
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
import {
  DEFAULT_FIRMWARE_SETTINGS,
  diagnosticsFileName,
  diagnosticsUploadUrl,
  logUploadUrl,
  firmwareVersionFrom,
  isHttpLocation,
  type FileTransfer,
  type FirmwareSettings,
} from './firmware.js';
import {
  sameCertificate,
  type CertificateTools,
  type CertificateUse,
  type ChargePointCertificate,
} from './certificates.js';
import type { IdGenerator } from './ids.js';
import type { OcppVersion } from './message-set.js';
import type { PersistedChargePoint201 } from './ocpp201/charge-point.js';
import { createOutbox, type OutboxEntry } from './outbox.js';
import { createStationTimers } from './station-timers.js';
import {
  isCriticalSecurityEvent,
  SECURITY_LOG_LENGTH,
  securityLogContent,
  type SecurityLogEntry,
} from './security-events.js';
import { OCPP16_ACTION_PROFILES } from './ocpp16.js';
import {
  applySendLocalList,
  EMPTY_LOCAL_LIST,
  localListVersion,
  type LocalAuthList,
} from './local-list.js';
import { nextAlignedSample, nextPeriodicSample } from './meter.js';
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
  | 'RequestStartTransaction'
  | 'RequestStopTransaction'
  | 'Reset'
  | 'UnlockConnector'
  | 'TriggerMessage'
  | 'CustomerInformation';

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
  /** Who may charge and why, or a start that never became a transaction (see session.ts). */
  | { type: 'session'; hint: SessionHint }
  /** Something observable changed (status, transaction, registration). */
  | { type: 'changed' };

type TransactionAction = 'StartTransaction' | 'StopTransaction' | 'MeterValues';
/** Messages with guaranteed delivery: transaction messages and critical security events. */
type QueuedAction = TransactionAction | 'SecurityEventNotification';

export type { OutboxEntry };

export interface PersistedTransaction {
  connectorId: number;
  ref: string;
  idTag: string;
  startedAt: number;
  meterStartWh: number;
  transactionId?: number;
}

/** What any station keeps across an engine restart: a 1.6 or a 2.0.1 state. */
export type PersistedStation = PersistedChargePoint | PersistedChargePoint201;

/** Everything a 1.6 charge point keeps across an engine restart. */
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
  /** The firmware version after an update; missing until one was installed. */
  firmwareVersion?: string;
  /** The security log (Security Whitepaper A04); missing in older states. */
  securityLog?: SecurityLogEntry[];
  /** Installed CA certificates and the station's own certificate; missing in older states. */
  certificates?: {
    installed: { certificateType: CertificateUse; certificate: string }[];
    chargePoint?: ChargePointCertificate;
  };
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
  /**
   * Asks the transport to drop the connection and connect again at once with
   * the current security settings (connectionSecurity()), after a change of
   * AuthorizationKey or SecurityProfile.
   */
  reconnect?: () => void;
  /**
   * Certificates the station starts with (e.g. from its PEM files); a
   * restored state's certificates take precedence. Raising SecurityProfile
   * needs them (Security Whitepaper A05).
   */
  certificates?: {
    centralSystemRoots?: readonly string[];
    manufacturerRoots?: readonly string[];
    chargePoint?: ChargePointCertificate;
  };
  /** X.509 support for certificate management and signed firmware; without it those messages fail. */
  certificateTools?: CertificateTools;
  /** The serial number put in the CN of a CSR; default the BootNotification serial numbers. */
  serialNumber?: string;
  onEvent?: (event: ChargePointEvent) => void;
  /** Initial test switches; a restored state's switches take precedence. */
  behaviour?: Partial<ChargePointBehaviour>;
  /** Timings and outcomes of simulated firmware updates and diagnostics uploads. */
  firmware?: Partial<FirmwareSettings>;
  /** Real HTTP(S) transfers for UpdateFirmware and GetDiagnostics; simulated without it. */
  transfer?: FileTransfer;
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

/** What the transport needs to connect: Security Profile, password and certificates. */
export interface ConnectionSecurity {
  /** SecurityProfile: 0 (none configured), 1, 2 or 3. */
  profile: number;
  /** AuthorizationKey, when set. */
  authorizationKey?: string;
  /** Installed CentralSystemRootCertificates (PEM), to check the CSMS's server certificate. */
  centralSystemRoots: string[];
  /** The station's client certificate and key, for Security Profile 3. */
  chargePointCertificate?: ChargePointCertificate;
  /** A 2.0.1 network profile's CSMS address, used instead of the station's own. */
  csmsUrl?: string;
}

export type { PluggedEv };

export interface ConnectorSnapshot {
  connectorId: number;
  /** The EVSE the connector belongs to (2.0.1 stations). */
  evseId?: number;
  status: string;
  errorCode: string;
  plugged: boolean;
  locked: boolean;
  /** The CSMS's id (1.6) or the station's own id (2.0.1) of the running transaction. */
  transactionId?: number | string;
  /** The idTag (1.6) or idToken (2.0.1) of the session. */
  idTag?: string;
  /** The 2.0.1 charging state: Idle, EVConnected, Charging, SuspendedEV, SuspendedEVSE. */
  chargingState?: string;
  energyWh: number;
  powerW: number;
  /** The power the connector offers now (the station's maximum or the limit in force), in W. */
  offeredW: number;
  /** The plugged-in EV, when the cable was plugged in with one. */
  ev?: { name?: string; soc: number; profile: EvProfile };
  /** The Smart Charging limit in force, in W, when a charging profile applies. */
  limitW?: number;
  /** 2.1: what the EVSE's display shows now (I01 to I06). */
  display?: DisplayMessage;
}

/** A message on a 2.1 station's virtual display (block I: tariff and cost). */
export interface DisplayMessage {
  at: string;
  /**
   * tariff: the driver's tariff text (I01); fallback: TariffFallbackMessage or
   * TotalCostFallbackMessage (I04, I05); runningCost (I02); totalCost (I03);
   * personal: an updated personal message (I06).
   */
  kind: 'tariff' | 'fallback' | 'runningCost' | 'totalCost' | 'personal';
  text: string;
}

export interface ChargePointSnapshot {
  /** The OCPP version the station speaks. */
  ocpp: OcppVersion;
  registration: Registration;
  connected: boolean;
  station: { status: string; errorCode: string };
  connectors: ConnectorSnapshot[];
  config: Readonly<Record<string, string>>;
  /** Transaction messages waiting to be sent. */
  queuedMessages: number;
  /** The firmware version the station reports, after any update. */
  firmwareVersion?: string;
  /** The firmware update and diagnostics upload in progress, or Idle. */
  firmwareStatus: string;
  diagnosticsStatus: string;
  /** The GetLog upload in progress, or Idle. */
  logStatus: string;
  /** The signed firmware update in progress, or Idle. */
  signedFirmwareStatus: string;
  /** How many CA certificates of each type are installed, and whether the station has its own. */
  certificates: { centralSystemRoots: number; manufacturerRoots: number; chargePoint: boolean };
  /** The latest security events, newest last (at most 20). */
  securityEvents: SecurityLogEntry[];
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
  /** The OCPP version the station speaks. */
  readonly ocpp: OcppVersion;
  connected(): void;
  disconnected(): void;
  receive(text: string): void;
  /** Cable in; with an EV, power and SoC follow the EV model instead of a fixed power. */
  plugIn(connectorId: number, ev?: PluggedEv): void;
  /** Takes the cable out, unless the cable lock holds it. */
  unplug(connectorId: number): UnplugResult;
  /**
   * A card presented at `connectorId`: starts, or stops the transaction the
   * card started. `type` is the IdToken type of a 2.0.1 station (default
   * ISO14443); 1.6 stations have none.
   */
  presentIdTag(connectorId: number, idTag: string, type?: string): Promise<IdTagResult>;
  evSuspend(connectorId: number): void;
  evResume(connectorId: number): void;
  raiseFault(connectorId: number, fault: Fault): void;
  /**
   * Sets a connector's energy register (Wh), as a faulty meter that rolls
   * back or resets would; readings and meterStop continue from there.
   */
  setMeterRegister(connectorId: number, energyWh: number): void;
  clearFault(connectorId: number): void;
  /** Changes test switches; turning the cable lock on or off applies to running transactions too. */
  setBehaviour(changes: Partial<ChargePointBehaviour>): void;
  /**
   * Stops the charge point for good: every timer (meter samples, EV and
   * schedule changes, retries) is cleared and none is set again, so nothing
   * holds it in memory. The fleet calls it when it replaces the station after
   * a power loss or removes it.
   */
  halt(): void;
  /** Changes the energy multiplier from now on. Throws a RangeError unless it is above 0. */
  setEnergyMultiplier(multiplier: number): void;
  dataTransfer(request: RequestOf<'DataTransfer'>): Promise<CallOutcome<'DataTransfer'>>;
  snapshot(): ChargePointSnapshot;
  /** The state to save for a restart; see ChargePointOptions.restore. */
  persistentState(): PersistedStation;
  /** The Security Profile and password to connect with. */
  connectionSecurity(): ConnectionSecurity;
  /**
   * Records a security event in the security log; a critical one is also
   * sent to the CSMS (queued while offline). `type` is one of the
   * whitepaper's events or a vendor's own.
   */
  securityEvent(type: string, techInfo?: string): void;
  /**
   * A connection attempt failed before it opened. Right after a SecurityProfile
   * change, this falls back to the previous profile and reconnects (A05.FR.08).
   */
  connectionFailed(): void;
}

/** A 1.6 charge point: its saved state is a 1.6 state. */
export interface ChargePoint16 extends ChargePoint {
  persistentState(): PersistedChargePoint;
}

function checkedMultiplier(value: number): number {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`the energy multiplier must be a number above 0, got ${value}`);
  }
  return value;
}

export function createChargePoint(options: ChargePointOptions): ChargePoint16 {
  const { clock, ids } = options;
  const timing: ChargePointTiming = { ...DEFAULT_TIMING, ...options.timing };
  const offeredW = options.offeredPowerW ?? 7360;
  const evPowerW = options.evPowerW ?? offeredW;
  const emit = options.onEvent ?? (() => {});
  const log = (message: string) => emit({ type: 'log', message });
  const changed = () => emit({ type: 'changed' });
  const hint = (value: SessionHint) => emit({ type: 'session', hint: value });
  /** connectorId → why its authorization exists, for the hint when it times out. */
  const startSources = new Map<number, SessionSource>();

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
  const transactions = new Map<number, Transaction>();
  /** connectorId → local reference of its running transaction. */
  const refs = new Map<number, string>();
  const csmsIds = new Map<string, number>();
  let sequence = options.restore?.sequence ?? 0;
  const nextKey = (prefix: string) => `${prefix}-${++sequence}`;
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
  const timers = createStationTimers(clock);
  const { later, delay } = timers;
  const stopTimer = timers.stop;
  const energy = createEnergy({
    clock,
    timers,
    connectorIds: connectors(station).map((c) => c.connectorId),
    offeredW,
    evPowerW,
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
  const syncMeter = energy.sync;
  const extras = energy.extras;
  const setPower = energy.setPower;
  const delayFor = (command: DelayedCommand) =>
    timing.actionDelaysMs?.[command] ?? timing.actionDelayMs;

  // ---- Sending ------------------------------------------------------------

  /** Sends now when registered; otherwise drops the message (status reports, heartbeats). */
  function sendIfOnline<A extends ChargePointAction>(
    action: A,
    payload: RequestOf<A>,
  ): Promise<CallOutcome<A>> | undefined {
    // RequestOf<A> is the set's request type for A; TypeScript cannot see it for a generic A.
    return online() ? (rpc?.call(action, payload as never) as Promise<CallOutcome<A>>) : undefined;
  }

  /**
   * Transaction messages and critical security events go through the outbox:
   * retried TransactionMessageAttempts times, TransactionMessageRetryInterval
   * × attempts apart. StartTransaction obtains the CSMS's transactionId, and
   * the messages queued behind it carry it.
   */
  const outbox = createOutbox({
    timers,
    online,
    call: (action, payload) => rpc?.call(action as ChargePointAction, payload as never),
    retryPolicy: () => ({
      attempts: configInt(config, 'TransactionMessageAttempts'),
      intervalS: configInt(config, 'TransactionMessageRetryInterval'),
    }),
    nextKey: () => nextKey('msg'),
    prepare(entry) {
      if (entry.txRef === undefined || entry.action === 'StartTransaction') {
        return { payload: entry.payload };
      }
      const id = csmsIds.get(entry.txRef);
      if (id === undefined) return { drop: 'its transaction never got an id from the CSMS' };
      return { payload: { ...entry.payload, transactionId: id } };
    },
    // A CSMS without the Security Whitepaper (NotImplemented and the like):
    // retrying cannot help, and would hold up the transaction messages behind it.
    final: (entry, failure) =>
      entry.action === 'SecurityEventNotification' && failure.kind === 'CallError'
        ? `the CSMS answered ${failure.errorCode}`
        : undefined,
    answered(entry, payload) {
      if (entry.action === 'StartTransaction' && entry.txRef !== undefined) {
        csmsIds.set(entry.txRef, (payload as ResponseOf<'StartTransaction'>).transactionId);
      }
    },
    settled: () => pruneTransactionIds(),
    log,
    changed,
  });
  const pump = outbox.pump;

  function enqueue<A extends QueuedAction>(
    action: A,
    payload: RequestOf<A>,
    txRef?: string,
  ): Promise<CallOutcome<A>> {
    return outbox.enqueue(action, payload as JsonObject, txRef) as Promise<CallOutcome<A>>;
  }

  /**
   * Forgets the CSMS ids of transactions that are over and have nothing left
   * to send, so the map (and the saved state) does not grow with every session.
   */
  function pruneTransactionIds(): void {
    if (csmsIds.size === 0) return;
    const needed = new Set<string>(refs.values());
    for (const queued of outbox.entries) if (queued.txRef !== undefined) needed.add(queued.txRef);
    for (const ref of csmsIds.keys()) if (!needed.has(ref)) csmsIds.delete(ref);
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

  // ---- Firmware and diagnostics -------------------------------------------

  const firmwareSettings: FirmwareSettings = { ...DEFAULT_FIRMWARE_SETTINGS, ...options.firmware };
  let firmwareVersion = options.restore?.firmwareVersion ?? options.boot.firmwareVersion;
  type FirmwareStatus = RequestOf<'FirmwareStatusNotification'>['status'];
  type DiagnosticsStatus = RequestOf<'DiagnosticsStatusNotification'>['status'];
  let firmwareStatus: FirmwareStatus = 'Idle';
  let diagnosticsStatus: DiagnosticsStatus = 'Idle';
  /** Installed is reported after the reboot that follows an update (section 5.19). */
  let installedPendingReport = false;
  const idleWaiters: (() => void)[] = [];

  const bootPayload = (): RequestOf<'BootNotification'> => ({
    ...options.boot,
    ...(firmwareVersion !== undefined && { firmwareVersion }),
  });
  /** Resolves when no transaction is running. */
  const noTransactions = () =>
    transactions.size === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => idleWaiters.push(resolve));
  function wakeIdleWaiters(): void {
    if (transactions.size > 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function reportFirmware(status: FirmwareStatus): void {
    firmwareStatus = status;
    void sendIfOnline('FirmwareStatusNotification', { status });
    changed();
  }
  function reportDiagnostics(status: DiagnosticsStatus): void {
    diagnosticsStatus = status;
    void sendIfOnline('DiagnosticsStatusNotification', { status });
    changed();
  }

  /** Tries a transfer up to 1 + retries times, retryInterval seconds apart. */
  async function withRetries(
    attempt: () => Promise<boolean>,
    retries: number | undefined,
    retryIntervalS: number | undefined,
  ): Promise<boolean> {
    for (let n = 0; n <= (retries ?? 0); n++) {
      if (n > 0) await delay((retryIntervalS ?? 30) * 1000);
      if (await attempt()) return true;
    }
    return false;
  }

  async function runFirmwareUpdate(request: RequestOf<'UpdateFirmware'>): Promise<void> {
    await delay(Math.max(0, Date.parse(request.retrieveDate) - now()));
    reportFirmware('Downloading');
    const downloaded = await withRetries(
      async () => {
        if (options.transfer !== undefined && isHttpLocation(request.location)) {
          return (await options.transfer.download(request.location)) !== undefined;
        }
        await delay(firmwareSettings.downloadMs);
        return firmwareSettings.download === 'succeed';
      },
      request.retries,
      request.retryInterval,
    );
    if (!downloaded) {
      reportFirmware('DownloadFailed');
      firmwareStatus = 'Idle';
      return;
    }
    reportFirmware('Downloaded');
    await noTransactions();
    reportFirmware('Installing');
    await delay(firmwareSettings.installMs);
    if (firmwareSettings.install === 'fail') {
      reportFirmware('InstallationFailed');
      firmwareStatus = 'Idle';
      return;
    }
    firmwareVersion = firmwareVersionFrom(request.location, firmwareVersion);
    installedPendingReport = true;
    log(`firmware ${firmwareVersion} installed`);
    changed();
    await resetChargePoint('Hard');
  }

  async function runDiagnosticsUpload(
    request: RequestOf<'GetDiagnostics'>,
    fileName: string,
  ): Promise<void> {
    reportDiagnostics('Uploading');
    const content = diagnosticsContent(request);
    const uploaded = await withRetries(
      async () => {
        if (options.transfer !== undefined && isHttpLocation(request.location)) {
          return options.transfer.upload(
            diagnosticsUploadUrl(request.location, fileName),
            fileName,
            content,
          );
        }
        await delay(firmwareSettings.uploadMs);
        return firmwareSettings.upload === 'succeed';
      },
      request.retries,
      request.retryInterval,
    );
    reportDiagnostics(uploaded ? 'Uploaded' : 'UploadFailed');
    diagnosticsStatus = 'Idle';
  }

  /** The diagnostics file: the station's state and configuration as text. */
  function diagnosticsContent(request: RequestOf<'GetDiagnostics'>): string {
    const lines = [
      `ocpp-mimic diagnostics, ${new Date(now()).toISOString()}`,
      `vendor ${options.boot.chargePointVendor}, model ${options.boot.chargePointModel}, firmware ${firmwareVersion ?? 'unknown'}`,
      `period ${request.startTime ?? 'start'} to ${request.stopTime ?? 'now'}`,
      `registration ${registration}`,
      ...connectors(station).map((c) => {
        const status = connectorStatus(c, station);
        return `connector ${c.connectorId}: ${status.status} ${status.errorCode}`;
      }),
      // Write-only keys such as AuthorizationKey stay out of the file (A01.FR.12).
      ...Object.entries(readableConfigValues(config)).map(
        ([key, value]) => `config ${key}=${value}`,
      ),
    ];
    return `${lines.join('\n')}\n`;
  }

  // ---- Security events and logs (Security Whitepaper A04, N01) -----------

  let securityLog: SecurityLogEntry[] = [...(options.restore?.securityLog ?? [])];

  function securityEvent(type: string, techInfo?: string): void {
    const entry: SecurityLogEntry = {
      type,
      timestamp: new Date(now()).toISOString(),
      ...(techInfo !== undefined && { techInfo: techInfo.slice(0, 255) }),
    };
    securityLog = [...securityLog, entry].slice(-SECURITY_LOG_LENGTH);
    log(`security event ${type}${techInfo === undefined ? '' : ` (${techInfo})`}`);
    if (isCriticalSecurityEvent(type)) {
      void enqueue('SecurityEventNotification', {
        type: type.slice(0, 50),
        timestamp: entry.timestamp,
        ...(entry.techInfo !== undefined && { techInfo: entry.techInfo }),
      });
    }
    changed();
  }

  type LogStatus = RequestOf<'LogStatusNotification'>['status'];
  /** The GetLog upload in progress; a newer GetLog cancels it (N01.FR.11). */
  let logUpload: { requestId: number; cancelled: boolean } | undefined;
  let logStatus: LogStatus = 'Idle';

  function reportLog(status: LogStatus, requestId: number): void {
    logStatus = status;
    void sendIfOnline('LogStatusNotification', { status, requestId });
    changed();
  }

  async function runLogUpload(request: RequestOf<'GetLog'>, fileName: string): Promise<void> {
    const upload = { requestId: request.requestId, cancelled: false };
    logUpload = upload;
    const content =
      request.logType === 'SecurityLog'
        ? securityLogContent(securityLog, request.log)
        : diagnosticsContent({
            location: request.log.remoteLocation,
            ...(request.log.oldestTimestamp !== undefined && {
              startTime: request.log.oldestTimestamp,
            }),
            ...(request.log.latestTimestamp !== undefined && {
              stopTime: request.log.latestTimestamp,
            }),
          });
    reportLog('Uploading', upload.requestId);
    const location = request.log.remoteLocation;
    const uploaded = await withRetries(
      async () => {
        if (upload.cancelled) return true;
        if (options.transfer !== undefined && isHttpLocation(location)) {
          return options.transfer.upload(logUploadUrl(location, fileName), fileName, content);
        }
        await delay(firmwareSettings.uploadMs);
        return firmwareSettings.upload === 'succeed';
      },
      request.retries,
      request.retryInterval,
    );
    // A cancelled upload stops quietly: the newer GetLog reports for itself.
    if (upload.cancelled) return;
    reportLog(uploaded ? 'Uploaded' : 'UploadFailure', upload.requestId);
    logStatus = 'Idle';
    logUpload = undefined;
  }

  /**
   * Sends the message a TriggerMessage or ExtendedTriggerMessage asked for,
   * after the persona's delay; undefined when the message is not one it can send.
   */
  function trigger(
    requested: string,
    connectorId: number | undefined,
  ): 'Accepted' | 'Rejected' | 'NotImplemented' {
    if (
      connectorId !== undefined &&
      connectorId !== 0 &&
      findConnector(station, connectorId) === undefined
    ) {
      return 'Rejected';
    }
    const targets =
      connectorId === undefined || connectorId === 0
        ? connectors(station).map((c) => c.connectorId)
        : [connectorId];
    const senders: Record<string, () => void> = {
      BootNotification: () => void sendIfOnline('BootNotification', bootPayload()),
      Heartbeat: () => void sendIfOnline('Heartbeat', {}),
      StatusNotification: () => {
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
      },
      MeterValues: () =>
        targets.forEach((id) => sendMeterValues(id, 'MeterValuesSampledData', 'Trigger')),
      FirmwareStatusNotification: () =>
        void sendIfOnline('FirmwareStatusNotification', { status: firmwareStatus }),
      DiagnosticsStatusNotification: () =>
        void sendIfOnline('DiagnosticsStatusNotification', { status: diagnosticsStatus }),
      // ExtendedTriggerMessage: requestId only while an upload runs (N01.FR.14).
      LogStatusNotification: () =>
        void sendIfOnline(
          'LogStatusNotification',
          logUpload === undefined
            ? { status: 'Idle' }
            : { status: logStatus, requestId: logUpload.requestId },
        ),
      SignedFirmwareStatusNotification: () =>
        void sendIfOnline(
          'SignedFirmwareStatusNotification',
          signedUpdate === undefined || signedFirmwareStatus === 'Idle'
            ? { status: signedFirmwareStatus }
            : { status: signedFirmwareStatus, requestId: signedUpdate.requestId },
        ),
      // A new key pair and CSR (A02.FR.02); without X.509 support it cannot be done.
      ...(tools !== undefined && {
        SignChargePointCertificate: () => {
          pendingCsr = undefined;
          requestCertificate(0);
        },
      }),
    };
    const send = senders[requested];
    if (send === undefined) return 'NotImplemented';
    later(delayFor('TriggerMessage'), send);
    return 'Accepted';
  }

  // ---- Certificates (Security Whitepaper M03 to M05, A02, A03) -------------

  const tools = options.certificateTools;
  const seeds = options.certificates;
  let installed: { certificateType: CertificateUse; certificate: string }[] = options.restore
    ?.certificates
    ? options.restore.certificates.installed.map((c) => ({ ...c }))
    : [
        ...(seeds?.centralSystemRoots ?? []).map((certificate) => ({
          certificateType: 'CentralSystemRootCertificate' as const,
          certificate,
        })),
        ...(seeds?.manufacturerRoots ?? []).map((certificate) => ({
          certificateType: 'ManufacturerRootCertificate' as const,
          certificate,
        })),
      ];
  let chargePointCertificate: ChargePointCertificate | undefined = options.restore?.certificates
    ? options.restore.certificates.chargePoint
    : seeds?.chargePoint;
  /** The client certificate a renewal replaced, kept until the new one connects (A02.FR.10, .28). */
  let previousChargePointCertificate: ChargePointCertificate | undefined;
  /** The key pair and CSR waiting for CertificateSigned. */
  let pendingCsr: { csr: string; privateKey: string } | undefined;
  let csrTimer: TimerHandle | undefined;

  const rootsOf = (type: CertificateUse) =>
    installed.filter((c) => c.certificateType === type).map((c) => c.certificate);
  const hashOf = (certificate: string) =>
    tools?.inspect(
      certificate,
      installed.map((c) => c.certificate),
    )?.hashData;

  /** Sends SignCertificate with a CSR, resending with back-off until CertificateSigned (A02.FR.17 to .19). */
  function requestCertificate(attempt: number): void {
    stopTimer(csrTimer);
    csrTimer = undefined;
    if (tools === undefined) return;
    if (pendingCsr === undefined) {
      const cpoName = configValue(config, 'CpoName') ?? '';
      pendingCsr = tools.createCsr({
        commonName:
          options.serialNumber ??
          options.boot.chargePointSerialNumber ??
          options.boot.chargeBoxSerialNumber ??
          options.boot.chargePointModel,
        ...(cpoName !== '' && { organization: cpoName }),
      });
      log('new key pair generated for a ChargePointCertificate');
    }
    const csr = pendingCsr.csr;
    void sendIfOnline('SignCertificate', { csr })?.then((outcome) => {
      if (!outcome.ok || outcome.payload.status !== 'Accepted') {
        log(`SignCertificate ${outcome.ok ? outcome.payload.status : outcome.failure.kind}`);
        return;
      }
      if (pendingCsr?.csr !== csr || attempt >= configInt(config, 'CertSigningRepeatTimes')) return;
      const waitMs = configInt(config, 'CertSigningWaitMinimum') * 1000 * 2 ** attempt;
      csrTimer = later(waitMs, () => {
        csrTimer = undefined;
        if (pendingCsr?.csr === csr) requestCertificate(attempt + 1);
      });
    });
  }

  function certificateSigned(chain: string): 'Accepted' | 'Rejected' {
    const reject = (reason: string) => {
      log(`CertificateSigned rejected: ${reason}`);
      securityEvent('InvalidChargePointCertificate', reason);
      // No back-off resending until the CSMS asks again (A02.FR.20).
      stopTimer(csrTimer);
      csrTimer = undefined;
      return 'Rejected' as const;
    };
    if (tools === undefined || pendingCsr === undefined) return reject('no CSR pending');
    if (chain.length > configInt(config, 'CertificateSignedMaxChainSize'))
      return reject('certificate chain too long');
    if (!tools.verifyChain(chain, rootsOf('CentralSystemRootCertificate'), now()))
      return reject('not a valid certificate of the CPO hierarchy');
    if (!tools.matchesKey(chain, pendingCsr.privateKey))
      return reject('not for the key of the CSR');
    previousChargePointCertificate = chargePointCertificate;
    chargePointCertificate = { certificate: chain, privateKey: pendingCsr.privateKey };
    pendingCsr = undefined;
    stopTimer(csrTimer);
    csrTimer = undefined;
    log('new ChargePointCertificate installed');
    securityEvent('ReconfigurationOfSecurityParameters', 'ChargePointCertificate renewed');
    // Switch to it by reconnecting when it is in use (A02.FR.08).
    if (configInt(config, 'SecurityProfile') === 3) later(0, () => options.reconnect?.());
    else previousChargePointCertificate = undefined;
    return 'Accepted';
  }

  function installCertificate(
    request: RequestOf<'InstallCertificate'>,
  ): ResponseOf<'InstallCertificate'>['status'] {
    if (tools === undefined) return 'Failed';
    const info = tools.inspect(request.certificate);
    if (info === undefined || now() < info.validFrom || now() > info.validTo) return 'Rejected';
    const sameType = installed.filter((c) => c.certificateType === request.certificateType);
    const existing = sameType.find((c) => {
      const hash = hashOf(c.certificate);
      return hash !== undefined && sameCertificate(hash, info.hashData);
    });
    const entry = { certificateType: request.certificateType, certificate: request.certificate };
    if (existing !== undefined) {
      // Already there: replace it (M05.FR.14).
      installed = installed.map((c) => (c === existing ? entry : c));
    } else if (
      request.certificateType === 'CentralSystemRootCertificate' &&
      configBool(config, 'AdditionalRootCertificateCheck') &&
      sameType.length > 0
    ) {
      // Only one root, and the new one must be signed by the old one (M05.FR.09, .10).
      if (!sameType.some((c) => tools.verifyChain(request.certificate, [c.certificate], now())))
        return 'Rejected';
      installed = [
        ...installed.filter((c) => c.certificateType !== request.certificateType),
        entry,
      ];
    } else {
      if (installed.length >= configInt(config, 'CertificateStoreMaxLength')) return 'Rejected';
      installed = [...installed, entry];
    }
    log(`${request.certificateType} installed`);
    changed();
    return 'Accepted';
  }

  function deleteCertificate(
    hashData: RequestOf<'DeleteCertificate'>['certificateHashData'],
  ): ResponseOf<'DeleteCertificate'>['status'] {
    if (tools === undefined) return 'Failed';
    const own =
      chargePointCertificate === undefined ? undefined : hashOf(chargePointCertificate.certificate);
    // The station's own certificate cannot be deleted this way (M04.FR.05).
    if (own !== undefined && sameCertificate(own, hashData)) return 'Failed';
    const found = installed.find((c) => {
      const hash = hashOf(c.certificate);
      return hash !== undefined && sameCertificate(hash, hashData);
    });
    if (found === undefined) return 'NotFound';
    // Nor can a CentralSystemRootCertificate (M04.FR.06).
    if (found.certificateType === 'CentralSystemRootCertificate') return 'Failed';
    installed = installed.filter((c) => c !== found);
    log(`${found.certificateType} deleted`);
    changed();
    return 'Accepted';
  }

  // ---- Signed firmware update (Security Whitepaper L01) -------------------

  type SignedFirmwareStatus = RequestOf<'SignedFirmwareStatusNotification'>['status'];
  let signedFirmwareStatus: SignedFirmwareStatus = 'Idle';
  let signedUpdate: { requestId: number; cancelled: boolean } | undefined;
  /** requestId of the update whose Installed is reported after the reboot. */
  let signedInstalledPendingReport: number | undefined;

  function reportSigned(status: SignedFirmwareStatus, requestId: number): void {
    signedFirmwareStatus = status;
    void sendIfOnline('SignedFirmwareStatusNotification', { status, requestId });
    changed();
  }

  async function runSignedFirmwareUpdate(
    request: RequestOf<'SignedUpdateFirmware'>,
  ): Promise<void> {
    const update = { requestId: request.requestId, cancelled: false };
    signedUpdate = update;
    const { firmware, requestId } = request;
    const done = (status?: SignedFirmwareStatus) => {
      if (status !== undefined) reportSigned(status, requestId);
      signedFirmwareStatus = 'Idle';
      if (signedUpdate === update) signedUpdate = undefined;
    };
    const waitUntil = async (at: string | undefined, scheduled: SignedFirmwareStatus) => {
      const ms = at === undefined ? 0 : Date.parse(at) - now();
      if (ms > 0) {
        reportSigned(scheduled, requestId);
        await delay(ms);
      }
    };
    await waitUntil(firmware.retrieveDateTime, 'DownloadScheduled');
    if (update.cancelled) return;
    reportSigned('Downloading', requestId);
    let image: Uint8Array | undefined;
    const downloaded = await withRetries(
      async () => {
        if (update.cancelled) return true;
        if (options.transfer !== undefined && isHttpLocation(firmware.location)) {
          image = await options.transfer.download(firmware.location);
          return image !== undefined;
        }
        await delay(firmwareSettings.downloadMs);
        return firmwareSettings.download === 'succeed';
      },
      request.retries,
      request.retryInterval,
    );
    if (update.cancelled) return;
    if (!downloaded) return done('DownloadFailed');
    reportSigned('Downloaded', requestId);
    // A real image is checked against the signature; a simulated one per the persona.
    const verified =
      image !== undefined && tools !== undefined
        ? tools.verifySignature(image, firmware.signature, firmware.signingCertificate)
        : firmwareSettings.signature === 'succeed';
    if (!verified) {
      securityEvent('InvalidFirmwareSignature', firmware.location.slice(0, 200));
      return done('InvalidSignature');
    }
    reportSigned('SignatureVerified', requestId);
    await waitUntil(firmware.installDateTime, 'InstallScheduled');
    await noTransactions();
    if (update.cancelled) return;
    reportSigned('Installing', requestId);
    await delay(firmwareSettings.installMs);
    if (update.cancelled) return;
    if (firmwareSettings.install === 'fail') return done('InstallationFailed');
    firmwareVersion = firmwareVersionFrom(firmware.location, firmwareVersion);
    signedInstalledPendingReport = requestId;
    reportSigned('InstallRebooting', requestId);
    log(`firmware ${firmwareVersion} installed`);
    signedUpdate = undefined;
    await resetChargePoint('Hard');
  }

  // ---- Security Profiles (Security Whitepaper) ----------------------------

  /** The profile to fall back to while the first connection with a new one is pending. */
  let securityFallback: number | undefined;

  /** ChangeConfiguration of SecurityProfile, per Security Whitepaper A05. */
  function changeSecurityProfile(value: string): 'Accepted' | 'Rejected' {
    const next = /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
    const current = configInt(config, 'SecurityProfile');
    const reject = (reason: string) => {
      log(`SecurityProfile ${value} rejected: ${reason}`);
      return 'Rejected' as const;
    };
    if (!Number.isInteger(next) || next < 0 || next > 3) return reject('not 0 to 3');
    const downgrade =
      current === 3 && next === 2 && configBool(config, 'AllowSecurityProfileDowngrade');
    if (next <= current && !downgrade) return reject(`not higher than ${current}`);
    if ((next === 1 || next === 2) && (configValue(config, 'AuthorizationKey') ?? '') === '')
      return reject('no AuthorizationKey');
    if (next >= 2 && rootsOf('CentralSystemRootCertificate').length === 0)
      return reject('no CentralSystemRootCertificate');
    if (next === 3 && chargePointCertificate === undefined)
      return reject('no ChargePointCertificate');
    config = changeConfiguration(config, { key: 'SecurityProfile', value: String(next) }).config;
    securityFallback = current;
    log(`SecurityProfile ${current} -> ${next}; reconnecting`);
    securityEvent('ReconfigurationOfSecurityParameters', `SecurityProfile ${current} to ${next}`);
    later(0, () => options.reconnect?.());
    return 'Accepted';
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
  const conversionFor = energy.conversion;

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
    const outcome = await current.call('BootNotification', bootPayload());
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
    if (installedPendingReport) {
      installedPendingReport = false;
      reportFirmware('Installed');
      firmwareStatus = 'Idle';
      securityEvent('FirmwareUpdated', `firmware ${firmwareVersion ?? 'unknown'}`);
    }
    if (signedInstalledPendingReport !== undefined) {
      reportSigned('Installed', signedInstalledPendingReport);
      signedInstalledPendingReport = undefined;
      signedFirmwareStatus = 'Idle';
      securityEvent('FirmwareUpdated', `firmware ${firmwareVersion ?? 'unknown'}`);
    }
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

  /** Power the EV draws on a connector, given its transaction and suspension state. */
  function updatePower(connectorId: number): void {
    const connector = findConnector(station, connectorId);
    const running =
      connector?.transactionId !== undefined &&
      connector.plugged &&
      !connector.evSuspended &&
      !connector.evseSuspended;
    // The Smart Charging limit becomes the power offered (and Power.Offered).
    energy.update(connectorId, running, profileLimitW(connectorId));
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
  function authorizeConnector(connectorId: number, idTag: string, source: SessionSource): void {
    authorized.set(connectorId, idTag);
    startSources.set(connectorId, source);
    hint({ kind: 'authorized', evseId: connectorId, idToken: { idToken: idTag }, source });
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
          if (authorized.has(connectorId)) {
            const idTag = authorized.get(connectorId) ?? '';
            authorized.delete(connectorId);
            log(`connector ${connectorId}: no cable within ConnectionTimeOut`);
            hint({
              kind: 'start-failed',
              evseId: connectorId,
              idToken: { idToken: idTag },
              source: startSources.get(connectorId) ?? 'local',
              reason: 'ConnectionTimeout',
            });
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
      hint({
        kind: 'start-failed',
        evseId: connectorId,
        idToken: { idToken: idTag },
        source: startSources.get(connectorId) ?? 'local',
        reason: 'StartFailed',
        detail: outcome.failure.kind,
      });
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
    wakeIdleWaiters();

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
    securityEvent('ResetOrReboot', `${type} reset`);
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

    UpdateFirmware(request) {
      void runFirmwareUpdate(request);
      return {};
    },

    GetDiagnostics(request) {
      const fileName = diagnosticsFileName(now());
      void runDiagnosticsUpload(request, fileName);
      return { fileName };
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
      if (request.key === 'SecurityProfile')
        return { status: changeSecurityProfile(request.value) };
      const result = changeConfiguration(config, request);
      if (request.key === 'AuthorizationKey' && result.status === 'Accepted') {
        config = result.config;
        log('AuthorizationKey changed; reconnecting with the new key');
        // Logged without the key itself (A01.FR.11, A01.FR.12).
        securityEvent('ReconfigurationOfSecurityParameters', 'AuthorizationKey changed');
        // Unless certificates authenticate the station, reconnect with the new password (A01).
        if (configInt(config, 'SecurityProfile') !== 3) later(0, () => options.reconnect?.());
        return { status: 'Accepted' };
      }
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
          hint({
            kind: 'start-failed',
            evseId: connectorId,
            idToken: { idToken: request.idTag },
            source: 'remote',
            reason: 'NotAuthorized',
          });
          return;
        }
        authorizeConnector(connectorId, request.idTag, 'remote');
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
      return { status: trigger(request.requestedMessage, request.connectorId) };
    },

    ExtendedTriggerMessage(request) {
      // FirmwareStatusNotification means the signed firmware update's status here.
      const requested =
        request.requestedMessage === 'FirmwareStatusNotification'
          ? 'SignedFirmwareStatusNotification'
          : request.requestedMessage;
      return { status: trigger(requested, request.connectorId) };
    },

    CertificateSigned(request) {
      return { status: certificateSigned(request.certificateChain) };
    },

    InstallCertificate(request) {
      return { status: installCertificate(request) };
    },

    GetInstalledCertificateIds(request) {
      const hashes = rootsOf(request.certificateType)
        .map(hashOf)
        .filter((hash) => hash !== undefined);
      const [first, ...rest] = hashes;
      return first === undefined
        ? { status: 'NotFound' }
        : { status: 'Accepted', certificateHashData: [first, ...rest] };
    },

    DeleteCertificate(request) {
      return { status: deleteCertificate(request.certificateHashData) };
    },

    SignedUpdateFirmware(request) {
      if (tools === undefined) return { status: 'Rejected' };
      if (
        !tools.verifyChain(
          request.firmware.signingCertificate,
          rootsOf('ManufacturerRootCertificate'),
          now(),
        )
      ) {
        securityEvent('InvalidFirmwareSigningCertificate', 'not signed by a manufacturer root');
        return { status: 'InvalidCertificate' };
      }
      const cancelled = signedUpdate !== undefined;
      if (signedUpdate !== undefined) signedUpdate.cancelled = true;
      void runSignedFirmwareUpdate(request);
      return { status: cancelled ? 'AcceptedCanceled' : 'Accepted' };
    },

    GetLog(request) {
      const cancelled = logUpload !== undefined;
      if (logUpload !== undefined) logUpload.cancelled = true;
      const filename = diagnosticsFileName(
        now(),
        request.logType === 'SecurityLog' ? 'security' : 'diagnostics',
      );
      void runLogUpload(request, filename);
      return { status: cancelled ? 'AcceptedCanceled' : 'Accepted', filename };
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
    authCache = restored.authCache;
    outbox.restore(restored.outbox);
    for (const [ref, id] of Object.entries(restored.csmsIds)) csmsIds.set(ref, id);
    for (const transaction of restored.transactions) {
      if (transaction.transactionId !== undefined)
        csmsIds.set(transaction.ref, transaction.transactionId);
      const energy = restored.meters[String(transaction.connectorId)] ?? transaction.meterStartWh;
      outbox.restore([
        {
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
        },
      ]);
    }
  }

  // Powering up is a security event, sent once the CSMS has accepted the boot.
  securityEvent('StartupOfTheDevice');

  // ---- Public interface -------------------------------------------------

  return {
    ocpp: '1.6',

    connected() {
      // The new Security Profile worked: no way back (A05.FR.09).
      securityFallback = undefined;
      // Connected with the renewed certificate: drop the old one (A02.FR.10).
      previousChargePointCertificate = undefined;
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
          OCPP16_ACTION_PROFILES[action] === 'Security' ||
          supports(OCPP16_ACTION_PROFILES[action]),
        onEvent: (event) => emit({ type: 'rpc', event }),
      });
      void boot();
    },

    halt() {
      timers.halt();
      rpc?.close();
      rpc = undefined;
    },

    disconnected() {
      rpc?.close();
      rpc = undefined;
      registration = 'Offline';
      for (const timer of [heartbeatTimer, bootTimer, alignedTimer]) stopTimer(timer);
      heartbeatTimer = bootTimer = alignedTimer = undefined;
      outbox.pause();
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
      // Throws a RangeError for an unusable profile, before anything changes.
      if (ev !== undefined) energy.plugEv(connectorId, ev);
      if (applyDevice({ type: 'Plug', connectorId }).error !== undefined) return;
      if (authorized.has(connectorId)) {
        clearPrepare(connectorId);
        later(timing.startTransactionDelayMs, () => beginTransaction(connectorId));
      } else if (
        configBool(config, 'FreeVendEnabled') &&
        !transactions.has(connectorId) &&
        findConnector(station, connectorId)?.reservationId === undefined
      ) {
        // Free vending: the cable is enough; the transaction carries FreeVendIdTag.
        const idTag = configValue(config, 'FreeVendIdTag') || 'FreeVend';
        log(`connector ${connectorId}: free vend as ${idTag}`);
        authorizeConnector(connectorId, idTag, 'noAuth');
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
      if (energy.removeEv(connectorId)) changed();
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
        hint({
          kind: 'start-failed',
          evseId: connectorId,
          idToken: { idToken: idTag },
          source: 'local',
          reason: 'NotAuthorized',
          detail: 'reserved for another idTag',
        });
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
        hint({
          kind: 'start-failed',
          evseId: connectorId,
          idToken: { idToken: idTag },
          source: 'local',
          reason: 'NotAuthorized',
        });
        return 'rejected';
      }
      if (reserved.reservationId !== undefined) {
        sessionReservations.set(connectorId, reserved.reservationId);
      }
      authorizeConnector(connectorId, idTag, 'local');
      return 'authorized';
    },

    evSuspend(connectorId) {
      if (applyDevice({ type: 'EvSuspend', connectorId }).error === undefined)
        updatePower(connectorId);
    },

    evResume(connectorId) {
      if (!energy.canResume(connectorId)) {
        log(`connector ${connectorId}: the EV is full and does not resume`);
        return;
      }
      if (applyDevice({ type: 'EvResume', connectorId }).error === undefined)
        updatePower(connectorId);
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
      energy.setMultiplier(checkedMultiplier(multiplier));
      changed();
    },

    snapshot() {
      const station0 = stationStatus(station);
      return {
        ocpp: '1.6',
        registration,
        connected: rpc !== undefined,
        station: { status: station0.status, errorCode: station0.errorCode },
        connectors: connectors(station).map((connector) => {
          const status = connectorStatus(connector, station);
          const reading = syncMeter(connector.connectorId);
          const ev = energy.ev(connector.connectorId);
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
            offeredW: reading.offeredW,
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
        config: readableConfigValues(config),
        queuedMessages: outbox.entries.length,
        ...(firmwareVersion !== undefined && { firmwareVersion }),
        firmwareStatus,
        diagnosticsStatus,
        logStatus,
        signedFirmwareStatus,
        certificates: {
          centralSystemRoots: rootsOf('CentralSystemRootCertificate').length,
          manufacturerRoots: rootsOf('ManufacturerRootCertificate').length,
          chargePoint: chargePointCertificate !== undefined,
        },
        securityEvents: securityLog.slice(-20).map((entry) => ({ ...entry })),
        behaviour: { ...behaviour },
        energyMultiplier: energy.multiplier,
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

    securityEvent,

    connectionSecurity() {
      const authorizationKey = configValue(config, 'AuthorizationKey') ?? '';
      return {
        profile: configInt(config, 'SecurityProfile'),
        ...(authorizationKey !== '' && { authorizationKey }),
        centralSystemRoots: rootsOf('CentralSystemRootCertificate'),
        ...(chargePointCertificate !== undefined && {
          chargePointCertificate: { ...chargePointCertificate },
        }),
      };
    },

    connectionFailed() {
      if (previousChargePointCertificate !== undefined) {
        // The renewed certificate does not work: back to the old one (A02.FR.28, .29).
        chargePointCertificate = previousChargePointCertificate;
        previousChargePointCertificate = undefined;
        log('could not connect with the renewed ChargePointCertificate; back to the old one');
        securityEvent('DiscardedRenewedClientCertificate');
        options.reconnect?.();
        return;
      }
      if (securityFallback === undefined) return;
      const previous = securityFallback;
      securityFallback = undefined;
      config = changeConfiguration(config, {
        key: 'SecurityProfile',
        value: String(previous),
      }).config;
      log(`could not connect with the new Security Profile; back to ${previous}`);
      securityEvent('ReconfigurationOfSecurityParameters', `SecurityProfile back to ${previous}`);
      options.reconnect?.();
    },

    persistentState(): PersistedChargePoint {
      const savedAt = now();
      return {
        version: 1,
        savedAt,
        config: { ...config.values },
        meters: energy.registers(),
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
        outbox: outbox.entries.map((entry) => ({ ...entry })),
        csmsIds: Object.fromEntries(csmsIds),
        sequence,
        behaviour: { ...behaviour },
        energyMultiplier: energy.multiplier,
        localList,
        reservations: [...reservations.values()].map((r) => ({ ...r })),
        chargingProfiles: chargingProfiles.map((p) => ({ ...p })),
        ...(firmwareVersion !== options.boot.firmwareVersion &&
          firmwareVersion !== undefined && { firmwareVersion }),
        securityLog: securityLog.map((entry) => ({ ...entry })),
        certificates: {
          installed: installed.map((c) => ({ ...c })),
          ...(chargePointCertificate !== undefined && {
            chargePoint: { ...chargePointCertificate },
          }),
        },
      };
    },
  };
}
