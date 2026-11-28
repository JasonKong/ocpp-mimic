/**
 * Security of a 2.0.1 station: the Basic Auth password (A01), certificates
 * (A02, A03, M03 to M05), the security log and SecurityEventNotification
 * (A04), network connection profiles and the Security Profile upgrade (A05,
 * B09, B10), firmware updates (L01, L02) and log uploads (N01). It does for a
 * 2.0.1 station what the Security Whitepaper code does for a 1.6 one, reusing
 * the same pure pieces (certificates, security events, firmware settings).
 *
 * Pure, like the station: X.509 work comes from the injected
 * CertificateTools, transfers from the injected FileTransfer.
 */
import type { ChargePointBehaviour } from '../charge-point.js';
import type { ChargePointCertificate, CertificateTools } from '../certificates.js';
import { sameCertificate } from '../certificates.js';
import {
  DEFAULT_FIRMWARE_SETTINGS,
  firmwareVersionFrom,
  isHttpLocation,
  logUploadUrl,
  type FileTransfer,
  type FirmwareSettings,
} from '../firmware.js';
import type { RpcOutcome } from '../rpc.js';
import {
  SECURITY_LOG_LENGTH,
  securityLogContent,
  type SecurityLogEntry,
} from '../security-events.js';
import type { StationTimers } from '../station-timers.js';
import type {
  CertificateHashDataType,
  FirmwareStatusEnumType,
  InstallCertificateUseEnumType,
  Ocpp21RequestOf,
  Ocpp21ResponseOf,
  UploadLogStatusEnumType,
} from '../ocpp21/messages.js';
import { NETWORK_SLOTS } from './standard-variables.js';

/** The 2.0.1 security events (Part 2 appendix 1) and whether each is critical. */
export const SECURITY_EVENTS_201 = {
  FirmwareUpdated: true,
  FailedToAuthenticateAtCsms: false,
  CsmsFailedToAuthenticate: false,
  SettingSystemTime: true,
  StartupOfTheDevice: true,
  ResetOrReboot: true,
  SecurityLogWasCleared: true,
  ReconfigurationOfSecurityParameters: false,
  MemoryExhaustion: true,
  InvalidMessages: false,
  AttemptedReplayAttacks: false,
  TamperDetectionActivated: true,
  InvalidFirmwareSignature: true,
  InvalidFirmwareSigningCertificate: true,
  InvalidCsmsCertificate: true,
  InvalidChargingStationCertificate: true,
  InvalidTLSVersion: true,
  InvalidTLSCipherSuite: true,
  MaintenanceLoginAccepted: true,
  MaintenanceLoginFailed: true,
} as const;

/** The 1.6 whitepaper names 2.0.1 renamed; the transport reports connection problems in 1.6 terms. */
const RENAMED: Readonly<Record<string, string>> = {
  FailedToAuthenticateAtCentralSystem: 'FailedToAuthenticateAtCsms',
  CentralSystemFailedToAuthenticate: 'CsmsFailedToAuthenticate',
  InvalidCentralSystemCertificate: 'InvalidCsmsCertificate',
  InvalidChargePointCertificate: 'InvalidChargingStationCertificate',
};

/** Whether a 2.0.1 event goes to the CSMS; events the appendix does not list (a vendor's) do. */
export function isCriticalSecurityEvent201(type: string): boolean {
  return (SECURITY_EVENTS_201 as Record<string, boolean>)[type] ?? true;
}

/** The trust store holds CA certificates of these types. */
export type RootCertificateType = InstallCertificateUseEnumType;

export interface InstalledRoot {
  certificateType: RootCertificateType;
  certificate: string;
}

/** A network connection profile slot (B09): what the station connects with. */
export interface NetworkSlot {
  securityProfile: number;
  /** The CSMS address without the station identity; the station's own address when missing. */
  csmsUrl?: string;
  /** 2.1 (B09): the station identity and Basic Auth password to use with this slot. */
  identity?: string;
  basicAuthPassword?: string;
}

/** What the security part keeps across restarts. */
export interface PersistedSecurity201 {
  securityLog: SecurityLogEntry[];
  installed: InstalledRoot[];
  chargingStation?: ChargePointCertificate;
  /** configurationSlot → profile. */
  slots: Record<string, NetworkSlot>;
  firmwareVersion?: string;
  /** requestId of an update whose Installed is reported after the reboot. */
  installedPendingReport?: number;
  /** 2.1: the requestId of the last CSR, so the next one gets a new one. */
  csrRequestId?: number;
}

type Sent =
  | 'SecurityEventNotification'
  | 'SignCertificate'
  | 'FirmwareStatusNotification'
  | 'LogStatusNotification';

