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
import type { SessionHint, SessionIdToken, SessionSource } from '../session.js';
import {
  DEFAULT_BEHAVIOUR,
  DEFAULT_TIMING,
  type ChargePoint,
  type ChargePointBehaviour,
  type ChargePointEvent,
  type ChargePointSnapshot,
  type DisplayMessage,
  type ChargePointTiming,
  type IdTagResult,
  type PluggedEv,
  type Registration,
} from '../charge-point.js';
import type { ChargePointCertificate, CertificateTools } from '../certificates.js';
import type { Clock, TimerHandle } from '../clock.js';
import {
  connectors,
  createStation,
  findConnector,
  reduce,
  type Availability,
  type DeviceEvent,
  type Fault,
  type ReduceResult,
  type ConnectorState,
  type StationState,
} from '../device.js';
import { createEnergy } from '../energy.js';
import type { FileTransfer, FirmwareSettings } from '../firmware.js';
import { nextAlignedSample, nextPeriodicSample } from '../meter.js';
import type { IdGenerator } from '../ids.js';
import { OCPP201_MESSAGE_SET, OCPP21_MESSAGE_SET, type Ocpp21RpcTypes } from '../message-set.js';
import type { JsonObject } from '../ocppj.js';
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
import {
  checkTariff,
  createCostMeter,
  type CostMeter,
  type CostMeterSnapshot,
  type Tariff21,
  type TariffSituation,
} from '../ocpp21/tariff-cost.js';
import {
  paymentInfo,
  totpInterval,
  totpV1,
  webPaymentUrl as paymentUrlOf,
  withCardDefaults,
  type HmacSha256,
  type PaymentCard,
  type WebPaymentLimits,
} from '../ocpp21/payment.js';
import type {
  AddressType,
  AttributeEnumType,
  BootReasonEnumType,
  ChargingStateEnumType,
  ChargingStationType,
  IdTokenInfoType,
  IdTokenType,
  MeterValueType,
  ReadingContextEnumType,
  ReasonEnumType,
  TransactionEventEnumType,
  TriggerReasonEnumType,
  Ocpp21RequestOf,
  Ocpp21ResponseOf,
} from '../ocpp21/messages.js';
import { chargingNeeds } from './charging-needs.js';
import { chargingNeeds21, vehicleReadings } from '../ocpp21/iso15118-20.js';
import { speaksIso15118, type EvProfile } from '../ev.js';
import {
  applyOverrides,
  componentKey,
  createDeviceModel,
  parseComponentKey,
  parseVariableKey,
  variableKey,
  type DeviceModelOverrides,
} from './device-model.js';
import { sampleMeter201, sampleUpstream } from './meter-values.js';
import {
  applyLocalList,
  cachedToken,
  decideToken,
  EMPTY_LOCAL_LIST_201,
  tokenKey,
  rememberToken,
  sameGroup,
  type AuthCache201,
  type LocalList201,
} from './authorization.js';
import { createSecurity201, type PersistedSecurity201 } from './security.js';
import {
  compositeSchedule201,
  endTransactionProfiles201,
  installProfile201,
  limits201,
  profileProblem,
  profileProblem21,
  applyDynamicUpdate,
  selectProfiles201,
  clearProfiles201,
  type ChargingProfile201,
  type InstallContext201,
  type InstalledProfile201,
} from './smart-charging.js';
import { toWatts, type ChargingRateUnit } from '../charging-profile.js';
import {
  lostReservations,
  reserveAnswer,
  reservedEvses,
  useAt,
  type BaseStatus,
  type EvseView,
  type Reservation201,
} from './reservation.js';
import {
  CERTIFICATE_ENTRIES_MAX,
  CHARGING_PROFILES_MAX,
  LOCAL_LIST_SIZE,
  standardVariables,
} from './standard-variables.js';
import { chargingState, parseTxPoints, startPoint, stopPoint } from './transaction.js';
import { connectorStatus201, stationStatus201, type ConnectorStatus201 } from './status.js';

type Out = Ocpp21RpcTypes['out'];

/** The 2.1 tariff messages; without TariffCostCtrlr.Enabled[Tariff] they answer NotSupported. */
const TARIFF_ACTIONS: ReadonlySet<string> = new Set([
  'SetDefaultTariff',
  'GetTariffs',
  'ClearTariffs',
  'ChangeTransactionTariff',
]);

/** The CSMS messages of the SmartCharging profile; without it they answer NotSupported (K01.FR.29). */
const SMART_CHARGING_ACTIONS: ReadonlySet<string> = new Set([
  'SetChargingProfile',
  'ClearChargingProfile',
  'GetChargingProfiles',
  'GetCompositeSchedule',
]);

/** The certification profiles a 2.0.1 station can support (Part 5). */
export const CERTIFICATION_PROFILES = [
  'Core',
  'AdvancedSecurity',
  'LocalAuthListManagement',
  'SmartCharging',
  'Reservation',
] as const;

/**
 * 2.1 has no certification profiles yet; a 2.1 station keeps the 2.0.1 ones
 * and adds these feature groups (see "M7 OCPP 2.1" in docs/design.md).
 */
export const FEATURES_21 = ['TariffAndCost', 'Payment', 'WebPayments'] as const;

export interface ChargePoint201Options {
  clock: Clock;
  ids: IdGenerator;
  /** The station's OCPP version: 2.0.1 (default) or 2.1, which builds on it. */
  ocpp?: '2.0.1' | '2.1';
  /**
   * How a 2.1 station reports connector availability: NotifyEvent on
   * Connector.AvailabilityState, the method 2.1 prefers (default), or the
   * deprecated StatusNotification. 2.0.1 stations always use StatusNotification.
   */
  connectorStatus?: 'NotifyEvent' | 'StatusNotification';
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
  /** What the station supplies across all its EVSEs, in W, shared by them. Default: no shared cap. */
  stationPowerW?: number;
  send: (text: string) => void;
  /** Asks the transport to drop the connection and reconnect after `downtimeMs`. */
  restart?: (downtimeMs: number) => void;
  /** Asks the transport to reconnect at once with the current security settings. */
  reconnect?: () => void;
  onEvent?: (event: ChargePointEvent) => void;
  behaviour?: Partial<ChargePointBehaviour>;
  energyMultiplier?: number;
  /** Certificates a new station starts with; a restored state's take precedence. */
  certificates?: {
    centralSystemRoots?: readonly string[];
    manufacturerRoots?: readonly string[];
    chargePoint?: ChargePointCertificate;
  };
  /** X.509 support for certificates and signed firmware; without it those messages fail. */
  certificateTools?: CertificateTools;
  /** 2.1: HMAC-SHA256 for the web payment code (C25); without it there is no payment URL. */
  hmacSha256?: HmacSha256;
  /** The CN of a CSR; default the boot serial number. */
  serialNumber?: string;
  /** Timings and outcomes of simulated firmware updates and log uploads. */
  firmware?: Partial<FirmwareSettings>;
  /** Real HTTP(S) transfers for UpdateFirmware and GetLog; simulated without it. */
  transfer?: FileTransfer;
  /** State saved by persistentState() before a restart. */
  restore?: PersistedChargePoint201;
}

/** Everything a 2.0.1 station keeps across an engine restart. */
export interface PersistedChargePoint201 {
  version: 1;
  /** 2.1: the default tariffs, kept across restarts (I07.FR.13). */
  tariffs?: TariffEntry[];
  ocpp: '2.0.1' | '2.1';
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
  authCache: AuthCache201;
  localList: LocalList201;
  /** Certificates, network profiles, the security log, firmware; missing in older states. */
  security?: PersistedSecurity201;
  /** Installed charging profiles (K01.FR.27); missing in older states. */
  chargingProfiles?: InstalledProfile201[];
  /** Reservations not yet used, cancelled or expired; missing in older states. */
  reservations?: Reservation201[];
  /** 2.1: cards the payment terminal holds, until their settlement. */
  payments?: TerminalPayment[];
}

/** A card at a 2.1 station's payment terminal, and how its PSP answers (C18 to C23). */
export interface TerminalCard extends PaymentCard {
  /** The PSP declines the card. */
  decline?: boolean;
  /** The settlement's outcome at the end (C21, C22). Default Settled. */
  settlement?: 'Settled' | 'Rejected' | 'Failed';
  /** The PSP refuses to raise the authorization (C23). */
  declineIncrement?: boolean;
}

/** A card the payment terminal authorized, until its settlement (C18 to C22). */
export interface TerminalPayment {
  evseId: number;
  /** PspRef as an idToken of type DirectPayment, with the card's details. */
  idToken: IdTokenType;
  card: TerminalCard;
  /** The amount the terminal holds now. */
  authorized: number;
  /** The transaction it pays for, once an event carried its token. */
  transactionId?: string;
  /** The PSP refused to raise the authorization. */
  noIncrement?: boolean;
  /** A VAT number the CSMS accepted, for the receipt (C18.FR.08). */
  vat?: { number: string; company?: AddressType };
  /** The transaction's cost when the state was saved, for a settlement after a restart. */
  lastCost?: number;
}

export type PaymentCardResult =
  'authorized' | 'declined' | 'rejected' | 'busy' | 'unknown-connector' | 'not-supported';
export type PaymentStopResult = 'canceled' | 'stopping' | 'no-payment' | 'unknown-connector';
export type WebPaymentUrlResult =
  | { url: string; totp: string; validUntil: string }
  | { error: 'not-supported' | 'disabled' | 'no-hmac' | 'unknown-connector' };
export interface VatResult {
  status: 'Accepted' | 'Rejected' | 'not-supported' | 'no-answer';
  company?: AddressType;
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
  /** 2.1, for resuming after a power loss (E17): the charging state, the limits, the EV. */
  chargingState?: ChargingStateEnumType;
  limits?: Record<string, number>;
  ev?: PluggedEv;
  /** 2.1: the station's own cost so far, to carry it on when the transaction resumes (E17). */
  cost?: CostMeterSnapshot;
}

/** A token authorized at a connector, with what the CSMS, list or cache said about it. */
interface Authorization {
  idToken: IdTokenType;
  info?: Omit<IdTokenInfoType, 'customData'>;
  remoteStartId?: number;
  /** The TxProfile a RequestStartTransaction brought, for the transaction it starts (K05). */
  txProfile?: ChargingProfile201;
  /** The reservation the token used, reported with the transaction (H01.FR.15). */
  reservationId?: number;
  /** 2.1: limits the driver put in a payment URL, for the web payment's transaction (C25.FR.60). */
  limits?: TransactionLimit;
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
  /** The reservation it used went to the CSMS. */
  reservationSent?: boolean;
  limitReached?: boolean;
  periodicTimer?: TimerHandle | undefined;
  endedTimer?: TimerHandle | undefined;
  limitTimer?: TimerHandle | undefined;
  /** 2.1: the transaction's cost, energy, time and SoC limits (E16), the supported ones. */
  limits?: TransactionLimit;
  /** 2.1: the limit that stopped the energy transfer. */
  limitHit?: LimitName | undefined;
  /** 2.1: the latest cost the CSMS sent (totalCost, CostUpdated), for maxCost. */
  csmsCost?: number;
  transactionLimitTimer?: TimerHandle | undefined;
  /** 2.1: the transaction was Charging before a reset or power loss it is resumed after. */
  wasCharging?: boolean | undefined;
  /** 2.1: resumed without AllowEnergyTransferResumption, so it stays SuspendedEVSE (B13.FR.14). */
  resumeHold?: boolean;
  /** 2.1: the station's own cost of the transaction, from its tariff (I12). */
  cost?: CostMeter;
  /** 2.1: the next event names the tariff (I07.FR.31, I11.FR.07). */
  tariffIdPending?: boolean;
  costTimer?: TimerHandle | undefined;
  costReportTimer?: TimerHandle | undefined;
  /** 2.1: the upstream meter's samples, every SampledDataCtrlr.UpstreamInterval. */
  upstreamTimer?: TimerHandle | undefined;
}

/** A default tariff installed on an EVSE (I07). */
interface TariffEntry {
  evseId: number;
  tariff: Tariff21;
  installedAt: number;
}

type TransactionLimit = Omit<
  Ocpp21RequestOf<'TransactionEvent'>['transactionInfo']['transactionLimit'] & {},
  'customData'
>;
type LimitName = 'maxCost' | 'maxEnergy' | 'maxTime' | 'maxSoC';
const LIMIT_NAMES: readonly LimitName[] = ['maxCost', 'maxEnergy', 'maxSoC', 'maxTime'];
/** The trigger reason of the event that reports a limit reached (E16.FR.05, .06). */
const LIMIT_TRIGGERS: Record<LimitName, TriggerReasonEnumType> = {
  maxCost: 'CostLimitReached',
  maxEnergy: 'EnergyLimitReached',
  maxSoC: 'SoCLimitReached',
  maxTime: 'TimeLimitReached',
};
/** How often limits on SoC and cost (which follow the EV and the CSMS) are checked, in ms. */
const LIMIT_POLL_MS = 1000;

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
/** One Device Model variable as the API and the Web UI show it. */
export interface DeviceModelEntry {
  /** `Name`, `Name:instance`, `Name@evse` or `Name@evse.connector`. */
  component: string;
  /** `Name` or `Name:instance`. */
  variable: string;
  dataType: string;
  unit?: string;
  valuesList?: string;
  minLimit?: number;
  maxLimit?: number;
  /** Each attribute; the value of a WriteOnly one is never shown. */
  attributes: { type: string; mutability: string; value?: string }[];
}

export interface ChargePoint201 extends ChargePoint {
  persistentState(): PersistedChargePoint201;
  /**
   * 2.1: the driver's priority charging button on an EVSE (K22): on needs a
   * PriorityCharging profile for it (K22.FR.01) and a transaction.
   */
  priorityCharging(
    evseId: number,
    activate: boolean,
  ): 'activated' | 'deactivated' | 'no-profile' | 'no-transaction' | 'not-2.1';
  /**
   * 2.1 with Payment: a card at the EVSE's payment terminal (C18). The
   * terminal holds PaymentCtrlr.AuthorizationAmount; the CSMS approves it when
   * AuthorizeDirectPayment is true.
   */
  presentPaymentCard(evseId: number, card?: TerminalCard): Promise<PaymentCardResult>;
  /** 2.1: the driver stops at the payment terminal: canceled before the transaction (C19), else it ends (C20, C21). */
  stopPayment(evseId: number): PaymentStopResult;
  /** 2.1 with Payment: a VAT number the driver entered, checked by the CSMS (C18.FR.08). */
  validateVatNumber(evseId: number | undefined, vatNumber: string): Promise<VatResult>;
  /** 2.1 with WebPayments: the dynamic QR code's URL for an EVSE now, with the driver's limits (C25). */
  webPaymentUrl(evseId: number, limits?: WebPaymentLimits): WebPaymentUrlResult;
  /**
   * The driver or the EV changes the plugged-in EV's target SoC or departure.
   * An ISO 15118-20 EV on a 2.1 station reports its new needs (K20); others
   * only charge to the new target. Throws a RangeError for unusable values.
   */
  changeEvNeeds(
    evseId: number,
    changes: Pick<EvProfile, 'targetSoc' | 'departureMinutes' | 'minimumSoc'>,
  ): 'reported' | 'changed' | 'no-ev';
  /** The Device Model: every variable with its characteristics and attribute values. */
  deviceModelView(): DeviceModelEntry[];
  /**
   * Sets an Actual value as a local operator would: the SetVariables checks
   * apply (mutability, data type, limits), and so do its effects.
   */
  setVariable(
    component: string,
    variable: string,
    value: string,
  ): { status: string; reason?: string };
}