export interface Security201Options {
  timers: StationTimers;
  now(): number;
  log(message: string): void;
  changed(): void;
  /** The station's behaviour switches now, for the failures a CSMS test may ask for. */
  behaviour?: () => Pick<
    ChargePointBehaviour,
    'failCertificates' | 'refuseLogs' | 'failNetworkProfile'
  >;
  /** Reads and writes Device Model values. */
  get(component: string, variable: string): string | undefined;
  set(component: string, variable: string, value: string): void;
  /** Sends when registered; undefined otherwise. */
  send<A extends Sent>(
    action: A,
    payload: Ocpp21RequestOf<A>,
  ): Promise<RpcOutcome<Ocpp21ResponseOf<A>>> | undefined;
  /** Queues a SecurityEventNotification with guaranteed delivery. */
  enqueue(payload: Ocpp21RequestOf<'SecurityEventNotification'>): void;
  tools?: CertificateTools | undefined;
  transfer?: FileTransfer | undefined;
  firmware?: Partial<FirmwareSettings> | undefined;
  /** The firmware version the station boots with (its persona's). */
  firmwareVersion?: string | undefined;
  /** Certificates a new station starts with. */
  seeds?:
    | {
        csmsRoots?: readonly string[];
        manufacturerRoots?: readonly string[];
        chargingStation?: ChargePointCertificate;
      }
    | undefined;
  /** The CN of a CSR (the serial number). */
  commonName: string;
  /** Most certificates installed at once (CertificateEntries maxLimit). */
  maxCertificates: number;
  restore?: PersistedSecurity201 | undefined;
  /** Reconnects at once with connectionSecurity(). */
  reconnect(): void;
  /** Reboots to activate installed firmware. */
  reboot(): void;
  /** Resolves when no transaction runs. */
  noTransactions(): Promise<void>;
  /** The station's state as text, for a diagnostics log. */
  diagnostics(): string;
  /** OCPP 2.1: CSR requestIds, the downgrade to profile 2 and per-slot credentials (A02, A05, B09). */
  v21?: boolean;
}

export interface ConnectionSecurity201 {
  profile: number;
  authorizationKey?: string;
  centralSystemRoots: string[];
  chargePointCertificate?: ChargePointCertificate;
  /** The network profile's CSMS address, when it has one. */
  csmsUrl?: string;
}

interface Handlers {
  InstallCertificate(
    r: Ocpp21RequestOf<'InstallCertificate'>,
  ): Ocpp21ResponseOf<'InstallCertificate'>;
  GetInstalledCertificateIds(
    r: Ocpp21RequestOf<'GetInstalledCertificateIds'>,
  ): Ocpp21ResponseOf<'GetInstalledCertificateIds'>;
  DeleteCertificate(r: Ocpp21RequestOf<'DeleteCertificate'>): Ocpp21ResponseOf<'DeleteCertificate'>;
  CertificateSigned(r: Ocpp21RequestOf<'CertificateSigned'>): Ocpp21ResponseOf<'CertificateSigned'>;
  SetNetworkProfile(r: Ocpp21RequestOf<'SetNetworkProfile'>): Ocpp21ResponseOf<'SetNetworkProfile'>;
  UpdateFirmware(r: Ocpp21RequestOf<'UpdateFirmware'>): Ocpp21ResponseOf<'UpdateFirmware'>;
  GetLog(r: Ocpp21RequestOf<'GetLog'>): Ocpp21ResponseOf<'GetLog'>;
}

export type SecurityTrigger =
  'FirmwareStatusNotification' | 'LogStatusNotification' | 'SignChargingStationCertificate';

export interface Security201 {
  securityEvent(type: string, techInfo?: string): void;
  connectionSecurity(): ConnectionSecurity201;
  /** A connection opened: the profile, root and certificate in use proved themselves. */
  connected(): void;
  /** A connection attempt failed before it opened. */
  connectionFailed(): void;
  /** The station reboots: it starts again with the first entry of NetworkConfigurationPriority. */
  rebooting(): void;
  /** The CSMS accepted the boot: report a firmware update the reboot finished. */
  bootAccepted(): void;
  /** A Device Model value changed by SetVariables. */
  variableChanged(key: string): void;
  /** Why SetVariables may not set `component/variable` to `value`, or undefined. */
  checkVariable(key: string, value: string): string | undefined;
  /** Dynamic Device Model values this part knows. */
  read(key: string): string | undefined;
  handlers: Handlers;
  /** Senders for TriggerMessage. */
  triggers: Partial<Record<SecurityTrigger, () => void>>;
  firmwareVersion(): string | undefined;
  snapshot(): {
    firmwareStatus: string;
    logStatus: string;
    certificates: { centralSystemRoots: number; manufacturerRoots: number; chargePoint: boolean };
    securityEvents: SecurityLogEntry[];
  };
  persistent(): PersistedSecurity201;
}

const PRIORITY = ['OCPPCommCtrlr', 'NetworkConfigurationPriority'] as const;