export function createChargePoint201(options: ChargePoint201Options): ChargePoint201 {
  const { clock, ids } = options;
  const ocpp = options.ocpp ?? '2.0.1';
  const v21 = ocpp === '2.1';
  const availabilityByEvent = v21 && options.connectorStatus !== 'StatusNotification';
  // NotifyEvent ids, shared by availability and fault events.
  let eventId = 0;
  const timing: ChargePointTiming = { ...DEFAULT_TIMING, ...options.timing };
  const offeredW = options.offeredPowerW ?? 7360;
  const emit = options.onEvent ?? (() => {});
  const log = (message: string) => emit({ type: 'log', message });
  const hint = (value: SessionHint) => emit({ type: 'session', hint: value });
  const tokenRef = (idToken: IdTokenType): SessionIdToken => ({
    idToken: idToken.idToken,
    type: idToken.type,
  });
  const localSource = (idToken: IdTokenType): SessionSource =>
    idToken.type === 'DirectPayment'
      ? 'payment'
      : idToken.type === 'NoAuthorization'
        ? 'noAuth'
        : 'local';
  /** A remote start with a DirectPayment token is a web payment (C24, C25). */
  const remoteSourceOf = (idToken: IdTokenType): SessionSource =>
    idToken.type === 'DirectPayment' ? 'payment' : 'remote';
  /** connectorId → when the EV was plugged in; set while NotifyEVChargingNeeds is still due. */
  const needsDue = new Map<number, number>();
  /** When the EV on each EVSE was plugged in, for the departure time of changed needs (K20). */
  const pluggedAtOf = new Map<number, number>();
  /** 2.1: an ISO 15118-20 EV's needs not sent yet, with when the EV gave them. */
  const needsWaiting = new Map<
    number,
    { evseId: number; chargingNeeds: ReturnType<typeof chargingNeeds21>; timestamp: string }
  >();
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

  let rpc: Rpc<Ocpp21RpcTypes> | undefined;
  let registration: Registration = 'Offline';
  let heartbeatTimer: TimerHandle | undefined;
  let bootTimer: TimerHandle | undefined;
  /** Why the next BootNotification is sent. */
  let bootReason: BootReasonEnumType = 'PowerUp';
  /** 2.1: EVSEs whose transactions resume once the boot is accepted (B13, E17). */
  let resuming = new Set<number>();
  /** 2.1: the station is down for a reset whose transactions resume (B13.FR.20); no energy. */
  let poweredDown = false;
  /** 2.1: EVSEs being reset on their own with their transactions kept (B13.FR.10). */
  const evsesDown = new Set<number>();
  /** A reset waiting for the transactions it concerns to end (OnIdle, B12.FR.01). */
  let scheduledReset: { evseId?: number } | undefined;
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
    ...(options.stationPowerW !== undefined && { stationW: options.stationPowerW }),
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
      ocpp,
    }),
    options.deviceModel,
  );
  if (!applied.ok) throw new Error(`deviceModel: ${applied.problems.join('; ')}`);
  const deviceModel = createDeviceModel({
    definitions: applied.definitions,
    ...(options.restore !== undefined && { saved: options.restore.deviceModel }),
    check: (key, value) => security.checkVariable(key, value),
    read(key) {
      if (key === 'ClockCtrlr/DateTime') return timestamp();
      const known = security.read(key);
      if (known !== undefined) return known;
      const [componentText = '', variableName] = key.split('/');
      const component = parseComponentKey(componentText);
      if (component === undefined) return undefined;
      if (component.name === 'ChargingStation' && variableName === 'AvailabilityState') {
        return stationStatus201(station);
      }
      if (component.name === 'ChargingStation' && variableName === 'Problem') {
        return String(station.fault !== undefined);
      }
      if (component.name === 'LocalAuthListCtrlr' && variableName === 'Entries') {
        return String(Object.keys(localList.entries).length);
      }
      if (component.name === 'SmartChargingCtrlr' && variableName === 'Entries') {
        return String(chargingProfiles.length);
      }
      const connector =
        component.evse === undefined ? undefined : findConnector(station, component.evse.id);
      if (connector === undefined) return undefined;
      if (variableName === 'AvailabilityState') return connectorStatus201(connector, station);
      if (variableName === 'Problem') return String(connector.fault !== undefined);
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
    payload: Ocpp21RequestOf<A>,
  ): Promise<RpcOutcome<Ocpp21ResponseOf<A>>> | undefined {
    return online()
      ? (rpc?.call(action, payload as never) as Promise<RpcOutcome<Ocpp21ResponseOf<A>>>)
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
    changed: () => {
      changed();
      if (outbox.entries.length === 0) releaseDelivered();
    },
    answered: (entry, payload) => restoredAnswers.set(entry.key, payload),
    settled: (entry) => {
      const settle = afterRestoredEnd.get(entry.key);
      const answer = restoredAnswers.get(entry.key);
      restoredAnswers.delete(entry.key);
      afterRestoredEnd.delete(entry.key);
      settle?.(answer as Ocpp21ResponseOf<'TransactionEvent'> | undefined);
    },
  });
  /** Ended events of card-paid transactions the restart ended: they settle once sent. */
  const afterRestoredEnd = new Map<
    string,
    (answer: Ocpp21ResponseOf<'TransactionEvent'> | undefined) => void
  >();
  const restoredAnswers = new Map<string, unknown>();

  /**
   * NotifySettlement goes through the outbox: a settlement made while offline, or before a restart,
   * reaches the CSMS once the station is back, in order after the transaction's events.
   */
  function notifySettlement(
    payload: Ocpp21RequestOf<'NotifySettlement'>,
  ): Promise<RpcOutcome<Ocpp21ResponseOf<'NotifySettlement'>>> {
    return outbox.enqueue('NotifySettlement', payload as unknown as JsonObject) as Promise<
      RpcOutcome<Ocpp21ResponseOf<'NotifySettlement'>>
    >;
  }

  /** Waiting for the queued messages to be delivered (before a reset reboots). */
  let deliveredWaiters: (() => void)[] = [];
  function releaseDelivered(): void {
    const waiting = deliveredWaiters;
    deliveredWaiters = [];
    for (const release of waiting) release();
  }

  /**
   * Resolves once the queued messages are delivered, as a station sends its
   * transaction messages before rebooting (1.6 waits for StopTransaction the
   * same way). Offline, or after MessageTimeout, it resolves at once; what is
   * left goes after the boot.
   */
  function whenDelivered(): Promise<void> {
    if (!online() || outbox.entries.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = later(
        Math.max(1, dmInt('OCPPCommCtrlr', 'MessageTimeout:Default')) * 1000,
        done,
      );
      deliveredWaiters.push(done);
      function done() {
        stopTimer(timer);
        deliveredWaiters = deliveredWaiters.filter((release) => release !== done);
        resolve();
      }
    });
  }

  // ---- Security, firmware and logs ----------------------------------------

  const seeds = options.certificates;
  const security = createSecurity201({
    timers,
    now,
    log,
    changed,
    get: (component, variable) => deviceModel.get(component, variable),
    set: (component, variable, value) => deviceModel.set(component, variable, value),
    send: sendIfOnline,
    enqueue: (payload) =>
      void outbox.enqueue('SecurityEventNotification', payload as unknown as JsonObject),
    tools: options.certificateTools,
    transfer: options.transfer,
    firmware: options.firmware,
    firmwareVersion: options.boot.firmwareVersion,
    seeds: {
      ...(seeds?.centralSystemRoots !== undefined && { csmsRoots: seeds.centralSystemRoots }),
      ...(seeds?.manufacturerRoots !== undefined && {
        manufacturerRoots: seeds.manufacturerRoots,
      }),
      ...(seeds?.chargePoint !== undefined && { chargingStation: seeds.chargePoint }),
    },
    commonName: options.serialNumber ?? options.boot.serialNumber ?? options.boot.model,
    maxCertificates: CERTIFICATE_ENTRIES_MAX,
    restore: options.restore?.security,
    reconnect: () => options.reconnect?.(),
    reboot: () => rebootForFirmware(),
    noTransactions: async () => {
      while (transactions.size > 0) await timers.delay(1000);
    },
    diagnostics: () => diagnosticsText(),
    v21,
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
    const changes: { evseId: number; status: ConnectorStatus201 }[] = [];
    for (const connector of connectors(station)) {
      const status = connectorStatus201(connector, station);
      if (!all && reported.get(connector.connectorId) === status) continue;
      reported.set(connector.connectorId, status);
      changes.push({ evseId: connector.connectorId, status });
    }
    if (changes.length === 0) return;
    if (availabilityByEvent) {
      // 2.1: one NotifyEvent with an AvailabilityState event per connector (G01, B01.FR.05).
      const payload: Ocpp21RequestOf<'NotifyEvent'> = {
        generatedAt: timestamp(),
        seqNo: 0,
        eventData: changes.map(({ evseId, status }) => ({
          eventId: ++eventId,
          timestamp: timestamp(),
          trigger: 'Delta' as const,
          actualValue: status,
          eventNotificationType: 'HardWiredNotification' as const,
          component: { name: 'Connector', evse: { id: evseId, connectorId: 1 } },
          variable: { name: 'AvailabilityState' },
        })),
      };
      if (online()) void sendIfOnline('NotifyEvent', payload);
      else void outbox.enqueue('NotifyEvent', payload);
      return;
    }
    for (const { evseId, status } of changes) {
      const payload = { timestamp: timestamp(), connectorStatus: status, evseId, connectorId: 1 };
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
    if (event.type !== 'Reserve' && event.type !== 'Unreserve') checkReservations();
    changed();
    return result;
  }

  // ---- Reservations (H) -----------------------------------------------------

  let reservations: Reservation201[] = [...(options.restore?.reservations ?? [])];
  const reservationTimers = new Map<number, TimerHandle>();
  let syncingReservations = false;
  const reservationsOn = () => features.includes('Reservation');

  /** The EVSEs as the reservation rules see them: status without reservations, connector type. */
  function evseViews(): EvseView[] {
    return connectors(station).map((c) => {
      const { reservationId: _held, ...rest } = c;
      return {
        id: c.connectorId,
        connectorType: deviceModel.get(`Connector@${c.connectorId}.1`, 'ConnectorType') ?? '',
        status: connectorStatus201(rest as ConnectorState, station) as BaseStatus,
      };
    });
  }

  /** The device reducer's Reserved state follows the reservations (H01.FR.20, .23, .24; H03.FR.10). */
  function syncReserved(): void {
    if (syncingReservations) return;
    syncingReservations = true;
    try {
      const shown = reservedEvses(reservations, evseViews());
      for (const connector of connectors(station)) {
        const wanted = shown.get(connector.connectorId);
        if (wanted !== undefined && connector.reservationId !== wanted) {
          applyDevice({
            type: 'Reserve',
            connectorId: connector.connectorId,
            reservationId: wanted,
          });
        } else if (wanted === undefined && connector.reservationId !== undefined) {
          applyDevice({ type: 'Unreserve', connectorId: connector.connectorId });
        }
      }
    } finally {
      syncingReservations = false;
    }
  }

  function scheduleExpiry(reservation: Reservation201): void {
    stopTimer(reservationTimers.get(reservation.id));
    reservationTimers.set(
      reservation.id,
      later(Math.max(0, reservation.expiresAt - now()), () =>
        endReservation(reservation.id, 'expired', 'Expired'),
      ),
    );
  }

  /** A reservation ends; Expired and Removed are reported (H04.FR.01, H01.FR.16, .17). */
  function endReservation(id: number, why: string, update?: 'Expired' | 'Removed'): void {
    if (!reservations.some((r) => r.id === id)) return;
    reservations = reservations.filter((r) => r.id !== id);
    stopTimer(reservationTimers.get(id));
    reservationTimers.delete(id);
    log(`reservation ${id} ${why}`);
    if (update !== undefined) {
      void sendIfOnline('ReservationStatusUpdate', {
        reservationId: id,
        reservationUpdateStatus: update,
      });
    }
    syncReserved();
    changed();
  }

  /** After a device change: reservations whose EVSEs are all Faulted or Unavailable go. */
  function checkReservations(): void {
    if (syncingReservations || reservations.length === 0) return;
    for (const lost of lostReservations(reservations, evseViews())) {
      endReservation(lost.id, 'removed: its EVSE is Faulted or Unavailable', 'Removed');
    }
    syncReserved();
  }

  /**
   * Whether a token may start at an EVSE given the reservations, using the
   * reservation it matches (H03.FR.09): that one ends without a report.
   */
  function claimReservation(
    connectorId: number,
    idToken: IdTokenType,
    groupIdToken: IdTokenType | undefined,
  ): { ok: boolean; reservationId?: number } {
    if (!reservationsOn() || reservations.length === 0) return { ok: true };
    const use = useAt(connectorId, idToken, groupIdToken, reservations, evseViews());
    if (!use.ok) return { ok: false };
    if (use.reservation === undefined) return { ok: true };
    endReservation(use.reservation.id, `used at EVSE ${connectorId}`);
    return { ok: true, reservationId: use.reservation.id };
  }

  // ---- Faults ---------------------------------------------------------------

  /**
   * Reports a fault, or its end, as NotifyEvent for the Problem variable of
   * the connector (or the station for connectorId 0): techCode is the
   * vendor error code, or the error code; techInfo the info. Sent when
   * online, queued with QueueAllMessages.
   */
  function notifyProblem(connectorId: number, fault: Fault | undefined): void {
    const component =
      connectorId === 0
        ? { name: 'ChargingStation' }
        : { name: 'Connector', evse: { id: connectorId, connectorId: 1 } };
    const payload: Ocpp21RequestOf<'NotifyEvent'> = {
      generatedAt: timestamp(),
      seqNo: 0,
      eventData: [
        {
          eventId: ++eventId,
          timestamp: timestamp(),
          trigger: 'Alerting',
          actualValue: String(fault !== undefined),
          eventNotificationType: 'HardWiredNotification',
          component,
          variable: { name: 'Problem' },
          ...(fault === undefined
            ? { cleared: true }
            : {
                techCode: (fault.vendorErrorCode ?? fault.errorCode).slice(0, 50),
                ...(fault.info !== undefined && { techInfo: fault.info.slice(0, 500) }),
              }),
        },
      ],
    };
    if (online()) void sendIfOnline('NotifyEvent', payload);
    else if (deviceModel.get('OCPPCommCtrlr', 'QueueAllMessages') === 'true') {
      void outbox.enqueue('NotifyEvent', payload);
    }
  }

  // ---- Transactions ---------------------------------------------------------

  /** The token authorized at each connector, until its session ends. */
  const authorizations = new Map<number, Authorization>();
  let authCache: AuthCache201 = { ...options.restore?.authCache };
  let localList: LocalList201 = options.restore?.localList ?? EMPTY_LOCAL_LIST_201;
  const features = options.features ?? ['Core'];
  /** EVConnectionTimeOut: an authorization waiting for the cable. */
  const connectTimers = new Map<number, TimerHandle>();
  const transactions = new Map<number, Transaction201>();
  let alignedTimer: TimerHandle | undefined;
  let alignedEndedTimer: TimerHandle | undefined;
  let alignedUpstreamTimer: TimerHandle | undefined;

  const dmValue = (component: string, variable: string) =>
    deviceModel.get(component, variable) ?? '';
  if (
    v21 &&
    features.includes('WebPayments') &&
    dmValue('WebPaymentsCtrlr', 'SharedSecret') === ''
  ) {
    // A random secret at first boot, for the CSMS to replace (C25, appendix).
    const secret = `${ids()}${ids()}`.replace(/[^0-9A-Za-z]/g, '');
    deviceModel.set('WebPaymentsCtrlr', 'SharedSecret', secret.padEnd(16, '0').slice(0, 64));
  }
  /** 2.1: an ISO 15118-20 EV's Display.* and EnergyRequest.* values (R-EV-4). */
  const vehicleOf = (connectorId: number) => {
    const ev = v21 ? energy.ev(connectorId) : undefined;
    return ev?.state.profile.communication === 'iso15118-20'
      ? vehicleReadings(ev.state, energy.meter(connectorId).offeredW)
      : undefined;
  };
  const sample = (connectorId: number, measurands: string, context: ReadingContextEnumType) => {
    const meter = energy.sync(connectorId);
    const vehicle = vehicleOf(connectorId);
    return sampleMeter201(meter, now(), measurands, context, {
      ...energy.extras(connectorId),
      ...(vehicle !== undefined && { vehicle }),
    });
  };

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
      transactions.get(connectorId)?.limitReached !== true &&
      transactions.get(connectorId)?.limitHit === undefined &&
      transactions.get(connectorId)?.resumeHold !== true &&
      !poweredDown &&
      !evsesDown.has(connectorId)
    );
  }

  function updatePower(connectorId: number): void {
    energy.setStationLimit(stationLimitW());
    energy.update(connectorId, mayCharge(connectorId), profileLimitW(connectorId));
  }

  // ---- Smart Charging (K) ---------------------------------------------------

  // TxProfiles belonged to transactions that a restart ends.
  let chargingProfiles: InstalledProfile201[] = (options.restore?.chargingProfiles ?? []).filter(
    (p) => p.profile.chargingProfilePurpose !== 'TxProfile',
  );
  let limitTimer: TimerHandle | undefined;
  const smartCharging = () => features.includes('SmartCharging');
  const txInfo = (connectorId: number) => {
    const tx = transactions.get(connectorId);
    return tx === undefined ? undefined : { startedAt: tx.startedAt };
  };

  function profileContext(): InstallContext201 {
    return {
      maxStackLevel: dmInt('SmartChargingCtrlr', 'ProfileStackLevel'),
      maxPeriods: dmInt('SmartChargingCtrlr', 'PeriodsPerSchedule'),
      maxInstalled: CHARGING_PROFILES_MAX,
      units: dmValue('SmartChargingCtrlr', 'RateUnit')
        .split(',')
        .filter((unit): unit is ChargingRateUnit => unit === 'A' || unit === 'W'),
      evseIds: connectors(station).map((c) => c.connectorId),
      transactionOn: (evseId) => transactions.get(evseId)?.id,
      now: now(),
      ...(v21 && {
        v21: {
          purposes: dmValue('SmartChargingCtrlr', 'SupportedAdditionalPurposes').split(','),
          dynamic: dmValue('SmartChargingCtrlr', 'SupportsDynamicProfiles') === 'true',
        },
      }),
    };
  }

  // ---- 2.1 smart charging: priority charging (K21, K22), Dynamic profiles (K28) --

  /** EVSEs whose transaction charges with the PriorityCharging profile. */
  const priorityEvses = new Set<number>();
  const hasPriorityProfile = (evseId: number) =>
    chargingProfiles.some(
      (p) =>
        p.profile.chargingProfilePurpose === 'PriorityCharging' &&
        (p.evseId === 0 || p.evseId === evseId),
    );

  /**
   * Switches priority charging on or off for an EVSE's transaction and tells
   * the CSMS (K21.FR.05, .08, K22.FR.02 to .05); queued while offline.
   */
  function setPriority(evseId: number, activate: boolean): void {
    const tx = transactions.get(evseId);
    if (tx === undefined || priorityEvses.has(evseId) === activate) return;
    if (activate) priorityEvses.add(evseId);
    else priorityEvses.delete(evseId);
    log(`EVSE ${evseId}: priority charging ${activate ? 'on' : 'off'}`);
    updateAllPowers();
    void outbox.enqueue('NotifyPriorityCharging', { transactionId: tx.id, activated: activate });
  }

  const pullTimers = new Map<number, TimerHandle>();
  /** When to ask again after a pull brought nothing; only an update renews a profile. */
  const retryPullAt = new Map<number, number>();

  /**
   * Fetches an update of each Dynamic profile every dynUpdateInterval
   * (K28.FR.10): due that long after its last update, and again an interval
   * later when none came.
   */
  function scheduleDynamicPulls(): void {
    for (const timer of pullTimers.values()) stopTimer(timer);
    pullTimers.clear();
    for (const { profile } of chargingProfiles) {
      const interval = profile.dynUpdateInterval ?? 0;
      if (profile.chargingProfileKind !== 'Dynamic' || interval <= 0) continue;
      const due = Math.max(
        now(),
        retryPullAt.get(profile.id) ?? 0,
        (Date.parse(profile.dynUpdateTime ?? '') || now()) + interval * 1000,
      );
      const { id } = profile;
      pullTimers.set(
        id,
        later(due - now(), () => {
          pullTimers.delete(id);
          // Nothing new (or offline): ask again an interval from now.
          const askLater = () => {
            retryPullAt.set(id, now() + interval * 1000);
            scheduleDynamicPulls();
          };
          const pending = sendIfOnline('PullDynamicScheduleUpdate', { chargingProfileId: id });
          if (pending === undefined) {
            askLater();
            return;
          }
          void pending.then((outcome) => {
            const update = outcome.ok ? outcome.payload : undefined;
            if (update?.status === 'Accepted' && update.scheduleUpdate !== undefined) {
              applyScheduleUpdate(id, update.scheduleUpdate);
            } else {
              askLater();
            }
          });
        }),
      );
    }
  }

  /** Applies an UpdateDynamicSchedule or a pulled update to a Dynamic profile (K28.FR.06, .08). */
  function applyScheduleUpdate(
    id: number,
    update: Ocpp21RequestOf<'UpdateDynamicSchedule'>['scheduleUpdate'],
  ): void {
    chargingProfiles = chargingProfiles.map((p) =>
      p.profile.id === id ? applyDynamicUpdate(p, update, now()) : p,
    );
    retryPullAt.delete(id);
    log(`Dynamic profile ${id} updated: ${JSON.stringify(update)}`);
    updateAllPowers();
    scheduleDynamicPulls();
  }

  /**
   * The Smart Charging limit on an EVSE now, in W: its TxProfile or
   * TxDefaultProfile, plus what local generation adds. Undefined without one.
   * The ChargingStationMaxProfile is the station's (stationLimitW), which the
   * EVSEs share by demand.
   */
  function profileLimitW(connectorId: number): number | undefined {
    if (chargingProfiles.length === 0) return undefined;
    const conversion = energy.conversion(connectorId);
    const { own, localGeneration } = limits201(
      chargingProfiles,
      connectorId,
      now(),
      txInfo(connectorId),
      priorityEvses,
    );
    let watts = own.limit === undefined ? undefined : toWatts(own.limit, conversion);
    // Local generation adds to a limit, never makes one (K08.FR.04, K04.FR.05).
    if (watts !== undefined && localGeneration.limit !== undefined) {
      watts += toWatts(localGeneration.limit, conversion);
    }
    return watts;
  }

  /** The ChargingStationMaxProfile's limit now, in W (amperes on a three-phase supply). */
  function stationLimitW(): number | undefined {
    if (chargingProfiles.length === 0) return undefined;
    const evseId = connectors(station)[0]?.connectorId ?? 1;
    const { station: total } = limits201(
      chargingProfiles,
      evseId,
      now(),
      txInfo(evseId),
      priorityEvses,
    );
    return total.limit === undefined
      ? undefined
      : toWatts(total.limit, { voltageV: 230, phases: 3 });
  }

  /** Re-evaluates every EVSE at the next moment a limit changes. */
  function scheduleLimitChange(): void {
    stopTimer(limitTimer);
    limitTimer = undefined;
    const at = now();
    const changes = connectors(station)
      .flatMap((c) => {
        const {
          own,
          station: total,
          localGeneration,
          staleAt,
        } = limits201(chargingProfiles, c.connectorId, at, txInfo(c.connectorId), priorityEvses);
        return [own.next, total.next, localGeneration.next, staleAt];
      })
      .filter((t): t is number => t !== undefined && t > at);
    if (changes.length === 0) return;
    limitTimer = later(Math.min(...changes) - at, () => {
      limitTimer = undefined;
      updateAllPowers();
    });
  }

  /** Applies the limits to every EVSE; a transaction reports a changed charging state. */
  function updateAllPowers(): void {
    for (const connector of connectors(station)) {
      if (transactions.has(connector.connectorId)) {
        evaluate(connector.connectorId, 'ChargingStateChanged');
      } else {
        updatePower(connector.connectorId);
      }
    }
    scheduleLimitChange();
    changed();
  }

  /** Installs the TxProfile of a remote start for its transaction (K05.FR.03). */
  function installTxProfile(connectorId: number, profile: ChargingProfile201): void {
    const tx = transactions.get(connectorId);
    if (tx === undefined) return;
    const result = installProfile201(
      chargingProfiles,
      connectorId,
      { ...profile, transactionId: tx.id },
      profileContext(),
    );
    if (result.status === 'Rejected') {
      log(`TxProfile ${profile.id} of the remote start not installed: ${result.reason}`);
      return;
    }
    chargingProfiles = result.profiles;
    updateAllPowers();
  }

  /** ReportChargingProfiles, one message per EVSE, `tbc` on all but the last (K09). */
  function reportProfiles(requestId: number, selected: readonly InstalledProfile201[]): void {
    const evses = [...new Set(selected.map((p) => p.evseId))].sort((a, b) => a - b);
    evses.forEach((evseId, index) => {
      const profiles = selected.filter((p) => p.evseId === evseId).map((p) => p.profile);
      void sendIfOnline('ReportChargingProfiles', {
        requestId,
        chargingLimitSource: 'CSO',
        evseId,
        chargingProfile: profiles as [ChargingProfile201, ...ChargingProfile201[]],
        ...(index < evses.length - 1 && { tbc: true }),
      });
    });
  }

  function currentChargingState(connectorId: number): ChargingStateEnumType {
    const connector = findConnector(station, connectorId);
    const ev = energy.ev(connectorId);
    return chargingState({
      plugged: connector?.plugged ?? false,
      authorized: authorizations.has(connectorId),
      evSuspended: connector?.evSuspended ?? false,
      // Not allowed to charge, or a charging profile of 0 (K01).
      evseSuspended:
        (!mayCharge(connectorId) ||
          (profileLimitW(connectorId) ?? Infinity) <= 0 ||
          (stationLimitW() ?? Infinity) <= 0) &&
        connector?.evSuspended !== true,
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
      /** 2.1: the limits, sent with LimitSet (E16.FR.01, .03). */
      transactionLimit?: TransactionLimit;
      /** Called with the CSMS's answer, or undefined when the event never got one. */
      onAnswer?: (response: Ocpp21ResponseOf<'TransactionEvent'> | undefined) => void;
    } = {},
  ): void {
    tx.chargingState = eventType === 'Ended' ? tx.chargingState : currentChargingState(connectorId);
    // The first event with the token tells the CSMS which reservation it used (H01.FR.15).
    const reservationId =
      extra.idToken !== undefined && !tx.reservationSent
        ? authorizations.get(connectorId)?.reservationId
        : undefined;
    if (reservationId !== undefined) tx.reservationSent = true;
    const meterValue = extra.meterValue?.filter((m) => m !== undefined) ?? [];
    const [firstValue, ...otherValues] = meterValue;
    // 2.1: the station's own cost: with Started and running-cost events, and in full at the end (I12.FR.01, .02).
    let costDetails: Ocpp21RequestOf<'TransactionEvent'>['costDetails'];
    if (tx.cost !== undefined) {
      tx.cost.advance(costSituation(connectorId, tx));
      const running = dmValue('TariffCostCtrlr', 'Enabled:RunningCost') === 'true';
      if (eventType === 'Ended') costDetails = tx.cost.details(true);
      else if (running && (eventType === 'Started' || triggerReason === 'RunningCost')) {
        costDetails = tx.cost.details(false);
      }
    }
    const tariffId = tx.tariffIdPending === true ? tx.cost?.tariffId : undefined;
    tx.tariffIdPending = false;
    // 2.1: the first event with a terminal payment's token sets maxCost to the amount the
    // terminal holds (C18.FR.06); a Started event carries the limits the transaction has
    // from the start (a web payment's, C25.FR.60).
    const payment = paymentOf(extra.idToken);
    const paymentLimit =
      payment !== undefined && payment.transactionId === undefined && eventType !== 'Ended';
    if (paymentLimit) {
      payment.transactionId = tx.id;
      tx.limits = { ...tx.limits, maxCost: payment.authorized };
    }
    const ownLimits = paymentLimit || (eventType === 'Started' && tx.limits !== undefined);
    const transactionLimit = extra.transactionLimit ?? (ownLimits ? tx.limits : undefined);
    const payload: Ocpp21RequestOf<'TransactionEvent'> = {
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
        ...(transactionLimit !== undefined && { transactionLimit }),
        ...(tariffId !== undefined && { tariffId }),
      },
      ...(costDetails !== undefined && { costDetails }),
      ...(!online() && { offline: true }),
      evse: { id: connectorId, connectorId: 1 },
      ...(extra.idToken !== undefined && { idToken: extra.idToken }),
      ...(firstValue !== undefined && { meterValue: [firstValue, ...otherValues] }),
      ...(reservationId !== undefined && { reservationId }),
    };
    void outbox.enqueue('TransactionEvent', payload, tx.id).then((outcome) => {
      const answer = outcome.ok
        ? (outcome.payload as Ocpp21ResponseOf<'TransactionEvent'>)
        : undefined;
      extra.onAnswer?.(answer);
      showAnswer(connectorId, eventType, answer);
      if (answer === undefined || eventType === 'Ended') return;
      const response = answer;
      if (v21 && transactions.get(connectorId) === tx) {
        if (response.totalCost !== undefined) {
          tx.csmsCost = response.totalCost;
          checkTxLimits(connectorId, tx);
        }
        // The CSMS sends a limit in an answer, the first one it can (E16.FR.02, F07).
        if (response.transactionLimit !== undefined) {
          applyLimits(connectorId, tx, response.transactionLimit);
        }
      }
      const info = response.idTokenInfo;
      if (info !== undefined && extra.idToken !== undefined) rememberAnswer(extra.idToken, info);
      if (info === undefined || info.status === 'Accepted') return;
      if (transactions.get(connectorId) !== tx) return;
      log(`connector ${connectorId}: the CSMS answered ${info.status} for the transaction's token`);
      invalidated(connectorId, tx);
    });
    if (ownLimits) later(0, () => checkTxLimits(connectorId, tx));
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

  // ---- Tariffs and local cost calculation (2.1, I07 to I12) -----------------

  let defaultTariffs: TariffEntry[] = [...(options.restore?.tariffs ?? [])];
  /** Driver tariffs from AuthorizeResponse, by token (I08). */
  const driverTariffs = new Map<string, Tariff21>();
  /** Tokens whose tariff failed with HandleFailedTariff CentralCost: no local cost (I08.FR.33). */
  const centralCostTokens = new Set<string>();
  const tariffOn = () =>
    v21 &&
    features.includes('TariffAndCost') &&
    dmValue('TariffCostCtrlr', 'Enabled:Tariff') === 'true';
  const costOn = () => tariffOn() && dmValue('TariffCostCtrlr', 'Enabled:Cost') === 'true';
  const tariffLimits = () => ({
    maxElements: dmInt('TariffCostCtrlr', 'MaxElements:Tariff'),
    conditionsSupported: dmValue('TariffCostCtrlr', 'ConditionsSupported:Tariff') === 'true',
  });
  const effectiveFrom = (e: TariffEntry) => Date.parse(e.tariff.validFrom ?? '') || e.installedAt;
  const bare = <T extends { customData?: unknown }>(value: T): Omit<T, 'customData'> => {
    const { customData: _dropped, ...rest } = value;
    return rest;
  };

  /** The default tariff of an EVSE now: the latest that is valid (I07.FR.19 to .23). */
  function activeDefault(evseId: number): Tariff21 | undefined {
    const valid = defaultTariffs
      .filter((e) => e.evseId === evseId && effectiveFrom(e) <= now())
      .sort((a, b) => effectiveFrom(a) - effectiveFrom(b) || a.installedAt - b.installedAt);
    return valid.at(-1)?.tariff;
  }

  function costSituation(connectorId: number, tx: Transaction201): TariffSituation {
    const reading = energy.sync(connectorId);
    return {
      at: now(),
      energyWh: reading.energyWh - tx.meterStartWh,
      powerW: reading.powerW,
      currentA: reading.powerW / 230,
      durationS: (now() - tx.startedAt) / 1000,
      chargingS: 0,
      idleS: 0,
      charging: reading.powerW > 0,
    };
  }

  /** The transaction is priced with its driver's tariff, else the EVSE's default (I07.FR.14, I08.FR.04). */
  function startCost(
    connectorId: number,
    tx: Transaction201,
    idToken: IdTokenType | undefined,
  ): void {
    if (!costOn()) return;
    const key = idToken === undefined ? undefined : tokenKey(idToken);
    if (key !== undefined && centralCostTokens.has(key)) return;
    const tariff =
      (key === undefined ? undefined : driverTariffs.get(key)) ?? activeDefault(connectorId);
    if (tariff === undefined) return;
    // An ad hoc payment's brand picks its fixed fee (C18).
    const card = paymentOf(idToken)?.card;
    const payment = card === undefined ? undefined : withCardDefaults(card);
    tx.cost = createCostMeter({
      tariff,
      place: {
        timeZone: dmValue('ClockCtrlr', 'TimeZone'),
        evseKind: 'AC',
        ...(payment !== undefined && {
          payment: { brand: payment.brand, recognition: payment.recognition },
        }),
      },
      start: costSituation(connectorId, tx),
    });
    // The driver accepts implicitly by plugging in; the tariff goes with the next event (I07.FR.31).
    tx.tariffIdPending = true;
    scheduleCost(connectorId, tx);
  }

  /**
   * Prices the transaction every Interval[Tariff] seconds (10 when 0: as often
   * as is useful), at each calendar change of its tariff, and reports the
   * running cost every Interval[Cost] seconds (I12.FR.02, .31, .32).
   */
  function scheduleCost(connectorId: number, tx: Transaction201): void {
    stopTimer(tx.costTimer);
    tx.costTimer = undefined;
    if (tx.cost === undefined || transactions.get(connectorId) !== tx) return;
    const tickMs = Math.max(1, dmInt('TariffCostCtrlr', 'Interval:Tariff') || 10) * 1000;
    const boundary = tx.cost.nextChange();
    const wait = Math.min(tickMs, boundary === undefined ? Infinity : boundary - now());
    tx.costTimer = later(Math.max(1, wait), () => {
      tx.cost?.advance(costSituation(connectorId, tx));
      checkTxLimits(connectorId, tx);
      scheduleCost(connectorId, tx);
    });
    if (
      tx.costReportTimer === undefined &&
      dmValue('TariffCostCtrlr', 'Enabled:RunningCost') === 'true'
    ) {
      const everyMs = Math.max(1, dmInt('TariffCostCtrlr', 'Interval:Cost')) * 1000;
      const report = () => {
        tx.costReportTimer = later(everyMs, () => {
          if (transactions.get(connectorId) !== tx) return;
          sendEvent(connectorId, tx, 'Updated', 'RunningCost');
          report();
        });
      };
      report();
    }
  }

  /** TariffCostCtrlr.Problem, raised or cleared, and reported (I08.FR.30, .35 to .37). */
  function tariffProblem(raised: boolean, techCode?: string): void {
    if ((dmValue('TariffCostCtrlr', 'Problem') === 'true') === raised) return;
    deviceModel.set('TariffCostCtrlr', 'Problem', String(raised));
    void sendIfOnline('NotifyEvent', {
      generatedAt: timestamp(),
      seqNo: 0,
      eventData: [
        {
          eventId: ++eventId,
          timestamp: timestamp(),
          trigger: 'Alerting',
          actualValue: String(raised),
          eventNotificationType: 'HardWiredNotification',
          component: { name: 'TariffCostCtrlr' },
          variable: { name: 'Problem' },
          ...(raised ? { techCode: techCode ?? 'UnsupportedParam' } : { cleared: true }),
        },
      ],
    });
  }

  /**
   * A driver tariff from AuthorizeResponse (I08): kept for the token, or, when
   * the station cannot use it, Problem and HandleFailedTariff: Deauthorize (the
   * token is refused), UseDefaultTariff, or CentralCost (no local cost).
   */
  function takeDriverTariff(idToken: IdTokenType, tariff: Tariff21): boolean {
    const key = tokenKey(idToken);
    const check = checkTariff(tariff, tariffLimits());
    if (check.status === 'Accepted') {
      driverTariffs.set(key, tariff);
      centralCostTokens.delete(key);
      tariffProblem(false);
      return true;
    }
    log(`driver tariff ${tariff.tariffId} not usable: ${check.reason}`);
    tariffProblem(
      true,
      check.status === 'TooManyElements' ? 'TooManyElements' : 'UnsupportedParam',
    );
    const action = dmValue('TariffCostCtrlr', 'HandleFailedTariff:Tariff');
    if (action === 'Deauthorize') return false;
    if (action === 'CentralCost') centralCostTokens.add(key);
    return true;
  }

  // ---- Virtual display (2.1, I01 to I06) -----------------------------------

  /** What each EVSE's display shows: the latest tariff or cost message. */
  const displays = new Map<number, DisplayMessage>();
  function show(evseId: number, kind: DisplayMessage['kind'], text: string): void {
    if (!v21 || text === '') return;
    displays.set(evseId, { at: timestamp(), kind, text });
    log(`EVSE ${evseId} display: ${text}`);
    changed();
  }
  /** A cost as the display shows it: two decimals and the station's currency. */
  const money = (amount: number) =>
    `${amount.toFixed(2)}${dmValue('TariffCostCtrlr', 'Currency') === '' ? '' : ` ${dmValue('TariffCostCtrlr', 'Currency')}`}`;
  /** I01, I04: the driver's tariff text with an accepted token, else the fallback message. */
  function showTariff(evseId: number, info: TokenInfo | undefined): void {
    const message = info?.personalMessage?.content;
    if (message !== undefined && message !== '') show(evseId, 'tariff', message);
    else show(evseId, 'fallback', dmValue('TariffCostCtrlr', 'TariffFallbackMessage'));
  }
  /**
   * I02, I03, I05, I06: a TransactionEventResponse's running or total cost and
   * updated personal message; the total cost fallback when the Ended event got
   * no answer.
   */
  function showAnswer(
    evseId: number,
    eventType: TransactionEventEnumType,
    answer: Ocpp21ResponseOf<'TransactionEvent'> | undefined,
  ): void {
    if (answer === undefined) {
      if (eventType === 'Ended') {
        show(evseId, 'fallback', dmValue('TariffCostCtrlr', 'TotalCostFallbackMessage'));
      }
      return;
    }
    if (answer.totalCost !== undefined) {
      show(
        evseId,
        eventType === 'Ended' ? 'totalCost' : 'runningCost',
        `${eventType === 'Ended' ? 'Total' : 'So far'} ${money(answer.totalCost)}`,
      );
    }
    const personal = answer.updatedPersonalMessage?.content;
    if (personal !== undefined) show(evseId, 'personal', personal);
  }

  // ---- Ad hoc payment (2.1, C18 to C25) ------------------------------------

  /** Cards the payment terminal holds, by PspRef, until their settlement. */
  const payments = new Map<string, TerminalPayment>(
    (options.restore?.payments ?? []).map((p) => [p.idToken.idToken, { ...p }]),
  );
  /** EVSEs (0: all) where a web payment is under way: no local starts (C25.FR.22). */
  const webHolds = new Map<number, TimerHandle>();
  /** Limits a driver put in a payment URL, for the web payment's transaction (C25.FR.60). */
  const webLimits = new Map<number, TransactionLimit>();
  const paymentOn = () =>
    v21 && features.includes('Payment') && dmValue('PaymentCtrlr', 'Enabled') === 'true';
  const dmDecimal = (component: string, variable: string) => {
    const text = deviceModel.get(component, variable);
    const value = Number(text);
    return text === undefined || text === '' || !Number.isFinite(value) ? undefined : value;
  };
  /** The terminal payment a token stands for. */
  const paymentOf = (idToken: IdTokenType | undefined) =>
    idToken?.type === 'DirectPayment' ? payments.get(idToken.idToken) : undefined;
  const roundCents = (value: number) => Math.round(value * 100) / 100;
  const webHeld = (evseId: number) => webHolds.has(evseId) || webHolds.has(0);
  /** The id in a payment URL: SecurityCtrlr.Identity (C25.FR.51), else the station's id. */
  const stationIdentity = () =>
    dmValue('SecurityCtrlr', 'Identity') ||
    options.serialNumber ||
    options.boot.serialNumber ||
    'station';

  /**
   * A card at an EVSE's terminal (C18): the PSP holds AuthorizationAmount and
   * gives a PspRef, the station's DirectPayment idToken with the details
   * PaymentDetails names. The CSMS authorizes it when AuthorizeDirectPayment
   * is true (C18.FR.04), the station itself otherwise (C18.FR.03).
   */
  async function presentPaymentCard(
    evseId: number,
    card: TerminalCard,
  ): Promise<PaymentCardResult> {
    if (!v21 || !features.includes('Payment')) return 'not-supported';
    const connector = findConnector(station, evseId);
    if (connector === undefined) return 'unknown-connector';
    if (!paymentOn()) return 'not-supported';
    const busy = () =>
      authorizations.has(evseId) ||
      transactions.get(evseId)?.idToken !== undefined ||
      webHeld(evseId);
    if (busy()) return 'busy';
    if (card.decline === true) {
      log(`EVSE ${evseId}: the payment service provider declined the card`);
      return 'declined';
    }
    const pspRef = `psp-${ids()}`;
    const details = dmValue('PaymentCtrlr', 'PaymentDetails')
      .split(',')
      .filter((d) => d !== '');
    const additionalInfo = paymentInfo(card, details);
    const idToken: IdTokenType = {
      idToken: pspRef,
      type: 'DirectPayment',
      ...(additionalInfo.length > 0 && { additionalInfo }),
    };
    const payment: TerminalPayment = {
      evseId,
      idToken,
      card,
      authorized: dmDecimal('PaymentCtrlr', 'AuthorizationAmount') ?? 0,
    };
    log(`EVSE ${evseId}: the terminal holds ${payment.authorized} with ${pspRef}`);
    let info: TokenInfo = { status: 'Accepted' };
    if (dmValue('PaymentCtrlr', 'AuthorizeDirectPayment') === 'true') {
      const outcome = await sendIfOnline('Authorize', { idToken });
      const answer = outcome?.ok === true ? outcome.payload : undefined;
      let ok = answer?.idTokenInfo.status === 'Accepted';
      if (answer !== undefined) {
        info = bare(answer.idTokenInfo);
        // A tariff of the CSMS's prices the payment (C18 alternative scenario).
        if (ok && answer.tariff !== undefined && tariffOn()) {
          ok = takeDriverTariff(idToken, bare(answer.tariff));
        }
      }
      if (!ok) {
        // The terminal releases the amount and cancels the payment (C18.FR.07).
        log(`EVSE ${evseId}: the CSMS refused ${pspRef}; the terminal releases it`);
        hint({
          kind: 'start-failed',
          evseId,
          idToken: tokenRef(idToken),
          source: 'payment',
          reason: 'NotAuthorized',
          ...(answer !== undefined && { detail: answer.idTokenInfo.status }),
        });
        return 'rejected';
      }
    }
    payments.set(pspRef, payment);
    if (busy()) {
      log(`EVSE ${evseId}: in use meanwhile; the terminal releases ${pspRef}`);
      cancelPayment(payment);
      return 'busy';
    }
    authorizations.set(evseId, { idToken, info });
    hint({ kind: 'authorized', evseId, idToken: tokenRef(idToken), source: 'payment' });
    if (!connector.plugged) awaitCable(evseId);
    evaluate(evseId, 'Authorized', idToken);
    changed();
    return 'authorized';
  }

  /**
   * The terminal releases a card no transaction used (C19.FR.01); the CSMS
   * hears of it when it authorized the card (C19.FR.02).
   */
  function cancelPayment(payment: TerminalPayment): void {
    payments.delete(payment.idToken.idToken);
    log(`EVSE ${payment.evseId}: payment ${payment.idToken.idToken} canceled and released`);
    if (dmValue('PaymentCtrlr', 'AuthorizeDirectPayment') === 'true') {
      void notifySettlement({
        pspRef: payment.idToken.idToken,
        status: 'Canceled',
        settlementAmount: 0,
        settlementTime: timestamp(),
      });
    }
    changed();
  }

  function stopPayment(evseId: number): PaymentStopResult {
    if (findConnector(station, evseId) === undefined) return 'unknown-connector';
    const tx = transactions.get(evseId);
    const payment = paymentOf(tx?.idToken ?? authorizations.get(evseId)?.idToken);
    if (payment === undefined) return 'no-payment';
    if (tx === undefined) {
      authorizations.delete(evseId);
      stopTimer(connectTimers.get(evseId));
      connectTimers.delete(evseId);
      hint({
        kind: 'start-failed',
        evseId,
        idToken: tokenRef(payment.idToken),
        source: 'payment',
        reason: 'StartFailed',
        detail: 'canceled at the payment terminal',
      });
      cancelPayment(payment);
      evaluate(evseId, 'StopAuthorized');
      return 'canceled';
    }
    // After the start the transaction ends with StopAuthorized (C20.FR.01); its end settles.
    deauthorize(evseId, 'StopAuthorized', 'Local', payment.idToken);
    return 'stopping';
  }

  /**
   * The end of a transaction a card paid for (C20 to C22): nothing spent is
   * released and canceled; otherwise the terminal settles the final cost (the
   * station's own, else the CSMS's) unless the CSMS settles (SettlementByCSMS),
   * and NotifySettlement reports the outcome.
   */
  function settlePayment(
    payment: TerminalPayment,
    transactionId: string,
    response: Ocpp21ResponseOf<'TransactionEvent'> | undefined,
    known: { own?: number | undefined; csms?: number | undefined } = {},
  ): void {
    payments.delete(payment.idToken.idToken);
    const cost = roundCents(
      known.own ?? response?.totalCost ?? known.csms ?? payment.lastCost ?? 0,
    );
    const pspRef = payment.idToken.idToken;
    const base = { transactionId, pspRef, settlementTime: timestamp() };
    changed();
    if (cost <= 0) {
      log(`transaction ${transactionId}: nothing to pay; ${pspRef} released (C20)`);
      void notifySettlement({ ...base, status: 'Canceled', settlementAmount: 0 });
      return;
    }
    if (dmValue('PaymentCtrlr', 'SettlementByCSMS') === 'true') {
      log(`transaction ${transactionId}: the CSMS settles ${cost} with ${pspRef} (C21.FR.05)`);
      return;
    }
    const status = payment.card.settlement ?? 'Settled';
    log(`transaction ${transactionId}: the terminal settles ${cost} with ${pspRef}: ${status}`);
    const receiptId = `R-${transactionId}`.slice(0, 50);
    const server = dmValue('PaymentCtrlr', 'ReceiptServerUrl').replace(/\/+$/, '');
    // The terminal's receipt, unless the CSMS gives it (C21.FR.03, .04); none when it failed (C22).
    const receipt = status === 'Settled' && dmValue('PaymentCtrlr', 'ReceiptByCSMS') !== 'true';
    void notifySettlement({
      ...base,
      status,
      settlementAmount: cost,
      ...(status === 'Rejected' && {
        statusInfo: 'The payment service provider rejected the settlement',
      }),
      ...(status === 'Failed' && {
        statusInfo: 'The payment terminal could not reach the payment service provider',
      }),
      ...(receipt && {
        receiptId,
        ...(server !== '' && { receiptUrl: `${server}/${encodeURIComponent(receiptId)}` }),
      }),
      ...(payment.vat !== undefined && {
        vatNumber: payment.vat.number,
        ...(payment.vat.company !== undefined && { vatCompany: payment.vat.company }),
      }),
    }).then((outcome) => {
      if (outcome.ok && outcome.payload.receiptUrl !== undefined) {
        log(`transaction ${transactionId}: receipt at ${outcome.payload.receiptUrl}`);
      }
    });
  }

  /**
   * C23: the cost nears the amount the terminal holds, so it asks the PSP for
   * IncrementalAuthorizationAmount more and the CSMS hears the new maxCost
   * (LimitSet).
   */
  function raiseAuthorization(connectorId: number, tx: Transaction201): void {
    const payment = paymentOf(tx.idToken);
    const step = dmDecimal('PaymentCtrlr', 'IncrementalAuthorizationAmount') ?? 0;
    const cost = costOf(tx);
    if (payment === undefined || payment.noIncrement === true || step <= 0) return;
    const threshold = dmDecimal('PaymentCtrlr', 'IncrementalAuthorizationThreshold') ?? 0;
    if (cost === undefined || cost <= payment.authorized - threshold) return;
    if (payment.card.declineIncrement === true) {
      payment.noIncrement = true;
      log(`transaction ${tx.id}: the PSP would not raise ${payment.authorized}`);
      return;
    }
    payment.authorized = roundCents(payment.authorized + step);
    log(`transaction ${tx.id}: the terminal now holds ${payment.authorized}`);
    tx.limits = { ...tx.limits, maxCost: payment.authorized };
    sendEvent(connectorId, tx, 'Updated', 'LimitSet', { transactionLimit: tx.limits });
  }

  async function validateVatNumber(
    evseId: number | undefined,
    vatNumber: string,
  ): Promise<VatResult> {
    if (!v21 || !features.includes('Payment')) return { status: 'not-supported' };
    const outcome = await sendIfOnline('VatNumberValidation', {
      vatNumber,
      ...(evseId !== undefined && { evseId }),
    });
    if (outcome === undefined || !outcome.ok) return { status: 'no-answer' };
    const { status } = outcome.payload;
    const company =
      outcome.payload.company === undefined ? undefined : bare(outcome.payload.company);
    log(`VAT number ${vatNumber}: ${status}`);
    if (status === 'Accepted' && evseId !== undefined) {
      // It goes on the receipt of the EVSE's payment (C21.FR.02).
      const held = paymentOf(
        transactions.get(evseId)?.idToken ?? authorizations.get(evseId)?.idToken,
      );
      if (held !== undefined) {
        held.vat = { number: vatNumber, ...(company !== undefined && { company }) };
        changed();
      }
    }
    return { status, ...(company !== undefined && { company }) };
  }

  /**
   * The dynamic QR code's URL (C25): URLTemplate with the station's id, the
   * EVSE, the TOTP and its version, and the limits the driver chose that
   * URLParameters lists. The station applies those limits itself to the
   * transaction the web payment starts (C25.FR.60).
   */
  function paymentUrl(evseId: number, limits: WebPaymentLimits): WebPaymentUrlResult {
    if (!v21 || !features.includes('WebPayments')) return { error: 'not-supported' };
    if (findConnector(station, evseId) === undefined) return { error: 'unknown-connector' };
    if (dmValue('WebPaymentsCtrlr', 'Enabled') !== 'true') return { error: 'disabled' };
    const hmac = options.hmacSha256;
    if (hmac === undefined) return { error: 'no-hmac' };
    const validityS = Math.max(1, dmInt('WebPaymentsCtrlr', 'ValidityTime'));
    const totp = totpV1(
      {
        sharedSecret: dmValue('WebPaymentsCtrlr', 'SharedSecret'),
        validityS,
        length: dmInt('WebPaymentsCtrlr', 'Length'),
      },
      now(),
      hmac,
    );
    const supported = dmValue('WebPaymentsCtrlr', 'URLParameters')
      .split(',')
      .filter((p) => p !== '');
    // The EVSE's own WebPaymentsCtrlr: its roaming EVSE id (C25.FR.53).
    const roamingEvseId = deviceModel.get(`WebPaymentsCtrlr@${evseId}`, 'RoamingEvseId') ?? '';
    const url = paymentUrlOf(
      dmValue('WebPaymentsCtrlr', 'URLTemplate'),
      {
        chargingStationId: stationIdentity(),
        evseId,
        totp,
        version: dmValue('WebPaymentsCtrlr', 'TOTPVersion') || 'v1',
        ...(roamingEvseId !== '' && { roamingEvseId }),
      },
      limits,
      supported,
    );
    const kept: TransactionLimit = {};
    if (limits.maxEnergy !== undefined && supported.includes('maxenergy'))
      kept.maxEnergy = limits.maxEnergy;
    if (limits.maxTime !== undefined && supported.includes('maxtime'))
      kept.maxTime = limits.maxTime;
    if (limits.maxCost !== undefined && supported.includes('maxcost'))
      kept.maxCost = limits.maxCost;
    if (Object.keys(kept).length > 0) webLimits.set(evseId, kept);
    else webLimits.delete(evseId);
    const validUntil = (totpInterval(now(), validityS) + 1) * validityS * 1000;
    return { url, totp, validUntil: new Date(validUntil).toISOString() };
  }

  /** NotifyWebPaymentStarted: local starts wait `timeoutS` (C25.FR.22). */
  function holdForWebPayment(evseId: number, timeoutS: number): void {
    stopTimer(webHolds.get(evseId));
    webHolds.set(
      evseId,
      later(Math.max(0, timeoutS) * 1000, () => {
        webHolds.delete(evseId);
        log(`EVSE ${evseId}: the web payment's wait is over`);
        changed();
      }),
    );
    changed();
  }

  function releaseWebHold(evseId: number): void {
    for (const id of [evseId, 0]) {
      stopTimer(webHolds.get(id));
      webHolds.delete(id);
    }
  }

  // ---- Transaction limits (2.1, E16) ---------------------------------------

  /**
   * Takes the CSMS's limits: the supported ones (TxCtrlr.SupportedLimits)
   * replace the transaction's and are echoed once with LimitSet (E16.FR.03,
   * .13). A raised limit lets the energy flow again (E16.FR.14).
   */
  function applyLimits(connectorId: number, tx: Transaction201, limit: TransactionLimit): void {
    const supported = dmValue('TxCtrlr', 'SupportedLimits').split(',');
    const accepted = Object.fromEntries(
      LIMIT_NAMES.filter((name) => supported.includes(name) && limit[name] !== undefined).map(
        (name) => [name, limit[name]],
      ),
    ) as TransactionLimit;
    if (Object.keys(accepted).length === 0) {
      log(`connector ${connectorId}: no supported limit in ${JSON.stringify(limit)}`);
      return;
    }
    tx.limits = { ...tx.limits, ...accepted };
    sendEvent(connectorId, tx, 'Updated', 'LimitSet', { transactionLimit: tx.limits });
    if (tx.limitHit !== undefined && reachedLimit(connectorId, tx) === undefined) {
      tx.limitHit = undefined;
      updatePower(connectorId);
      log(`connector ${connectorId}: the limit was raised; charging resumes`);
    }
    checkTxLimits(connectorId, tx);
  }

  /** The cost a maxCost limit is measured with: the station's own when it has a tariff (E16.FR.16). */
  const costOf = (tx: Transaction201) => tx.cost?.totalInclTax() ?? tx.csmsCost;

  /** The first limit the transaction has reached, if any. */
  function reachedLimit(connectorId: number, tx: Transaction201): LimitName | undefined {
    const { limits } = tx;
    if (limits === undefined) return undefined;
    const reading = energy.sync(connectorId);
    const soc = energy.ev(connectorId)?.state.soc;
    const reached: Record<LimitName, boolean> = {
      maxCost: limits.maxCost !== undefined && (costOf(tx) ?? -Infinity) >= limits.maxCost,
      maxEnergy:
        limits.maxEnergy !== undefined && reading.energyWh - tx.meterStartWh >= limits.maxEnergy,
      maxSoC: limits.maxSoC !== undefined && soc !== undefined && soc >= limits.maxSoC,
      maxTime: limits.maxTime !== undefined && now() - tx.startedAt >= limits.maxTime * 1000,
    };
    return LIMIT_NAMES.find((name) => reached[name]);
  }

  /**
   * Stops the energy transfer once a limit is reached (E16.FR.05), or ends
   * the transaction when TxStopPoint has EnergyTransfer (E16.FR.06; the
   * reasons that named limits are deprecated in 2.1, so it ends as Local).
   * Otherwise it looks again when a limit could be reached: at the time
   * limit, at the energy limit at the present power, and every second for
   * SoC and cost.
   */
  function checkTxLimits(connectorId: number, tx: Transaction201): void {
    stopTimer(tx.transactionLimitTimer);
    tx.transactionLimitTimer = undefined;
    if (tx.limits === undefined || tx.limitHit !== undefined) return;
    if (transactions.get(connectorId) !== tx) return;
    raiseAuthorization(connectorId, tx);
    const hit = reachedLimit(connectorId, tx);
    if (hit !== undefined) {
      tx.limitHit = hit;
      log(`connector ${connectorId}: ${hit} ${String(tx.limits[hit])} reached`);
      if (dmValue('TxCtrlr', 'TxStopPoint').split(',').includes('EnergyTransfer')) {
        endTransaction(connectorId, LIMIT_TRIGGERS[hit], 'Local');
      } else {
        updatePower(connectorId);
        sendEvent(connectorId, tx, 'Updated', LIMIT_TRIGGERS[hit]);
      }
      return;
    }
    const { maxTime, maxEnergy, maxSoC, maxCost } = tx.limits;
    const waits: number[] = [];
    if (maxTime !== undefined) waits.push(tx.startedAt + maxTime * 1000 - now());
    if (maxEnergy !== undefined) {
      const reading = energy.sync(connectorId);
      const left = maxEnergy - (reading.energyWh - tx.meterStartWh);
      if (reading.powerW > 0) waits.push(((left / reading.powerW) * 3_600_000) / energy.multiplier);
      else waits.push(LIMIT_POLL_MS);
    }
    if (maxSoC !== undefined || maxCost !== undefined) waits.push(LIMIT_POLL_MS);
    // Power changes on its own (taper, profiles); look again at least every few seconds.
    const wait = Math.min(...waits, 5 * LIMIT_POLL_MS);
    tx.transactionLimitTimer = later(Math.max(1, Math.ceil(wait)), () =>
      checkTxLimits(connectorId, tx),
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
    scheduleUpstream(connectorId, tx);
  }

  /** 2.1: the upstream meter's reading for an EVSE's transaction, when measurands are set. */
  const upstreamOf = (connectorId: number, context: ReadingContextEnumType) =>
    v21
      ? sampleUpstream(
          [energy.sync(connectorId)],
          now(),
          dmValue('SampledDataCtrlr', 'UpstreamMeasurands'),
          context,
        )
      : undefined;

  /** 2.1: TransactionEvent Updated with the upstream meter every UpstreamInterval (J, 2.1). */
  function scheduleUpstream(connectorId: number, tx: Transaction201): void {
    stopTimer(tx.upstreamTimer);
    tx.upstreamTimer = undefined;
    if (!v21) return;
    const due = nextPeriodicSample(
      tx.startedAt,
      dmInt('SampledDataCtrlr', 'UpstreamInterval'),
      now(),
    );
    if (due === undefined) return;
    tx.upstreamTimer = later(due - now(), () => {
      if (transactions.get(connectorId) !== tx) return;
      const value = upstreamOf(connectorId, 'Sample.Periodic');
      if (value !== undefined) {
        sendEvent(connectorId, tx, 'Updated', 'MeterValuePeriodic', { meterValue: [value] });
      }
      scheduleUpstream(connectorId, tx);
    });
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
    // 2.1: the upstream meter of the whole station, clock-aligned, in MeterValues on EVSE 0.
    stopTimer(alignedUpstreamTimer);
    alignedUpstreamTimer = undefined;
    const upstreamDue = v21
      ? nextAlignedSample(dmInt('AlignedDataCtrlr', 'UpstreamInterval'), now())
      : undefined;
    if (upstreamDue !== undefined) {
      alignedUpstreamTimer = later(upstreamDue - now(), () => {
        const value = sampleUpstream(
          connectors(station).map((c) => energy.sync(c.connectorId)),
          now(),
          dmValue('AlignedDataCtrlr', 'UpstreamMeasurands'),
          'Sample.Clock',
        );
        if (value !== undefined)
          void sendIfOnline('MeterValues', { evseId: 0, meterValue: [value] });
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
      ...(auth?.limits !== undefined && { limits: { ...auth.limits } }),
      chargingState: currentChargingState(connectorId),
      endedValues: [],
    };
    transactions.set(connectorId, tx);
    applyDevice({ type: 'TransactionStarted', connectorId, transactionId: 1 });
    updateLock(connectorId);
    if (auth?.txProfile !== undefined) installTxProfile(connectorId, auth.txProfile);
    startCost(connectorId, tx, auth?.idToken);
    const value = sample(
      connectorId,
      dmValue('SampledDataCtrlr', 'TxStartedMeasurands'),
      'Transaction.Begin',
    );
    // 2.1: with upstream sampling on, Started carries the upstream reading too (J, 2.1).
    const upstream =
      dmInt('SampledDataCtrlr', 'UpstreamInterval') > 0
        ? upstreamOf(connectorId, 'Transaction.Begin')
        : undefined;
    const startValues = [value, upstream].filter((v) => v !== undefined);
    sendEvent(
      connectorId,
      tx,
      'Started',
      auth?.remoteStartId !== undefined && trigger === 'Authorized' ? 'RemoteStart' : trigger,
      {
        ...(auth !== undefined && { idToken: auth.idToken }),
        ...(startValues.length > 0 && { meterValue: startValues }),
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
    for (const timer of [
      tx.periodicTimer,
      tx.endedTimer,
      tx.limitTimer,
      tx.transactionLimitTimer,
      tx.costTimer,
      tx.costReportTimer,
      tx.upstreamTimer,
    ]) {
      stopTimer(timer);
    }
    // A driver tariff lasts as long as its transaction (I08.FR.06, .07).
    if (tx.idToken !== undefined) {
      const key = tokenKey(tx.idToken);
      const elsewhere = [...transactions.values()].some(
        (other) => other.idToken !== undefined && tokenKey(other.idToken) === key,
      );
      if (!elsewhere) {
        driverTariffs.delete(key);
        centralCostTokens.delete(key);
      }
    }
    const hadTxProfile = chargingProfiles.some(
      (p) => p.evseId === connectorId && p.profile.chargingProfilePurpose === 'TxProfile',
    );
    chargingProfiles = endTransactionProfiles201(chargingProfiles, connectorId);
    // Priority charging lasts as long as the transaction (K21).
    priorityEvses.delete(connectorId);
    if (hadTxProfile) scheduleLimitChange();
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
    // A card paid for it: the terminal settles its own cost at once, queued after the end; without
    // one, once the CSMS has the end and answers with its cost (C20, C21).
    const payment = paymentOf(tx.idToken);
    const ownCost = () => {
      const own = tx.cost?.details(true).totalCost.total;
      return own?.inclTax ?? own?.exclTax;
    };
    const settleOnAnswer = payment !== undefined && tx.cost === undefined;
    sendEvent(connectorId, tx, 'Ended', trigger, {
      stoppedReason: tx.stoppedReason ?? stoppedReason,
      ...(idToken !== undefined && { idToken }),
      meterValue: [...tx.endedValues, ...(final === undefined ? [] : [final])],
      ...(settleOnAnswer && {
        onAnswer: (response) =>
          settlePayment(payment, tx.id, response, { own: ownCost(), csms: tx.csmsCost }),
      }),
    });
    if (payment !== undefined && !settleOnAnswer) {
      settlePayment(payment, tx.id, undefined, { own: ownCost(), csms: tx.csmsCost });
    }
    applyDevice({ type: 'TransactionEnded', connectorId });
    updateLock(connectorId);
    changed();
    if (scheduledReset !== undefined) later(0, runScheduledReset);
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
    evaluateTransaction(connectorId, trigger, idToken);
    const connector = findConnector(station, connectorId);
    if (connector !== undefined) {
      reportChargingNeeds(connectorId, {
        evConnected: connector.plugged,
        authorized: authorizations.has(connectorId),
      });
    }
  }

  function evaluateTransaction(
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

  /**
   * An ISO 15118 EV tells its charging needs once per session, when it is
   * plugged in and authorized (the station then sends NotifyEVChargingNeeds).
   */
  function reportChargingNeeds(
    connectorId: number,
    conditions: { evConnected: boolean; authorized: boolean },
  ): void {
    const pluggedAt = needsDue.get(connectorId);
    if (pluggedAt === undefined || !conditions.evConnected || !conditions.authorized) return;
    const ev = energy.ev(connectorId);
    if (ev === undefined || !speaksIso15118(ev.state.profile)) return;
    needsDue.delete(connectorId);
    sendChargingNeeds(connectorId, pluggedAt);
  }

  /**
   * NotifyEVChargingNeeds with what the EV says now. An ISO 15118-20 EV on a
   * 2.1 station gives -20's needs (K18.FR.06); offline they wait, stamped with
   * when the EV gave them (K18.FR.21, K20.FR.05). Its CSMS may refuse the
   * transfer, which ends the transaction (K18.FR.23).
   */
  function sendChargingNeeds(connectorId: number, pluggedAt: number): void {
    const ev = energy.ev(connectorId);
    if (ev === undefined) return;
    const twenty = v21 && ev.state.profile.communication === 'iso15118-20';
    const connectorType = deviceModel.get(`Connector@${connectorId}.1`, 'ConnectorType');
    const input = {
      profile: ev.state.profile,
      soc: ev.state.soc,
      ...(connectorType !== undefined && { connectorType }),
      pluggedAt,
      energyMultiplier: energy.multiplier,
    };
    const request = {
      evseId: connectorId,
      chargingNeeds: twenty ? chargingNeeds21(input) : chargingNeeds(input),
    };
    if (!twenty) {
      void sendIfOnline('NotifyEVChargingNeeds', request)?.then((outcome) => {
        if (outcome.ok) log(`NotifyEVChargingNeeds: ${String(outcome.payload.status)}`);
      });
      return;
    }
    needsWaiting.set(connectorId, { ...request, timestamp: timestamp() });
    if (online()) sendWaitingNeeds(connectorId);
  }

  /** Sends an ISO 15118-20 EV's waiting needs; the timestamp only when they waited. */
  function sendWaitingNeeds(connectorId: number): void {
    const waiting = needsWaiting.get(connectorId);
    if (waiting === undefined) return;
    needsWaiting.delete(connectorId);
    const { timestamp: at, ...request } = waiting;
    const late = now() - Date.parse(at) >= 1000;
    void sendIfOnline('NotifyEVChargingNeeds', {
      ...request,
      ...(late && { timestamp: at }),
    })?.then((outcome) => {
      if (!outcome.ok) return;
      const { status } = outcome.payload;
      log(`NotifyEVChargingNeeds: ${status}`);
      if (status === 'NoChargingProfile') {
        // No profile is coming: the composite schedule applies (K18.FR.15, K19.FR.11).
        log(`EVSE ${connectorId}: no charging profile; charging within the composite schedule`);
      }
      if (status === 'Rejected' && transactions.has(connectorId)) {
        log(`EVSE ${connectorId}: the CSMS refused the energy transfer`);
        endTransaction(connectorId, 'AbnormalCondition', 'ReqEnergyTransferRejected');
      }
    });
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

  type TokenInfo = Omit<IdTokenInfoType, 'customData'>;

  /** Keeps the CSMS's answer for a token in the cache, when the cache is on (C10). */
  function rememberAnswer(idToken: IdTokenType, info: IdTokenInfoType): void {
    if (dmValue('AuthCacheCtrlr', 'Enabled') === 'false') return;
    const { customData: _dropped, ...plain } = info;
    authCache = rememberToken(authCache, idToken, plain, now());
    changed();
  }

  /**
   * Whether a token may charge, and what is known about it: the Local
   * Authorization List, then the cache, then Authorize to the CSMS when
   * online; offline, the C13 rules. AuthCtrlr.Enabled false accepts all.
   */
  async function authorize(idToken: IdTokenType): Promise<{ ok: boolean; info?: TokenInfo }> {
    if (dmValue('AuthCtrlr', 'Enabled') === 'false') return { ok: true };
    const settings = (online: boolean) => ({
      online,
      listEnabled:
        features.includes('LocalAuthListManagement') &&
        dmValue('LocalAuthListCtrlr', 'Enabled') !== 'false',
      cacheEnabled: dmValue('AuthCacheCtrlr', 'Enabled') !== 'false',
      cacheLifeTimeS: dmInt('AuthCacheCtrlr', 'LifeTime'),
      localPreAuthorize: dmValue('AuthCtrlr', 'LocalPreAuthorize') === 'true',
      localAuthorizeOffline: dmValue('AuthCtrlr', 'LocalAuthorizeOffline') !== 'false',
      offlineTxForUnknownIdEnabled: dmValue('AuthCtrlr', 'OfflineTxForUnknownIdEnabled') === 'true',
      disableRemoteAuthorization: dmValue('AuthCtrlr', 'DisableRemoteAuthorization') === 'true',
      disablePostAuthorize: dmValue('AuthCacheCtrlr', 'DisablePostAuthorize') === 'true',
    });
    const local = decideToken(idToken, authCache, localList, settings(online()), now());
    if (local.decision !== 'ask') {
      return {
        ok: local.decision === 'start',
        ...(local.info !== undefined && { info: local.info }),
      };
    }
    const outcome = await sendIfOnline('Authorize', { idToken });
    if (outcome === undefined || !outcome.ok) {
      // No answer: decide as offline.
      const fallback = decideToken(idToken, authCache, localList, settings(false), now());
      return {
        ok: fallback.decision === 'start',
        ...(fallback.decision !== 'ask' && fallback.info !== undefined && { info: fallback.info }),
      };
    }
    const info = outcome.payload.idTokenInfo;
    rememberAnswer(idToken, info);
    const { customData: _dropped, ...plain } = info;
    const { tariff } = outcome.payload;
    if (info.status === 'Accepted' && tariff !== undefined && tariffOn()) {
      if (!takeDriverTariff(idToken, bare(tariff))) return { ok: false, info: plain };
    }
    return { ok: info.status === 'Accepted', info: plain };
  }

  /** Whether a token belongs to the Master Pass group (C16): it stops, never starts. */
  const isMasterPass = (info: TokenInfo | undefined) => {
    const group = dmValue('AuthCtrlr', 'MasterPassGroupId');
    return group !== '' && info?.groupIdToken?.idToken === group;
  };

  /** A Master Pass ends every transaction (stoppedReason MasterPass). */
  function stopAll(idToken: IdTokenType): void {
    for (const connectorId of [...transactions.keys()]) {
      const tx = transactions.get(connectorId);
      if (tx !== undefined) tx.stoppedReason = 'MasterPass';
      authorizations.delete(connectorId);
      endTransaction(connectorId, 'StopAuthorized', 'MasterPass', idToken);
    }
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
          const waiting = authorizations.get(connectorId);
          authorizations.delete(connectorId);
          // 2.1: a reservation was used, but no transaction came of it (H03.FR.11).
          if (v21 && waiting?.reservationId !== undefined) {
            void sendIfOnline('ReservationStatusUpdate', {
              reservationId: waiting.reservationId,
              reservationUpdateStatus: 'NoTransaction',
            });
          }
          if (waiting !== undefined) {
            hint({
              kind: 'start-failed',
              evseId: connectorId,
              idToken: tokenRef(waiting.idToken),
              source:
                waiting.remoteStartId !== undefined
                  ? remoteSourceOf(waiting.idToken)
                  : localSource(waiting.idToken),
              reason: 'ConnectionTimeout',
            });
            // A card no transaction used is released (C19.FR.01).
            const payment = paymentOf(waiting.idToken);
            if (payment !== undefined) cancelPayment(payment);
          }
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
    const firmwareVersion = security.firmwareVersion();
    const outcome = await current.call('BootNotification', {
      reason: bootReason,
      chargingStation: {
        ...options.boot,
        ...(firmwareVersion !== undefined && { firmwareVersion }),
      },
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
    security.bootAccepted();
    outbox.pump();
    for (const connectorId of [...needsWaiting.keys()]) sendWaitingNeeds(connectorId);
    if (resuming.size > 0) {
      const evses = [...resuming];
      resuming = new Set();
      poweredDown = false;
      for (const connectorId of evses) resumeTransaction(connectorId);
    }
  }

  // ---- Resuming transactions (2.1, B13, E17) --------------------------------

  /** The EV on a connector as it is now, to plug it in again after a power loss. */
  function evOf(connectorId: number): PluggedEv | undefined {
    const ev = energy.ev(connectorId);
    if (ev === undefined) return undefined;
    return {
      ...(ev.name !== undefined && { name: ev.name }),
      profile: { ...ev.state.profile, initialSoc: ev.state.soc },
    };
  }

  /**
   * A transaction carries on after a reset or power loss: in its previous
   * state, except that a Charging transaction without
   * TxCtrlr.AllowEnergyTransferResumption stays SuspendedEVSE (B13.FR.14,
   * E17.FR.12); the specification gives it no way back, so it stays so
   * until it ends. Reported with TxResumed (B13.FR.30, E17.FR.14).
   */
  function resumeTransaction(connectorId: number): void {
    const tx = transactions.get(connectorId);
    if (tx === undefined) return;
    if (tx.wasCharging === true && dmValue('TxCtrlr', 'AllowEnergyTransferResumption') !== 'true') {
      tx.resumeHold = true;
    }
    tx.wasCharging = undefined;
    updatePower(connectorId);
    updateLock(connectorId);
    sendEvent(connectorId, tx, 'Updated', 'TxResumed');
    schedulePeriodic(connectorId, tx);
    if (tx.cost !== undefined) scheduleCost(connectorId, tx);
    checkTxLimits(connectorId, tx);
    log(`connector ${connectorId}: transaction ${tx.id} resumed`);
  }

  /**
   * Reset ImmediateAndResume with transactions (B13): each reports
   * ResetCommand, then an EVSE reset stops its energy for a moment and
   * resumes (B13.FR.10, .11), and a station reset reboots and resumes them
   * once the boot is accepted (B13.FR.20 to .23).
   */
  function resetAndResume(evseId: number | undefined): void {
    const affected = evseId === undefined ? [...transactions.keys()] : [evseId];
    for (const connectorId of affected) {
      const tx = transactions.get(connectorId);
      if (tx === undefined) continue;
      tx.wasCharging = currentChargingState(connectorId) === 'Charging';
      sendEvent(connectorId, tx, 'Updated', 'ResetCommand');
    }
    if (evseId !== undefined) {
      evsesDown.add(evseId);
      updatePower(evseId);
      log(`EVSE ${evseId} reset; its transaction resumes`);
      later(timing.resetDowntimeMs.Soft, () => {
        evsesDown.delete(evseId);
        resumeTransaction(evseId);
      });
      return;
    }
    poweredDown = true;
    resuming = new Set(affected);
    updateAllPowers();
    bootReason = 'RemoteReset';
    log('ImmediateAndResume reset');
    security.rebooting();
    void whenDelivered().then(() => options.restart?.(timing.resetDowntimeMs.Hard));
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

  // ---- Remote control and reset ---------------------------------------------

  const commandDelay = (
    command:
      | 'RequestStartTransaction'
      | 'RequestStopTransaction'
      | 'Reset'
      | 'UnlockConnector'
      | 'TriggerMessage'
      | 'CustomerInformation',
  ) => timing.actionDelaysMs?.[command] ?? timing.actionDelayMs;

  /**
   * A remote start (F01, F02): with AuthorizeRemoteStart the token is
   * authorized as a local one would be; then the connector waits for the
   * cable, or the transaction already started (EVConnected) gets the token.
   */
  async function remoteStart(
    connectorId: number,
    idToken: IdTokenType,
    remoteStartId: number,
    txProfile?: ChargingProfile201,
    groupIdToken?: IdTokenType,
  ): Promise<void> {
    let info: TokenInfo | undefined;
    if (dmValue('AuthCtrlr', 'AuthorizeRemoteStart') !== 'false') {
      const result = await authorize(idToken);
      if (!result.ok || isMasterPass(result.info)) {
        log(`connector ${connectorId}: remote start refused, ${idToken.idToken} not authorized`);
        hint({
          kind: 'start-failed',
          evseId: connectorId,
          idToken: tokenRef(idToken),
          source: remoteSourceOf(idToken),
          reason: 'NotAuthorized',
        });
        return;
      }
      info = result.info;
    }
    const claim = claimReservation(connectorId, idToken, info?.groupIdToken ?? groupIdToken);
    if (!claim.ok) {
      log(`connector ${connectorId}: remote start refused, the EVSE is reserved`);
      hint({
        kind: 'start-failed',
        evseId: connectorId,
        idToken: tokenRef(idToken),
        source: remoteSourceOf(idToken),
        reason: 'NotAuthorized',
        detail: 'the EVSE is reserved',
      });
      return;
    }
    // A web payment's transaction keeps the limits of its payment URL (C25.FR.60).
    const limits = idToken.type === 'DirectPayment' ? webLimits.get(connectorId) : undefined;
    webLimits.delete(connectorId);
    authorizations.set(connectorId, {
      idToken,
      remoteStartId,
      ...(limits !== undefined && { limits }),
      ...(info !== undefined && { info }),
      ...(txProfile !== undefined && { txProfile }),
      ...(claim.reservationId !== undefined && { reservationId: claim.reservationId }),
    });
    hint({
      kind: 'authorized',
      evseId: connectorId,
      idToken: tokenRef(idToken),
      source: remoteSourceOf(idToken),
      remoteStartId,
    });
    const tx = transactions.get(connectorId);
    if (tx !== undefined && tx.remoteStartId === undefined) tx.remoteStartId = remoteStartId;
    if (tx !== undefined && txProfile !== undefined) installTxProfile(connectorId, txProfile);
    if (findConnector(station, connectorId)?.plugged !== true) awaitCable(connectorId);
    evaluate(connectorId, tx === undefined ? 'Authorized' : 'RemoteStart', idToken);
  }

  /** Restarts the station after a reset: transactions end, then it reboots (B11, B12). */
  function resetStation(type: 'Immediate' | 'OnIdle'): void {
    for (const connectorId of [...transactions.keys()]) {
      authorizations.delete(connectorId);
      endTransaction(connectorId, 'ResetCommand', 'ImmediateReset');
    }
    bootReason = 'RemoteReset';
    log(`${type} reset`);
    security.rebooting();
    // The Ended events (and the ResetOrReboot event) go out before the reboot.
    void whenDelivered().then(() =>
      options.restart?.(
        type === 'Immediate' ? timing.resetDowntimeMs.Hard : timing.resetDowntimeMs.Soft,
      ),
    );
  }

  /** Reboots to activate installed firmware; installing waited for the transactions. */
  function rebootForFirmware(): void {
    bootReason = 'FirmwareUpdate';
    security.rebooting();
    options.restart?.(timing.resetDowntimeMs.Hard);
  }

  /** A diagnostics log (GetLog DiagnosticsLog): the station's state as text. */
  function diagnosticsText(): string {
    const lines = [
      `${timestamp()} diagnostics of ${options.boot.vendorName} ${options.boot.model}`,
      `registration ${registration}, station ${stationStatus201(station)}`,
      ...connectors(station).map((c) => {
        const tx = transactions.get(c.connectorId);
        return `EVSE ${c.connectorId}: ${connectorStatus201(c, station)}${tx === undefined ? '' : `, transaction ${tx.id}`}`;
      }),
      `queued messages ${outbox.entries.length}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  /** Resets one EVSE: its transaction ends and its status is reported again. */
  function resetEvse(evseId: number): void {
    if (transactions.has(evseId)) {
      authorizations.delete(evseId);
      endTransaction(evseId, 'ResetCommand', 'ImmediateReset');
    }
    reported.delete(evseId);
    reportStatuses();
    log(`EVSE ${evseId} reset`);
  }

  /** An OnIdle reset proceeds once nothing it concerns has a transaction. */
  function runScheduledReset(): void {
    const reset = scheduledReset;
    if (reset === undefined) return;
    if (reset.evseId !== undefined) {
      if (transactions.has(reset.evseId)) return;
      scheduledReset = undefined;
      resetEvse(reset.evseId);
      return;
    }
    if (transactions.size > 0) return;
    scheduledReset = undefined;
    resetStation('OnIdle');
  }

  /** What the station holds about a customer, as lines (the cache and the local list). */
  function customerData(idToken: IdTokenType, clear: boolean): string[] {
    const lines: string[] = [];
    const cached = cachedToken(authCache, idToken, now(), dmInt('AuthCacheCtrlr', 'LifeTime'));
    if (cached !== undefined) {
      lines.push(`authorization cache: ${idToken.type} ${idToken.idToken} ${cached.status}`);
      // Cleared from the cache; the local list only changes by SendLocalList (N10.FR.03).
      if (clear) {
        const { [tokenKey(idToken)]: _removed, ...rest } = authCache;
        authCache = rest;
        changed();
      }
    }
    const listed = localList.entries[tokenKey(idToken)];
    if (listed !== undefined) {
      lines.push(`local authorization list: ${idToken.type} ${idToken.idToken} ${listed.status}`);
    }
    for (const [connectorId, tx] of transactions) {
      if (tx.idToken !== undefined && tokenKey(tx.idToken) === tokenKey(idToken)) {
        lines.push(`transaction ${tx.id} on EVSE ${connectorId}`);
      }
    }
    return lines;
  }

  /** Sends NotifyCustomerInformation pages of up to 512 characters (N09.FR.05, .06). */
  function sendCustomerInformation(requestId: number, lines: string[]): void {
    const text = lines.length > 0 ? lines.join('\n') : 'No information available';
    const pages: string[] = [];
    for (let i = 0; i < text.length; i += 512) pages.push(text.slice(i, i + 512));
    const generatedAt = timestamp();
    // Gathering the data takes a moment; a CSMS also needs one to record its request.
    later(commandDelay('CustomerInformation'), () => {
      pages.forEach((data, seqNo) => {
        void sendIfOnline('NotifyCustomerInformation', {
          data,
          seqNo,
          generatedAt,
          requestId,
          ...(seqNo < pages.length - 1 && { tbc: true }),
        });
      });
    });
  }

  /** A Device Model value changed by SetVariables: apply what depends on it. */
  function variableChanged(key: string): void {
    security.variableChanged(key);
    if (key === 'OCPPCommCtrlr/HeartbeatInterval') startHeartbeat();
    if (key.startsWith('AlignedDataCtrlr/')) scheduleAligned();
    if (
      key === 'SampledDataCtrlr/TxUpdatedInterval' ||
      key === 'SampledDataCtrlr/TxEndedInterval' ||
      key === 'SampledDataCtrlr/UpstreamInterval'
    ) {
      for (const [id, tx] of transactions) schedulePeriodic(id, tx);
    }
  }

  type ReportData = NonNullable<Ocpp21RequestOf<'NotifyReport'>['reportData']>;

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

  const handlers: RpcHandlers<Ocpp21RpcTypes> = {
    RequestStartTransaction(request) {
      const busy = (id: number) =>
        authorizations.has(id) || transactions.get(id)?.idToken !== undefined;
      const usable = (id: number) => {
        const connector = findConnector(station, id);
        return (
          connector !== undefined &&
          !busy(id) &&
          connectorStatus201(connector, station) !== 'Unavailable' &&
          connectorStatus201(connector, station) !== 'Faulted' &&
          // Reserved for someone else (H03).
          (!reservationsOn() ||
            useAt(id, request.idToken, request.groupIdToken, reservations, evseViews()).ok)
        );
      };
      // Without an EVSE the station picks a free one (F01.FR.06).
      const evseId =
        request.evseId ??
        connectors(station).find((c) => usable(c.connectorId) && !c.plugged)?.connectorId ??
        connectors(station).find((c) => usable(c.connectorId))?.connectorId;
      if (behaviour.refuseRemoteStart || evseId === undefined || !usable(evseId)) {
        return { status: 'Rejected' };
      }
      // Its charging profile must be a valid TxProfile without transactionId (K05.FR.05,
      // F01.FR.09, .11); a station without Smart Charging ignores it (K05.FR.04).
      const txProfile = smartCharging() ? request.chargingProfile : undefined;
      if (txProfile !== undefined) {
        const problem =
          txProfile.chargingProfilePurpose !== 'TxProfile'
            ? 'not a TxProfile'
            : txProfile.transactionId !== undefined
              ? 'a transactionId is set'
              : (profileProblem21(txProfile, profileContext())?.reason ??
                profileProblem({ ...txProfile, transactionId: 'remote' }, evseId, {
                  ...profileContext(),
                  transactionOn: () => 'remote',
                }));
        if (problem !== undefined) {
          log(`RequestStartTransaction rejected: charging profile ${txProfile.id} ${problem}`);
          return { status: 'Rejected', statusInfo: { reasonCode: 'InvalidProfile' } };
        }
      }
      const running = transactions.get(evseId);
      // The web payment the driver made starts here: local starts may go on (C25.FR.22).
      releaseWebHold(evseId);
      later(commandDelay('RequestStartTransaction'), () =>
        remoteStart(
          evseId,
          request.idToken,
          request.remoteStartId,
          txProfile,
          request.groupIdToken,
        ),
      );
      // A transaction without a token gets this one; its id goes back (F01.FR.13).
      return {
        status: 'Accepted',
        ...(running !== undefined && { transactionId: running.id }),
      };
    },

    // 2.1: the transfers the CSMS allows for a transaction; a charging-only station takes them.
    NotifyAllowedEnergyTransfer(request) {
      if (![...transactions.values()].some((tx) => tx.id === request.transactionId)) {
        return { status: 'Rejected', statusInfo: { reasonCode: 'TxNotFound' } };
      }
      log(
        `transaction ${request.transactionId}: allowed energy transfer ${request.allowedEnergyTransfer.join(', ')}`,
      );
      return { status: 'Accepted' };
    },

    // 2.1: a driver pays on the CSMS's web page; the EVSE waits for the remote start (C25.FR.22, .27).
    NotifyWebPaymentStarted(request) {
      log(`EVSE ${request.evseId}: a web payment started; local starts wait ${request.timeout} s`);
      holdForWebPayment(request.evseId, request.timeout);
      return {};
    },

    // A running cost to show the driver (I03); the station only logs it.
    CostUpdated(request) {
      log(`running cost of ${request.transactionId}: ${request.totalCost}`);
      // 2.1: the CSMS's cost counts for maxCost when the station prices nothing itself (E16.FR.15).
      const entry = [...transactions].find(([, tx]) => tx.id === request.transactionId);
      if (v21 && entry !== undefined) {
        const [connectorId, tx] = entry;
        // I02: the running cost on the EVSE's display.
        show(connectorId, 'runningCost', `So far ${money(request.totalCost)}`);
        tx.csmsCost = request.totalCost;
        later(0, () => checkTxLimits(connectorId, tx));
      }
      return {};
    },

    RequestStopTransaction(request) {
      const entry = [...transactions].find(([, tx]) => tx.id === request.transactionId);
      if (entry === undefined) return { status: 'Rejected' };
      const [connectorId] = entry;
      later(commandDelay('RequestStopTransaction'), () =>
        deauthorize(connectorId, 'RemoteStop', 'Remote'),
      );
      return { status: 'Accepted' };
    },

    UnlockConnector(request) {
      const connector = findConnector(station, request.evseId);
      if (connector === undefined || request.connectorId !== 1)
        return { status: 'UnknownConnector' };
      // An authorized transaction keeps its cable (F05.FR.02).
      if (transactions.has(request.evseId) && authorizations.has(request.evseId)) {
        return { status: 'OngoingAuthorizedTransaction' };
      }
      later(commandDelay('UnlockConnector'), () => {
        if (findConnector(station, request.evseId)?.locked === true) {
          applyDevice({ type: 'Unlock', connectorId: request.evseId });
        }
      });
      return { status: 'Unlocked' };
    },

    TriggerMessage(request) {
      const evseId = request.evse?.id;
      if (evseId !== undefined && findConnector(station, evseId) === undefined) {
        return { status: 'Rejected' };
      }
      const targets =
        evseId === undefined ? connectors(station).map((c) => c.connectorId) : [evseId];
      const senders: Partial<Record<string, () => void>> = {
        // Only before the CSMS accepted the boot (F06.FR.17).
        ...(registration !== 'Accepted' && {
          BootNotification: () => {
            bootReason = 'Triggered';
            stopTimer(bootTimer);
            bootTimer = undefined;
            void boot();
          },
        }),
        Heartbeat: () => void sendIfOnline('Heartbeat', {}),
        StatusNotification: () => {
          for (const id of targets) reported.delete(id);
          reportStatuses();
        },
        MeterValues: () => {
          for (const id of targets) {
            const value = sample(id, dmValue('AlignedDataCtrlr', 'Measurands'), 'Trigger');
            if (value !== undefined)
              void sendIfOnline('MeterValues', { evseId: id, meterValue: [value] });
          }
        },
        FirmwareStatusNotification: security.triggers.FirmwareStatusNotification,
        LogStatusNotification: security.triggers.LogStatusNotification,
        ...(features.includes('AdvancedSecurity') && {
          SignChargingStationCertificate: security.triggers.SignChargingStationCertificate,
        }),
        TransactionEvent: () => {
          for (const id of targets) {
            const tx = transactions.get(id);
            if (tx === undefined) continue;
            const value = sample(id, dmValue('SampledDataCtrlr', 'TxUpdatedMeasurands'), 'Trigger');
            sendEvent(id, tx, 'Updated', 'Trigger', {
              ...(value !== undefined && { meterValue: [value] }),
            });
          }
        },
      };
      // 2.1: a vendor trigger listed in CustomizationCtrlr.CustomTriggers sends the
      // persona's message for it, a DataTransfer named after it (F06.FR.18, .19).
      if (request.requestedMessage === 'CustomTrigger') {
        const name = request.customTrigger;
        const listed = dmValue('CustomizationCtrlr', 'CustomTriggers').split(',');
        if (!v21 || name === undefined || !listed.includes(name))
          return { status: 'NotImplemented' };
        later(commandDelay('TriggerMessage'), () => {
          void sendIfOnline('DataTransfer', { vendorId: 'ocpp-mimic', messageId: name });
        });
        return { status: 'Accepted' };
      }
      const send = senders[request.requestedMessage];
      if (send === undefined) return { status: 'NotImplemented' };
      // The answer goes first, then the message (F06.FR.04).
      later(commandDelay('TriggerMessage'), send);
      return { status: 'Accepted' };
    },

    Reset(request) {
      if (request.evseId !== undefined) {
        if (findConnector(station, request.evseId) === undefined) return { status: 'Rejected' };
        if (deviceModel.get(`EVSE@${request.evseId}`, 'AllowReset') === 'false') {
          return { status: 'Rejected' };
        }
      }
      const busy =
        request.evseId === undefined ? transactions.size > 0 : transactions.has(request.evseId);
      if (request.type === 'ImmediateAndResume') {
        // Resuming needs TxCtrlr.ResumptionTimeout (B13.FR.01); without transactions it is
        // a plain immediate reset (B13.FR.02).
        if (!v21 || dmInt('TxCtrlr', 'ResumptionTimeout') <= 0) return { status: 'Rejected' };
        if (busy) {
          const { evseId } = request;
          later(commandDelay('Reset'), () => resetAndResume(evseId));
          return { status: 'Accepted' };
        }
      }
      if (request.type === 'OnIdle' && busy) {
        scheduledReset = request.evseId === undefined ? {} : { evseId: request.evseId };
        return { status: 'Scheduled' };
      }
      const type = request.type === 'OnIdle' ? 'OnIdle' : 'Immediate';
      later(commandDelay('Reset'), () =>
        request.evseId === undefined ? resetStation(type) : resetEvse(request.evseId),
      );
      return { status: 'Accepted' };
    },

    DataTransfer() {
      return { status: 'UnknownVendorId' };
    },

    ReserveNow(request) {
      if (dmValue('ReservationCtrlr', 'Enabled') === 'false') return { status: 'Rejected' };
      const bare = ({ customData: _ignored, ...token }: IdTokenType) => token;
      const reservation: Reservation201 = {
        id: request.id,
        ...(request.evseId !== undefined && { evseId: request.evseId }),
        ...(request.connectorType !== undefined && { connectorType: request.connectorType }),
        idToken: bare(request.idToken),
        ...(request.groupIdToken !== undefined && { groupIdToken: bare(request.groupIdToken) }),
        expiresAt: Date.parse(request.expiryDateTime),
      };
      if (reservation.expiresAt <= now()) return { status: 'Rejected' };
      // The same id replaces that reservation (H01.FR.02).
      const others = reservations.filter((r) => r.id !== request.id);
      const answer = reserveAnswer(
        reservation,
        others,
        evseViews(),
        dmValue('ReservationCtrlr', 'NonEvseSpecific') === 'true',
      );
      if (answer.status !== 'Accepted') {
        log(
          `reservation ${request.id}: ${answer.status}${answer.reason === undefined ? '' : `, ${answer.reason}`}`,
        );
        return { status: answer.status };
      }
      reservations = [...others, reservation];
      scheduleExpiry(reservation);
      log(`reservation ${request.id} accepted`);
      // The answer goes first, then StatusNotification Reserved (H01.FR.23).
      later(0, syncReserved);
      changed();
      return { status: 'Accepted' };
    },

    CancelReservation(request) {
      if (!reservations.some((r) => r.id === request.reservationId)) return { status: 'Rejected' };
      // Gone at once; the EVSE's status follows the answer.
      reservations = reservations.filter((r) => r.id !== request.reservationId);
      stopTimer(reservationTimers.get(request.reservationId));
      reservationTimers.delete(request.reservationId);
      log(`reservation ${request.reservationId} cancelled`);
      later(0, syncReserved);
      changed();
      return { status: 'Accepted' };
    },

    SetChargingProfile(request) {
      // A TxProfile before an ISO 15118-20 EV's needs went out is too early (K18.FR.17, K19.FR.13);
      // the appendix's reason code, as the spec's InvalidMessageSequence is over 20 characters.
      if (
        v21 &&
        request.chargingProfile.chargingProfilePurpose === 'TxProfile' &&
        energy.ev(request.evseId)?.state.profile.communication === 'iso15118-20' &&
        transactions.has(request.evseId) &&
        (needsDue.has(request.evseId) || needsWaiting.has(request.evseId))
      ) {
        log(`SetChargingProfile ${request.chargingProfile.id}: the EV's needs are not sent yet`);
        return { status: 'Rejected', statusInfo: { reasonCode: 'InvalidMessageSeq' } };
      }
      const result = installProfile201(
        chargingProfiles,
        request.evseId,
        request.chargingProfile,
        profileContext(),
      );
      if (result.status === 'Rejected') {
        log(`SetChargingProfile ${request.chargingProfile.id} rejected: ${result.reason}`);
        return {
          status: 'Rejected',
          statusInfo: {
            reasonCode: v21 ? result.reasonCode : 'InvalidProfile',
            additionalInfo: result.reason.slice(0, 512),
          },
        };
      }
      chargingProfiles = result.profiles;
      // The collection is evaluated again (K01.FR.07), after the answer.
      later(0, () => {
        updateAllPowers();
        scheduleDynamicPulls();
      });
      return { status: 'Accepted' };
    },

    SetDefaultTariff(request) {
      const tariff = bare(request.tariff);
      const evseIds = connectors(station).map((c) => c.connectorId);
      if (request.evseId !== 0 && !evseIds.includes(request.evseId)) {
        return { status: 'Rejected', statusInfo: { reasonCode: 'UnknownEVSE' } };
      }
      const check = checkTariff(tariff, tariffLimits());
      if (check.status !== 'Accepted') {
        log(`SetDefaultTariff ${tariff.tariffId}: ${check.reason}`);
        return {
          status: check.status,
          ...(check.status === 'Rejected' && { statusInfo: { reasonCode: 'InvalidValue' } }),
        };
      }
      // A tariffId names one tariff on the whole station (I07.FR.04).
      const taken =
        defaultTariffs.some((e) => e.tariff.tariffId === tariff.tariffId) ||
        [...driverTariffs.values()].some((d) => d.tariffId === tariff.tariffId);
      if (taken) return { status: 'DuplicateTariffId' };
      const targets = request.evseId === 0 ? evseIds : [request.evseId];
      const at = now();
      defaultTariffs = [
        ...defaultTariffs,
        ...targets.map((evseId) => ({ evseId, tariff, installedAt: at })),
      ];
      // Tariffs a newer valid one replaced on an EVSE go (I07.FR.20 to .23).
      defaultTariffs = defaultTariffs.filter(
        (e) => effectiveFrom(e) > at || activeDefault(e.evseId) === e.tariff,
      );
      log(
        `default tariff ${tariff.tariffId} on ${request.evseId === 0 ? 'every EVSE' : `EVSE ${request.evseId}`}`,
      );
      changed();
      return { status: 'Accepted' };
    },

    GetTariffs(request) {
      const evseOk = (evseId: number) => request.evseId === 0 || evseId === request.evseId;
      const byId = new Map<string, { tariff: Tariff21; evseIds: number[] }>();
      for (const e of defaultTariffs) {
        if (!evseOk(e.evseId)) continue;
        const entry = byId.get(e.tariff.tariffId) ?? { tariff: e.tariff, evseIds: [] };
        entry.evseIds.push(e.evseId);
        byId.set(e.tariff.tariffId, entry);
      }
      type Assignment = NonNullable<Ocpp21ResponseOf<'GetTariffs'>['tariffAssignments']>[number];
      const list: Assignment[] = [...byId.values()].map(({ tariff, evseIds }) => ({
        tariffId: tariff.tariffId,
        tariffKind: 'DefaultTariff',
        ...(tariff.validFrom !== undefined && { validFrom: tariff.validFrom }),
        evseIds,
      }));
      // Driver tariffs in use, with the EVSE of their transaction and their token (I09.FR.06).
      for (const [evseId, tx] of transactions) {
        if (!evseOk(evseId) || tx.cost === undefined || tx.idToken === undefined) continue;
        const driver = driverTariffs.get(tokenKey(tx.idToken));
        if (driver === undefined || driver.tariffId !== tx.cost.tariffId) continue;
        list.push({
          tariffId: driver.tariffId,
          tariffKind: 'DriverTariff',
          evseIds: [evseId],
          idTokens: [tx.idToken.idToken],
        });
      }
      const [first, ...rest] = list;
      return first === undefined
        ? { status: 'NoTariff' }
        : { status: 'Accepted', tariffAssignments: [first, ...rest] };
    },

    ClearTariffs(request) {
      const matches = (e: TariffEntry) =>
        (request.tariffIds === undefined || request.tariffIds.includes(e.tariff.tariffId)) &&
        (request.evseId === undefined || request.evseId === 0 || e.evseId === request.evseId);
      const cleared = [...new Set(defaultTariffs.filter(matches).map((e) => e.tariff.tariffId))];
      // A running transaction keeps the tariff it has (I10.FR.07).
      defaultTariffs = defaultTariffs.filter((e) => !matches(e));
      changed();
      const [first, ...rest] = cleared.map((tariffId) => ({
        tariffId,
        status: 'Accepted' as const,
      }));
      return {
        clearTariffsResult:
          first === undefined ? [{ status: 'NoTariff' as const }] : [first, ...rest],
      };
    },

    ChangeTransactionTariff(request) {
      const tariff = bare(request.tariff);
      const check = checkTariff(tariff, tariffLimits());
      if (check.status === 'TooManyElements' || check.status === 'ConditionNotSupported') {
        return { status: check.status };
      }
      if (check.status !== 'Accepted') return { status: 'Rejected' };
      const entry = [...transactions].find(([, tx]) => tx.id === request.transactionId);
      if (entry === undefined) return { status: 'TxNotFound' };
      const [evseId, tx] = entry;
      if (tx.cost !== undefined && tx.cost.currency !== tariff.currency) {
        return { status: 'NoCurrencyChange' };
      }
      // From now on, with TariffChanged and the new tariffId (I11.FR.07, .08).
      later(0, () => {
        if (transactions.get(evseId) !== tx) return;
        if (tx.cost === undefined) {
          tx.cost = createCostMeter({
            tariff,
            place: { timeZone: dmValue('ClockCtrlr', 'TimeZone'), evseKind: 'AC' },
            start: costSituation(evseId, tx),
          });
        } else {
          tx.cost.advance(costSituation(evseId, tx));
          tx.cost.changeTariff(tariff);
        }
        if (tx.idToken !== undefined) driverTariffs.set(tokenKey(tx.idToken), tariff);
        tx.tariffIdPending = true;
        sendEvent(evseId, tx, 'Updated', 'TariffChanged');
        scheduleCost(evseId, tx);
      });
      return { status: 'Accepted' };
    },

    UsePriorityCharging(request) {
      if (!v21) return { status: 'Rejected' };
      const entry = [...transactions].find(([, tx]) => tx.id === request.transactionId);
      if (entry === undefined) {
        return { status: 'Rejected', statusInfo: { reasonCode: 'TxNotFound' } };
      }
      const [evseId] = entry;
      if (request.activate && !hasPriorityProfile(evseId)) {
        return { status: 'NoProfile', statusInfo: { reasonCode: 'NotFound' } };
      }
      // Answered first, then switched and notified (K21.FR.03 to .08).
      later(0, () => setPriority(evseId, request.activate));
      return { status: 'Accepted' };
    },

    UpdateDynamicSchedule(request) {
      const found = chargingProfiles.find((p) => p.profile.id === request.chargingProfileId);
      if (found === undefined)
        return { status: 'Rejected', statusInfo: { reasonCode: 'NotFound' } };
      if (found.profile.chargingProfileKind !== 'Dynamic') {
        return { status: 'Rejected', statusInfo: { reasonCode: 'InvalidProfile' } };
      }
      later(0, () => applyScheduleUpdate(request.chargingProfileId, request.scheduleUpdate));
      return { status: 'Accepted' };
    },

    ClearChargingProfile(request) {
      const result = clearProfiles201(chargingProfiles, request);
      if (result.status === 'Accepted') {
        chargingProfiles = result.profiles;
        later(0, updateAllPowers);
      }
      return { status: result.status };
    },

    GetChargingProfiles(request) {
      const selected = selectProfiles201(chargingProfiles, request);
      if (selected.length === 0) return { status: 'NoProfiles' };
      later(0, () => reportProfiles(request.requestId, selected));
      return { status: 'Accepted' };
    },

    GetCompositeSchedule(request) {
      const { evseId } = request;
      const units = profileContext().units;
      const unit = request.chargingRateUnit ?? (units.includes('W') ? 'W' : 'A');
      // An unknown EVSE or unit cannot be reported (K08.FR.05, .07).
      if ((evseId !== 0 && findConnector(station, evseId) === undefined) || !units.includes(unit)) {
        return { status: 'Rejected' };
      }
      const ids = connectors(station).map((c) => c.connectorId);
      return {
        status: 'Accepted',
        schedule: compositeSchedule201(chargingProfiles, {
          evseId,
          from: now(),
          durationS: request.duration,
          unit,
          conversion: evseId === 0 ? { voltageV: 230, phases: 3 } : energy.conversion(evseId),
          ratingW: evseId === 0 ? offeredW * ids.length : offeredW,
          evseIds: ids,
          // An EVSE without a transaction is computed as if one started now (K08.FR.06).
          transaction: (id) => txInfo(id) ?? { startedAt: now() },
          priorityEvses,
        }),
      };
    },

    ...security.handlers,

    CustomerInformation(request) {
      const references = [request.idToken, request.customerIdentifier, request.customerCertificate];
      if (references.filter((r) => r !== undefined).length !== 1) return { status: 'Invalid' };
      if (!request.report && !request.clear) return { status: 'Rejected' };
      // ocpp-mimic keeps customer data by idToken only.
      const lines =
        request.idToken === undefined ? [] : customerData(request.idToken, request.clear);
      if (request.report || request.clear) sendCustomerInformation(request.requestId, lines);
      return { status: 'Accepted' };
    },

    ClearCache() {
      if (dmValue('AuthCacheCtrlr', 'Enabled') === 'false') return { status: 'Rejected' };
      authCache = {};
      changed();
      return { status: 'Accepted' };
    },

    SendLocalList(request) {
      const items = request.localAuthorizationList?.length ?? 0;
      const maxItems = dmInt('LocalAuthListCtrlr', 'ItemsPerMessage');
      if (maxItems > 0 && items > maxItems) return { status: 'Failed' };
      const result = applyLocalList(localList, request, LOCAL_LIST_SIZE);
      if (result.status === 'Accepted') {
        localList = result.list;
        changed();
      }
      return { status: result.status };
    },

    GetLocalListVersion() {
      return { versionNumber: localList.version };
    },

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

  /**
   * A transaction saved before a power loss, carried on (E17): the EV is
   * still plugged in and authorized, with its state of charge and limits.
   * TxResumed goes out once the boot is accepted.
   */
  function resumeSaved(saved: PersistedTransaction201): void {
    const { connectorId } = saved;
    if (saved.ev !== undefined) energy.plugEv(connectorId, saved.ev);
    station = reduce(station, { type: 'Plug', connectorId }, now()).state;
    if (saved.idToken !== undefined) authorizations.set(connectorId, { idToken: saved.idToken });
    const tx: Transaction201 = {
      id: saved.transactionId,
      seqNo: saved.seqNo,
      startedAt: saved.startedAt,
      meterStartWh: saved.meterStartWh,
      ...(saved.idToken !== undefined && { idToken: saved.idToken }),
      ...(saved.remoteStartId !== undefined && { remoteStartId: saved.remoteStartId }),
      ...(saved.stoppedReason !== undefined && { stoppedReason: saved.stoppedReason }),
      ...(saved.limits !== undefined && { limits: saved.limits as TransactionLimit }),
      chargingState: saved.chargingState ?? 'EVConnected',
      wasCharging: saved.chargingState === 'Charging',
      endedValues: [],
    };
    // Its own cost carries on: the time the station was down is not priced (E17).
    if (saved.cost !== undefined) {
      tx.cost = createCostMeter({
        tariff: saved.cost.tariff,
        place: saved.cost.place,
        start: saved.cost.last,
        restore: saved.cost,
      });
    }
    transactions.set(connectorId, tx);
    station = reduce(
      station,
      { type: 'TransactionStarted', connectorId, transactionId: 1 },
      now(),
    ).state;
    resuming.add(connectorId);
    poweredDown = true;
  }

  const restored = options.restore;
  if (restored !== undefined) {
    outbox.restore(restored.outbox);
    // 2.1 resumes transactions interrupted for at most TxCtrlr.ResumptionTimeout (E17.FR.10);
    // the others end now, as of the save (E06.FR.16, E17.FR.21).
    const timeoutS = v21 ? dmInt('TxCtrlr', 'ResumptionTimeout') : 0;
    const resumable = timeoutS > 0 && now() - restored.savedAt <= timeoutS * 1000;
    for (const saved of restored.transactions ?? []) {
      if (resumable && findConnector(station, saved.connectorId) !== undefined) {
        resumeSaved(saved);
        continue;
      }
      const final = sampleMeter201(
        energy.meter(saved.connectorId),
        restored.savedAt,
        dmValue('SampledDataCtrlr', 'TxEndedMeasurands'),
        'Transaction.End',
      );
      const key = nextKey('msg');
      const payment = paymentOf(saved.idToken);
      if (payment !== undefined) {
        afterRestoredEnd.set(key, (answer) => settlePayment(payment, saved.transactionId, answer));
      }
      void outbox.restore([
        {
          key,
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
    // Reservations hold their EVSEs again; one that expired meanwhile ends at once.
    for (const reservation of reservations) scheduleExpiry(reservation);
    syncReserved();
  }

  // ---- Public interface ---------------------------------------------------

  // Clock-aligned sampling runs from the start, offline too: its events queue.
  scheduleAligned();
  // Powering up is a security event, sent once the CSMS has accepted the boot.
  security.securityEvent('StartupOfTheDevice');

  const chargePoint: ChargePoint201 = {
    ocpp,

    connected() {
      security.connected();
      rpc?.close();
      rpc = createRpc<Ocpp21RpcTypes>({
        clock,
        ids,
        send: options.send,
        messages: v21 ? OCPP21_MESSAGE_SET : OCPP201_MESSAGE_SET,
        handlers,
        // Actions of a certification profile the persona does not support answer NotSupported.
        supports: (action) =>
          ((action !== 'SendLocalList' && action !== 'GetLocalListVersion') ||
            features.includes('LocalAuthListManagement')) &&
          (!SMART_CHARGING_ACTIONS.has(action) || smartCharging()) &&
          ((action !== 'ReserveNow' && action !== 'CancelReservation') || reservationsOn()) &&
          (action !== 'CertificateSigned' || features.includes('AdvancedSecurity')) &&
          // Without Enabled[Tariff], tariffs are NotSupported (I07.FR.01, I11.FR.01).
          (!TARIFF_ACTIONS.has(action) || tariffOn()) &&
          (action !== 'NotifyWebPaymentStarted' || features.includes('WebPayments')),
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
      releaseDelivered();
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
      needsDue.set(connectorId, now());
      pluggedAtOf.set(connectorId, now());
      stopTimer(connectTimers.get(connectorId));
      connectTimers.delete(connectorId);
      if (
        behaviour.autocharge &&
        ev?.profile.evccid !== undefined &&
        !authorizations.has(connectorId) &&
        !transactions.has(connectorId)
      ) {
        // Autocharge: the EV's EVCCID is its token (2.1 EVCCID, 2.0.1 MacAddress).
        log(`connector ${connectorId}: autocharge as ${ev.profile.evccid}`);
        void chargePoint.presentIdTag(
          connectorId,
          ev.profile.evccid,
          v21 ? 'EVCCID' : 'MacAddress',
        );
      } else if (
        dmValue('AuthCtrlr', 'Enabled') === 'false' &&
        !authorizations.has(connectorId) &&
        !transactions.has(connectorId) &&
        findConnector(station, connectorId)?.reservationId === undefined
      ) {
        // Without authorization the cable is enough: the token is NoAuthorization, empty.
        const idToken: IdTokenType = { idToken: '', type: 'NoAuthorization' };
        authorizations.set(connectorId, { idToken });
        hint({
          kind: 'authorized',
          evseId: connectorId,
          idToken: tokenRef(idToken),
          source: 'noAuth',
        });
      }
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
      needsDue.delete(connectorId);
      needsWaiting.delete(connectorId);
      pluggedAtOf.delete(connectorId);
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
      const idToken: IdTokenType = { idToken: token, type };
      const session = authorizations.get(connectorId);
      const current = session?.idToken ?? transactions.get(connectorId)?.idToken;
      if (current !== undefined) {
        // The same token ends the session (E07), so does one of its group (C09).
        if (current.idToken === token && current.type === idToken.type) {
          deauthorize(connectorId, 'StopAuthorized', 'Local', idToken);
          return 'stopping';
        }
        const presented = await authorize(idToken);
        if (isMasterPass(presented.info)) {
          stopAll(idToken);
          return 'stopping';
        }
        if (presented.ok && sameGroup(presented.info, session?.info)) {
          deauthorize(connectorId, 'StopAuthorized', 'Local', idToken);
          return 'stopping';
        }
        return 'busy';
      }
      if (webHeld(connectorId)) {
        log(`connector ${connectorId}: a web payment is under way`);
        return 'busy';
      }
      const result = await authorize(idToken);
      if (isMasterPass(result.info)) {
        // A Master Pass cannot start a transaction (C12.FR.09), but stops every one.
        if (transactions.size === 0) return 'rejected';
        stopAll(idToken);
        return 'stopping';
      }
      if (!result.ok) {
        log(`connector ${connectorId}: ${token} rejected`);
        hint({
          kind: 'start-failed',
          evseId: connectorId,
          idToken: tokenRef(idToken),
          source: localSource(idToken),
          reason: 'NotAuthorized',
        });
        return 'rejected';
      }
      const claim = claimReservation(connectorId, idToken, result.info?.groupIdToken);
      if (!claim.ok) {
        log(`connector ${connectorId}: reserved for another token`);
        hint({
          kind: 'start-failed',
          evseId: connectorId,
          idToken: tokenRef(idToken),
          source: localSource(idToken),
          reason: 'NotAuthorized',
          detail: 'reserved for another token',
        });
        return 'rejected';
      }
      authorizations.set(connectorId, {
        idToken,
        ...(result.info !== undefined && { info: result.info }),
        ...(claim.reservationId !== undefined && { reservationId: claim.reservationId }),
      });
      hint({
        kind: 'authorized',
        evseId: connectorId,
        idToken: tokenRef(idToken),
        source: localSource(idToken),
      });
      showTariff(connectorId, result.info);
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
      notifyProblem(connectorId, fault);
      // A fault stops the transactions it affects (E06.FR.16).
      const affected = connectorId === 0 ? [...transactions.keys()] : [connectorId];
      for (const id of affected) {
        if (transactions.has(id)) endTransaction(id, 'AbnormalCondition', 'Other');
        else updatePower(id);
      }
    },

    clearFault(connectorId) {
      const had =
        connectorId === 0
          ? station.fault !== undefined
          : findConnector(station, connectorId)?.fault !== undefined;
      if (applyDevice({ type: 'FaultCleared', connectorId }).error !== undefined) return;
      if (had) notifyProblem(connectorId, undefined);
      for (const connector of connectors(station)) updatePower(connector.connectorId);
    },

    dataTransfer(request) {
      const sent = sendIfOnline('DataTransfer', request as Ocpp21RequestOf<'DataTransfer'>);
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
      const securitySnapshot = security.snapshot();
      const firmwareVersion = security.firmwareVersion();
      return {
        ocpp,
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
            offeredW: reading.offeredW,
            ...((limit) => (limit === undefined ? {} : { limitW: Math.round(limit * 10) / 10 }))(
              profileLimitW(connector.connectorId),
            ),
            ...((message) => (message === undefined ? {} : { display: message }))(
              displays.get(connector.connectorId),
            ),
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
        ...(firmwareVersion !== undefined && { firmwareVersion }),
        ...securitySnapshot,
        diagnosticsStatus: 'Idle',
        signedFirmwareStatus: securitySnapshot.firmwareStatus,
        behaviour: { ...behaviour },
        energyMultiplier: energy.multiplier,
        localList: { version: localList.version, size: Object.keys(localList.entries).length },
        reservations: reservations.map((r) => ({
          reservationId: r.id,
          connectorId: r.evseId ?? 0,
          idTag: r.idToken.idToken,
          expiryDate: new Date(r.expiresAt).toISOString(),
        })),
        chargingProfiles: chargingProfiles.map((p) => ({
          chargingProfileId: p.profile.id,
          connectorId: p.evseId,
          purpose: p.profile.chargingProfilePurpose,
          stackLevel: p.profile.stackLevel,
        })),
      };
    },

    priorityCharging(evseId, activate) {
      if (!v21) return 'not-2.1';
      if (!transactions.has(evseId)) return 'no-transaction';
      if (activate && !hasPriorityProfile(evseId)) {
        log(`EVSE ${evseId}: no PriorityCharging profile`);
        return 'no-profile';
      }
      setPriority(evseId, activate);
      return activate ? 'activated' : 'deactivated';
    },

    changeEvNeeds(evseId, changes) {
      const ev = energy.ev(evseId);
      if (ev === undefined) return 'no-ev';
      const profile: EvProfile = { ...ev.state.profile };
      for (const key of ['targetSoc', 'departureMinutes', 'minimumSoc'] as const) {
        if (changes[key] !== undefined) profile[key] = changes[key];
      }
      energy.changeEv(evseId, profile);
      updatePower(evseId);
      changed();
      // ISO 15118-20 needs that went out already are sent again (K20.FR.01).
      const reported = !needsDue.has(evseId) && !needsWaiting.has(evseId);
      if (!v21 || profile.communication !== 'iso15118-20' || !reported) return 'changed';
      if (!transactions.has(evseId) && !authorizations.has(evseId)) return 'changed';
      sendChargingNeeds(evseId, pluggedAtOf.get(evseId) ?? now());
      return 'reported';
    },

    presentPaymentCard: (evseId, card = {}) => presentPaymentCard(evseId, card),
    stopPayment,
    validateVatNumber,
    webPaymentUrl: (evseId, limits = {}) => paymentUrl(evseId, limits),

    persistentState(): PersistedChargePoint201 {
      return {
        version: 1,
        ocpp,
        ...(defaultTariffs.length > 0 && { tariffs: defaultTariffs.map((e) => ({ ...e })) }),
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
          ...(v21 && {
            chargingState: currentChargingState(connectorId),
            ...(tx.limits !== undefined && { limits: { ...tx.limits } as Record<string, number> }),
          }),
          ...(v21 && evOf(connectorId) !== undefined && { ev: evOf(connectorId) as PluggedEv }),
          ...(tx.cost !== undefined && { cost: tx.cost.snapshot() }),
        })),
        authCache,
        localList,
        security: security.persistent(),
        chargingProfiles: chargingProfiles.map((p) => ({ ...p })),
        reservations: reservations.map((r) => ({ ...r })),
        ...(payments.size > 0 && {
          payments: [...payments.values()].map((p) => {
            const tx = [...transactions.values()].find((t) => t.id === p.transactionId);
            const cost = tx === undefined ? undefined : (costOf(tx) ?? undefined);
            return { ...p, ...(cost !== undefined && { lastCost: roundCents(cost) }) };
          }),
        }),
      };
    },

    deviceModelView(): DeviceModelEntry[] {
      return deviceModel.definitions().map((d) => {
        const component = componentKey(d.component);
        const variable = variableKey(d.variable);
        return {
          component,
          variable,
          dataType: d.dataType,
          ...(d.unit !== undefined && { unit: d.unit }),
          ...(d.valuesList !== undefined && { valuesList: d.valuesList }),
          ...(d.minLimit !== undefined && { minLimit: d.minLimit }),
          ...(d.maxLimit !== undefined && { maxLimit: d.maxLimit }),
          attributes: Object.entries(d.attributes).map(([type, attribute]) => {
            const value =
              attribute.mutability === 'WriteOnly'
                ? undefined
                : deviceModel.get(component, variable, type as AttributeEnumType);
            return {
              type,
              mutability: attribute.mutability,
              ...(value !== undefined && { value }),
            };
          }),
        };
      });
    },

    setVariable(componentText, variableText, value) {
      const component = parseComponentKey(componentText);
      const variable = parseVariableKey(variableText);
      if (component === undefined || variable === undefined) return { status: 'UnknownVariable' };
      const { results, changed: keys } = deviceModel.setVariables([
        { component, variable, attributeValue: value },
      ]);
      for (const key of keys) variableChanged(key);
      if (keys.length > 0) {
        log(`${componentText}.${variableText} set locally`);
        changed();
      }
      const [result] = results;
      return {
        status: result?.attributeStatus ?? 'Rejected',
        ...(result?.attributeStatusInfo?.additionalInfo !== undefined && {
          reason: result.attributeStatusInfo.additionalInfo,
        }),
      };
    },

    connectionSecurity: () => security.connectionSecurity(),

    securityEvent: (type, techInfo) => security.securityEvent(type, techInfo),

    connectionFailed: () => security.connectionFailed(),
  };
  return chargePoint;
}