export function createSecurity201(options: Security201Options): Security201 {
  const { timers, now, log, changed, get, set, tools } = options;
  const { later, delay } = timers;
  const settings: FirmwareSettings = { ...DEFAULT_FIRMWARE_SETTINGS, ...options.firmware };
  const restored = options.restore;
  const int = (component: string, variable: string) => Number(get(component, variable) ?? '0');
  const securityProfile = () => int('SecurityCtrlr', 'SecurityProfile');

  // ---- Security log and events (A04) --------------------------------------

  let securityLog: SecurityLogEntry[] = [...(restored?.securityLog ?? [])];

  function securityEvent(name: string, techInfo?: string): void {
    const type = RENAMED[name] ?? name;
    const entry: SecurityLogEntry = {
      type,
      timestamp: new Date(now()).toISOString(),
      ...(techInfo !== undefined && { techInfo: techInfo.slice(0, 255) }),
    };
    securityLog = [...securityLog, entry].slice(-SECURITY_LOG_LENGTH);
    log(`security event ${type}${techInfo === undefined ? '' : ` (${techInfo})`}`);
    // Critical events are delivered for sure, queued while offline (A04.FR.01, .02).
    if (isCriticalSecurityEvent201(type)) {
      options.enqueue({
        type: type.slice(0, 50),
        timestamp: entry.timestamp,
        ...(entry.techInfo !== undefined && { techInfo: entry.techInfo }),
      });
    }
    changed();
  }

  // ---- Certificates (A02, A03, M03 to M05) --------------------------------

  let installed: InstalledRoot[] = restored
    ? restored.installed.map((c) => ({ ...c }))
    : [
        ...(options.seeds?.csmsRoots ?? []).map((certificate) => ({
          certificateType: 'CSMSRootCertificate' as const,
          certificate,
        })),
        ...(options.seeds?.manufacturerRoots ?? []).map((certificate) => ({
          certificateType: 'ManufacturerRootCertificate' as const,
          certificate,
        })),
      ];
  let own: ChargePointCertificate | undefined = restored
    ? restored.chargingStation
    : options.seeds?.chargingStation;
  /** The certificate a renewal replaced, until the new one connected (A02.FR.10). */
  let previousOwn: ChargePointCertificate | undefined;
  /** The CSMS root an AdditionalRootCertificateCheck install replaced, until a connection (M05.FR.12, .13). */
  let fallbackRoot: string | undefined;
  let pendingCsr: { csr: string; privateKey: string; requestId?: number } | undefined;
  /** 2.1: the requestId of the last CSR (A02.FR.24); persisted with the other security state. */
  let csrRequestId = restored?.csrRequestId ?? 0;
  let csrTimer: ReturnType<StationTimers['later']> | undefined;

  const rootsOf = (type: RootCertificateType) =>
    installed.filter((c) => c.certificateType === type).map((c) => c.certificate);
  const hashOf = (certificate: string): CertificateHashDataType | undefined =>
    tools?.inspect(
      certificate,
      installed.map((c) => c.certificate),
    )?.hashData as CertificateHashDataType | undefined;
  const sameAs = (target: CertificateHashDataType) => (certificate: string) => {
    const hash = hashOf(certificate);
    return hash !== undefined && sameCertificate(hash, target);
  };
  const certificateCount = () => installed.length + (own === undefined ? 0 : 1);

  function stopCsrTimer(): void {
    timers.stop(csrTimer);
    csrTimer = undefined;
  }

  /** Sends SignCertificate with a CSR, again with back-off until CertificateSigned (A02.FR.17 to .19). */
  function requestCertificate(attempt: number): void {
    stopCsrTimer();
    if (tools === undefined) return;
    if (pendingCsr === undefined) {
      const organization = get('SecurityCtrlr', 'OrganizationName') ?? '';
      pendingCsr = {
        ...tools.createCsr({
          commonName: options.commonName,
          ...(organization !== '' && { organization }),
        }),
        // 2.1: the CSMS echoes it in CertificateSigned (A02.FR.24, .25); resends keep it.
        ...(options.v21 === true && { requestId: ++csrRequestId }),
      };
      log('new key pair generated for a ChargingStationCertificate');
    }
    const csr = pendingCsr.csr;
    const { requestId } = pendingCsr;
    void options
      .send('SignCertificate', {
        csr,
        certificateType: 'ChargingStationCertificate',
        ...(requestId !== undefined && { requestId }),
      })
      ?.then((outcome) => {
        if (!outcome.ok || outcome.payload.status !== 'Accepted') return;
        if (pendingCsr?.csr !== csr) return;
        if (attempt >= int('SecurityCtrlr', 'CertSigningRepeatTimes')) return;
        const waitMs = int('SecurityCtrlr', 'CertSigningWaitMinimum') * 1000 * 2 ** attempt;
        csrTimer = later(waitMs, () => {
          csrTimer = undefined;
          if (pendingCsr?.csr === csr) requestCertificate(attempt + 1);
        });
      });
  }

  // ---- Network profiles and the Security Profile upgrade (A05, B09, B10) --

  /** Slot 0 is how the station was set up: its own address and Security Profile. */
  let slots: Record<string, NetworkSlot> = restored
    ? { ...restored.slots }
    : { '0': { securityProfile: securityProfile() } };
  const parsePriority = (value: string | undefined) =>
    (value ?? '0')
      .split(',')
      .map((slot) => slot.trim())
      .filter((slot) => slot !== '');
  /** NetworkConfigurationPriority as it was at the last reboot: a change waits for one (B10.FR.04). */
  let order = parsePriority(get(...PRIORITY));
  let slotIndex = 0;
  let failures = 0;
  /** The slot of the last connection that worked: the fallback (B10.FR.07). */
  let lastGood = order[0] ?? '0';
  let attemptedSlot: string | undefined;
  const currentSlot = () => order[slotIndex] ?? lastGood;
  const slotOf = (slot: string): NetworkSlot =>
    slots[slot] ?? { securityProfile: securityProfile() };

  /**
   * Whether a slot's Security Profile is too low: lower than the station's,
   * except that 2.1 allows 3 to 2 with SecurityCtrlr.AllowSecurityProfileDowngrade
   * (A05.FR.08 to .10); never down to 1.
   */
  function tooLow(profile: number): boolean {
    const current = securityProfile();
    if (profile >= current) return false;
    return !(
      options.v21 === true &&
      current === 3 &&
      profile === 2 &&
      get('SecurityCtrlr', 'AllowSecurityProfileDowngrade') === 'true'
    );
  }

  /** Why a slot cannot be used now (A05.FR.02, .03), or undefined. */
  function slotProblem(slot: string): string | undefined {
    const profile = slots[slot]?.securityProfile;
    if (profile === undefined) return `network profile ${slot} is not set`;
    if (tooLow(profile)) return `network profile ${slot} has a lower Security Profile`;
    if (
      (profile === 1 || profile === 2) &&
      (slots[slot]?.basicAuthPassword ?? get('SecurityCtrlr', 'BasicAuthPassword') ?? '') === ''
    ) {
      return `Security Profile ${profile} needs a BasicAuthPassword`;
    }
    if (profile >= 2 && rootsOf('CSMSRootCertificate').length === 0) {
      return `Security Profile ${profile} needs a CSMSRootCertificate`;
    }
    if (profile === 3 && own === undefined) {
      return 'Security Profile 3 needs a ChargingStationCertificate';
    }
    return undefined;
  }

  // ---- Firmware (L01, L02) ------------------------------------------------

  let firmwareVersion = restored?.firmwareVersion ?? options.firmwareVersion;
  let firmwareStatus: FirmwareStatusEnumType = 'Idle';
  /** What the last FirmwareStatusNotification said, for TriggerMessage (L01.FR.25, .26). */
  let lastFirmware: { status: FirmwareStatusEnumType; requestId?: number } = { status: 'Idle' };
  let update: { requestId: number; cancelled: boolean } | undefined;
  let installedPendingReport = restored?.installedPendingReport;

  function reportFirmware(status: FirmwareStatusEnumType, requestId: number): void {
    firmwareStatus = status;
    lastFirmware = { status, requestId };
    void options.send('FirmwareStatusNotification', { status, requestId });
    changed();
  }

  async function withRetries(
    attempt: () => Promise<boolean>,
    retries: number | undefined,
    intervalS: number | undefined,
  ): Promise<boolean> {
    for (let n = 0; n <= (retries ?? 0); n++) {
      if (n > 0) await delay((intervalS ?? 30) * 1000);
      if (await attempt()) return true;
    }
    return false;
  }

  async function runFirmwareUpdate(request: Ocpp21RequestOf<'UpdateFirmware'>): Promise<void> {
    const current = { requestId: request.requestId, cancelled: false };
    update = current;
    const { firmware, requestId } = request;
    const finish = (status: FirmwareStatusEnumType) => {
      reportFirmware(status, requestId);
      firmwareStatus = 'Idle';
      if (update === current) update = undefined;
    };
    const waitUntil = async (at: string | undefined, scheduled: FirmwareStatusEnumType) => {
      const ms = at === undefined ? 0 : Date.parse(at) - now();
      if (ms > 0) {
        reportFirmware(scheduled, requestId);
        await delay(ms);
      }
    };
    await waitUntil(firmware.retrieveDateTime, 'DownloadScheduled');
    if (current.cancelled) return;
    reportFirmware('Downloading', requestId);
    let image: Uint8Array | undefined;
    const downloaded = await withRetries(
      async () => {
        if (current.cancelled) return true;
        if (options.transfer !== undefined && isHttpLocation(firmware.location)) {
          image = await options.transfer.download(firmware.location);
          return image !== undefined;
        }
        await delay(settings.downloadMs);
        return settings.download === 'succeed';
      },
      request.retries,
      request.retryInterval,
    );
    if (current.cancelled) return;
    if (!downloaded) return finish('DownloadFailed');
    reportFirmware('Downloaded', requestId);
    // Signed firmware is checked against its signature (L01.FR.04); unsigned firmware is L02.
    if (firmware.signature !== undefined && firmware.signingCertificate !== undefined) {
      const verified =
        image !== undefined && tools !== undefined
          ? tools.verifySignature(image, firmware.signature, firmware.signingCertificate)
          : settings.signature === 'succeed';
      if (!verified) {
        finish('InvalidSignature');
        securityEvent('InvalidFirmwareSignature', firmware.location.slice(0, 200));
        return;
      }
      reportFirmware('SignatureVerified', requestId);
    }
    await waitUntil(firmware.installDateTime, 'InstallScheduled');
    // Installing waits for the transactions to end (L01.FR.06).
    await options.noTransactions();
    if (current.cancelled) return;
    reportFirmware('Installing', requestId);
    await delay(settings.installMs);
    if (current.cancelled) return;
    if (settings.install === 'fail') return finish('InstallationFailed');
    if (settings.installVerification === 'fail') return finish('InstallVerificationFailed');
    firmwareVersion = firmwareVersionFrom(firmware.location, firmwareVersion);
    // The new firmware reports Installed after the reboot (L01.FR.32 a).
    installedPendingReport = requestId;
    reportFirmware('InstallRebooting', requestId);
    log(`firmware ${firmwareVersion} installed; rebooting`);
    update = undefined;
    options.reboot();
  }

  // ---- Logs (N01) -----------------------------------------------------------

  let logUpload: { requestId: number; cancelled: boolean } | undefined;
  let logStatus: UploadLogStatusEnumType = 'Idle';

  function reportLog(status: UploadLogStatusEnumType, requestId: number): void {
    logStatus = status;
    void options.send('LogStatusNotification', { status, requestId });
    changed();
  }

  async function runLogUpload(request: Ocpp21RequestOf<'GetLog'>, fileName: string): Promise<void> {
    const upload = { requestId: request.requestId, cancelled: false };
    logUpload = upload;
    const content =
      request.logType === 'SecurityLog'
        ? securityLogContent(securityLog, request.log)
        : options.diagnostics();
    reportLog('Uploading', upload.requestId);
    const location = request.log.remoteLocation;
    const uploaded = await withRetries(
      async () => {
        if (upload.cancelled) return true;
        if (options.transfer !== undefined && isHttpLocation(location)) {
          return options.transfer.upload(logUploadUrl(location, fileName), fileName, content);
        }
        await delay(settings.uploadMs);
        return settings.upload === 'succeed';
      },
      request.retries,
      request.retryInterval,
    );
    if (upload.cancelled) return;
    reportLog(uploaded ? 'Uploaded' : 'UploadFailure', upload.requestId);
    logStatus = 'Idle';
    logUpload = undefined;
  }

  // ---- Messages from the CSMS ---------------------------------------------

  const handlers: Handlers = {
    InstallCertificate(request) {
      if (tools === undefined || options.behaviour?.().failCertificates === true) {
        return { status: 'Failed' };
      }
      const type = request.certificateType;
      const info = tools.inspect(request.certificate);
      if (info === undefined || now() < info.validFrom || now() > info.validTo) {
        return { status: 'Rejected' };
      }
      const entry = { certificateType: type, certificate: request.certificate };
      const existing = installed.find(
        (c) => c.certificateType === type && sameAs(info.hashData)(c.certificate),
      );
      const csmsRoots = rootsOf('CSMSRootCertificate');
      if (
        type === 'CSMSRootCertificate' &&
        get('SecurityCtrlr', 'AdditionalRootCertificateCheck') === 'true' &&
        csmsRoots.length > 0 &&
        existing === undefined
      ) {
        // One CSMS root, replaced by one it signed; the old one stays as a fallback (M05.FR.10 to .12).
        if (!csmsRoots.some((root) => tools.verifyChain(request.certificate, [root], now()))) {
          return { status: 'Rejected' };
        }
        fallbackRoot = csmsRoots[0];
        installed = [...installed.filter((c) => c.certificateType !== type), entry];
      } else if (existing !== undefined) {
        // Already there: replaced (M05.FR.17).
        installed = installed.map((c) => (c === existing ? entry : c));
      } else {
        // CertificateEntries.maxLimit (M05.FR.06).
        if (certificateCount() >= options.maxCertificates) return { status: 'Rejected' };
        installed = [...installed, entry];
      }
      log(`${type} installed`);
      changed();
      return { status: 'Accepted' };
    },

    GetInstalledCertificateIds(request) {
      const wanted = request.certificateType as readonly string[] | undefined;
      const chains = installed
        .filter((c) => wanted === undefined || wanted.includes(c.certificateType))
        .flatMap((c) => {
          const hash = hashOf(c.certificate);
          return hash === undefined
            ? []
            : [{ certificateType: c.certificateType, certificateHashData: hash }];
        });
      const [first, ...rest] = chains;
      return first === undefined
        ? { status: 'NotFound' }
        : { status: 'Accepted', certificateHashDataChain: [first, ...rest] };
    },

    DeleteCertificate(request) {
      if (tools === undefined || options.behaviour?.().failCertificates === true) {
        return { status: 'Failed' };
      }
      const matches = sameAs(request.certificateHashData);
      // The station's own certificate cannot be deleted with OCPP (M04.FR.06).
      if (own !== undefined && matches(own.certificate)) return { status: 'Failed' };
      const found = installed.find((c) => matches(c.certificate));
      if (found === undefined) return { status: 'NotFound' };
      // The last CSMS root stays while the profile in use needs it (M04.FR.03 allows refusing).
      if (
        found.certificateType === 'CSMSRootCertificate' &&
        rootsOf('CSMSRootCertificate').length === 1 &&
        slotOf(currentSlot()).securityProfile >= 2
      ) {
        return { status: 'Failed' };
      }
      installed = installed.filter((c) => c !== found);
      log(`${found.certificateType} deleted`);
      changed();
      return { status: 'Accepted' };
    },

    CertificateSigned(request) {
      const reject = (reason: string) => {
        log(`CertificateSigned rejected: ${reason}`);
        // No retry until the CSMS triggers one (A02.FR.20).
        pendingCsr = undefined;
        stopCsrTimer();
        securityEvent('InvalidChargingStationCertificate', reason);
        return { status: 'Rejected' as const };
      };
      if (
        request.certificateType !== undefined &&
        request.certificateType !== 'ChargingStationCertificate'
      ) {
        return reject(`${request.certificateType} is not supported`);
      }
      if (tools === undefined) return reject('no certificate support');
      const limit = int('SecurityCtrlr', 'MaxCertificateChainSize');
      if (limit > 0 && request.certificateChain.length > limit) {
        return reject(`certificate chain longer than ${limit}`);
      }
      if (pendingCsr === undefined) return reject('no CSR pending');
      // 2.1: a certificate for another request is refused (A02.FR.26, A03.FR.22).
      if (request.requestId !== undefined && request.requestId !== pendingCsr.requestId) {
        return reject(`unknown requestId ${request.requestId}`);
      }
      if (!tools.verifyChain(request.certificateChain, rootsOf('CSMSRootCertificate'), now())) {
        return reject('not a valid certificate of the CSMS hierarchy');
      }
      if (!tools.matchesKey(request.certificateChain, pendingCsr.privateKey)) {
        return reject('not for the key of the CSR');
      }
      previousOwn = own;
      own = { certificate: request.certificateChain, privateKey: pendingCsr.privateKey };
      pendingCsr = undefined;
      stopCsrTimer();
      log('new ChargingStationCertificate installed');
      securityEvent('ReconfigurationOfSecurityParameters', 'ChargingStationCertificate renewed');
      // In use on profile 3: switch to it by reconnecting (A02.FR.08).
      if (slotOf(currentSlot()).securityProfile === 3) later(0, options.reconnect);
      else previousOwn = undefined;
      changed();
      return { status: 'Accepted' };
    },

    SetNetworkProfile(request) {
      if (options.behaviour?.().failNetworkProfile === true) {
        log('SetNetworkProfile failed (behaviour switch failNetworkProfile)');
        return { status: 'Failed' };
      }
      const { configurationSlot, connectionData } = request;
      const slot = String(configurationSlot);
      const reject = (reason: string) => {
        log(`SetNetworkProfile ${slot} rejected: ${reason}`);
        return { status: 'Rejected' as const };
      };
      if (!(NETWORK_SLOTS as readonly string[]).includes(slot)) {
        return reject('not a configuration slot (B09.FR.05)');
      }
      const profile = connectionData.securityProfile;
      if (tooLow(profile)) return reject('lower Security Profile (B09.FR.04, A05.FR.10)');
      if (profile < 0 || profile > 3) return reject('no such Security Profile');
      // 2.1 makes ocppVersion optional and ignores it (B09).
      if (options.v21 !== true && connectionData.ocppVersion !== 'OCPP20') {
        return reject('not OCPP 2.0');
      }
      if (connectionData.ocppTransport !== 'JSON') return reject('not JSON');
      const url = connectionData.ocppCsmsUrl;
      if (!/^wss?:\/\//i.test(url)) return reject('not a ws:// or wss:// address');
      if (profile >= 2 && !/^wss:\/\//i.test(url)) {
        return reject(`Security Profile ${profile} needs wss://`);
      }
      const { identity, basicAuthPassword } = connectionData;
      slots = {
        ...slots,
        [slot]: {
          securityProfile: profile,
          csmsUrl: url,
          ...(options.v21 === true && identity !== undefined && { identity }),
          ...(options.v21 === true && basicAuthPassword !== undefined && { basicAuthPassword }),
        },
      };
      log(`network profile ${slot} set: ${url}, Security Profile ${profile}`);
      changed();
      return { status: 'Accepted' };
    },

    UpdateFirmware(request) {
      const { firmware } = request;
      if (firmware.signingCertificate !== undefined) {
        // The signing certificate must lead to a manufacturer root (L01.FR.21, .22).
        const valid =
          tools !== undefined &&
          tools.verifyChain(
            firmware.signingCertificate,
            rootsOf('ManufacturerRootCertificate'),
            now(),
          );
        if (!valid) {
          securityEvent('InvalidFirmwareSigningCertificate', firmware.location.slice(0, 200));
          return { status: 'InvalidCertificate' };
        }
      }
      // A new request cancels the one in progress (L01.FR.24).
      const cancelled = update !== undefined;
      if (update !== undefined) update.cancelled = true;
      void runFirmwareUpdate(request);
      return { status: cancelled ? 'AcceptedCanceled' : 'Accepted' };
    },

    GetLog(request) {
      if (options.behaviour?.().refuseLogs === true) return { status: 'Rejected' };
      const kind =
        request.logType === 'SecurityLog'
          ? 'security'
          : request.logType === 'DataCollectorLog'
            ? 'datacollector'
            : 'diagnostics';
      const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
      const fileName = `${kind}-${stamp}.log`;
      // A new request cancels the upload in progress (N01.FR.12).
      const cancelled = logUpload !== undefined;
      if (logUpload !== undefined) logUpload.cancelled = true;
      void runLogUpload(request, fileName);
      return { status: cancelled ? 'AcceptedCanceled' : 'Accepted', filename: fileName };
    },
  };

  return {
    securityEvent,

    connectionSecurity() {
      const slot = currentSlot();
      attemptedSlot = slot;
      const { securityProfile: profile, csmsUrl, basicAuthPassword } = slotOf(slot);
      // 2.1: a slot's own password goes with it (B09.FR.28).
      const key = basicAuthPassword ?? get('SecurityCtrlr', 'BasicAuthPassword') ?? '';
      const roots = rootsOf('CSMSRootCertificate');
      return {
        profile,
        ...(key !== '' && { authorizationKey: key }),
        // The replaced root still verifies the CSMS until a connection worked (M05.FR.14).
        centralSystemRoots: fallbackRoot === undefined ? roots : [...roots, fallbackRoot],
        ...(own !== undefined && { chargePointCertificate: { ...own } }),
        ...(csmsUrl !== undefined && { csmsUrl }),
      };
    },

    connected() {
      failures = 0;
      previousOwn = undefined;
      fallbackRoot = undefined;
      const slot = attemptedSlot ?? currentSlot();
      lastGood = slot;
      const profile = slotOf(slot).securityProfile;
      const before = securityProfile();
      // 2.1: a slot with its own credentials sets them as the station's (B09.FR.28, errata).
      const { identity, basicAuthPassword } = slotOf(slot);
      if (basicAuthPassword !== undefined)
        set('SecurityCtrlr', 'BasicAuthPassword', basicAuthPassword);
      if (identity !== undefined) set('SecurityCtrlr', 'Identity', identity);
      if (profile < before) {
        // An allowed downgrade (A05.FR.08) worked: it is the profile now.
        set('SecurityCtrlr', 'SecurityProfile', String(profile));
        securityEvent(
          'ReconfigurationOfSecurityParameters',
          `Security Profile ${before} to ${profile}`,
        );
      }
      if (profile > before) {
        // The higher profile worked: it is the profile now, and lower slots go (A05.FR.06).
        set('SecurityCtrlr', 'SecurityProfile', String(profile));
        slots = Object.fromEntries(
          Object.entries(slots).filter(([, s]) => s.securityProfile >= profile),
        );
        const kept = parsePriority(get(...PRIORITY)).filter((s) => slots[s] !== undefined);
        set(...PRIORITY, kept.join(','));
        order = order.filter((s) => slots[s] !== undefined);
        slotIndex = Math.max(0, order.indexOf(slot));
        securityEvent(
          'ReconfigurationOfSecurityParameters',
          `SecurityProfile ${before} to ${profile}`,
        );
      }
      changed();
    },

    connectionFailed() {
      if (previousOwn !== undefined) {
        // The renewed certificate does not work: back to the old one (A02.FR.10).
        own = previousOwn;
        previousOwn = undefined;
        log('could not connect with the renewed ChargingStationCertificate; back to the old one');
        options.reconnect();
        return;
      }
      if (slotIndex >= order.length) return; // already on the fallback
      failures += 1;
      // NetworkProfileConnectionAttempts per slot (B10.FR.03).
      if (failures < Math.max(1, int('OCPPCommCtrlr', 'NetworkProfileConnectionAttempts'))) return;
      const failed = currentSlot();
      failures = 0;
      slotIndex += 1;
      const next = currentSlot();
      if (next === failed) return;
      log(
        slotIndex < order.length
          ? `could not connect with network profile ${failed}; trying ${next}`
          : `could not connect with any network profile; back to ${next}`,
      );
      options.reconnect();
    },

    rebooting() {
      order = parsePriority(get(...PRIORITY));
      slotIndex = 0;
      failures = 0;
      securityEvent('ResetOrReboot');
    },

    bootAccepted() {
      if (installedPendingReport === undefined) return;
      reportFirmware('Installed', installedPendingReport);
      installedPendingReport = undefined;
      firmwareStatus = 'Idle';
      securityEvent('FirmwareUpdated', `firmware ${firmwareVersion ?? 'unknown'}`);
    },

    variableChanged(key) {
      if (key === 'SecurityCtrlr/BasicAuthPassword') {
        // Logged, never with the password (A01.FR.11, .12); the next connection uses it.
        securityEvent('ReconfigurationOfSecurityParameters', 'BasicAuthPassword changed');
      }
    },

    checkVariable(key, value) {
      if (key !== PRIORITY.join('/')) return undefined;
      // Every slot must hold a usable profile (B10.FR.02, A05.FR.02, .03).
      for (const slot of parsePriority(value)) {
        const problem = slotProblem(slot);
        if (problem !== undefined) return problem;
      }
      return undefined;
    },

    read(key) {
      if (key === 'OCPPCommCtrlr/ActiveNetworkProfile') return currentSlot();
      // 2.1: the NetworkConfiguration component of each slot (B09.FR.08), ReadOnly (B09.FR.10).
      const network = /^NetworkConfiguration:(\d+)\/(\w+)$/.exec(key);
      if (network !== null) {
        const [, slot = '', variable] = network;
        const config = slots[slot];
        if (config === undefined) return '';
        const values: Record<string, string> = {
          OcppCsmsUrl: config.csmsUrl ?? '',
          OcppInterface: 'Wired0',
          OcppTransport: 'JSON',
          OcppVersion: 'OCPP21',
          MessageTimeout: get('OCPPCommCtrlr', 'MessageTimeout') ?? '',
          SecurityProfile: String(config.securityProfile),
          Identity: config.identity ?? '',
          VpnEnabled: 'false',
          ApnEnabled: 'false',
        };
        return values[variable ?? ''];
      }
      if (key === 'SecurityCtrlr/CertificateEntries') return String(certificateCount());
      return undefined;
    },

    handlers,

    triggers: {
      FirmwareStatusNotification: () => {
        // The last status sent, or Idle after Installed (L01.FR.25, .26).
        const status = lastFirmware.status === 'Installed' ? 'Idle' : lastFirmware.status;
        void options.send('FirmwareStatusNotification', {
          status,
          ...(status !== 'Idle' &&
            lastFirmware.requestId !== undefined && { requestId: lastFirmware.requestId }),
        });
      },
      LogStatusNotification: () =>
        void options.send('LogStatusNotification', {
          status: logUpload === undefined ? 'Idle' : logStatus,
          ...(logUpload !== undefined && { requestId: logUpload.requestId }),
        }),
      ...(tools !== undefined && {
        SignChargingStationCertificate: () => {
          pendingCsr = undefined;
          requestCertificate(0);
        },
      }),
    },

    firmwareVersion: () => firmwareVersion,

    snapshot: () => ({
      firmwareStatus,
      logStatus,
      certificates: {
        centralSystemRoots: rootsOf('CSMSRootCertificate').length,
        manufacturerRoots: rootsOf('ManufacturerRootCertificate').length,
        chargePoint: own !== undefined,
      },
      securityEvents: securityLog.slice(-20).map((entry) => ({ ...entry })),
    }),

    persistent: () => ({
      securityLog: securityLog.map((entry) => ({ ...entry })),
      installed: installed.map((c) => ({ ...c })),
      ...(own !== undefined && { chargingStation: { ...own } }),
      slots: { ...slots },
      ...(firmwareVersion !== undefined &&
        firmwareVersion !== options.firmwareVersion && { firmwareVersion }),
      ...(installedPendingReport !== undefined && { installedPendingReport }),
      ...(csrRequestId > 0 && { csrRequestId }),
    }),
  };
}
