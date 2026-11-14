/**
 * Fleet Manager: creates virtual charge points from personas, wires each to
 * its CSMS through a transport, starts and stops them, and keeps their state
 * in the State Store so they survive an engine restart.
 */
import { readFileSync } from 'node:fs';
import {
  configInt,
  createChargePoint,
  createConfig,
  type ChargePoint,
  type ChargePointEvent,
  type ChargePointSnapshot,
  type Clock,
  type ConnectionSecurity,
  type IdGenerator,
  type InjectionRequest,
  type PersistedChargePoint,
  type ResolvedPersona,
} from '@ocpp-mimic/core';
import {
  createFaultInjector,
  type ActiveInjection,
  type FaultInjector,
  type WireDirection,
} from './fault-injector.js';
import { createHttpFileTransfer } from './file-transfer.js';
import { createCertificateTools } from './x509.js';
import type { PersonaRegistry } from './personas.js';
import type { StateStore, StationDefinition, StationSecurity } from './state-store.js';
import { createSystemClock, randomIds } from './system-clock.js';
import {
  createTransport,
  type BackoffPolicy,
  type ConnectionSettings,
  type Transport,
  type TransportEvent,
  type TransportState,
} from './transport.js';

/** CSMS addresses allowed by default: this machine only. */
export const DEFAULT_ALLOWED_CSMS = [
  'ws://127.0.0.1',
  'ws://localhost',
  'ws://[::1]',
  'wss://127.0.0.1',
  'wss://localhost',
  'wss://[::1]',
];

export type FleetEvent =
  | { stationId: string; type: 'charge-point'; event: ChargePointEvent }
  | { stationId: string; type: 'transport'; event: TransportEvent }
  /** The station's active fault injections changed. */
  | { stationId: string; type: 'injections' }
  /**
   * A frame on the wire, after the Fault Injector: `injected` names the
   * injection that changed or made it, `dropped` marks one that never reached
   * the other side.
   */
  | {
      stationId: string;
      type: 'frame';
      direction: WireDirection;
      text: string;
      injected?: string;
      dropped?: boolean;
    };

export interface StationSnapshot extends ChargePointSnapshot {
  id: string;
  persona: string;
  csmsUrl: string;
  running: boolean;
  transport: TransportState;
  /** Fault injections active on the station. */
  injections: ActiveInjection[];
  /** Why the last connection attempt failed, until a connection opens. */
  connectionError?: string;
}

export interface VirtualStation {
  readonly id: string;
  readonly definition: StationDefinition;
  readonly persona: ResolvedPersona;
  readonly chargePoint: ChargePoint;
  readonly transport: Transport;
  readonly injector: FaultInjector;
  readonly running: boolean;
  snapshot(): StationSnapshot;
}

export interface FleetOptions {
  personas: PersonaRegistry;
  store?: StateStore;
  clock?: Clock;
  ids?: IdGenerator;
  /** CSMS URL prefixes a station may connect to. Default: loopback addresses only. */
  allowedCsms?: readonly string[];
  backoff?: Partial<BackoffPolicy>;
  /** How often every running station's state (meters included) is saved. Default 10 s. */
  saveIntervalMs?: number;
  onEvent?: (event: FleetEvent) => void;
}

export interface Fleet {
  /** Adds a station; it starts unless `start` is false. Throws on invalid definitions. */
  add(definition: StationDefinition, options?: { start?: boolean }): VirtualStation;
  get(id: string): VirtualStation | undefined;
  list(): VirtualStation[];
  start(id: string): void;
  stop(id: string): Promise<void>;
  /** Stops a station and deletes it from the store. */
  remove(id: string): Promise<void>;
  /** Recreates and starts every station in the store with its saved state. */
  restore(): Promise<VirtualStation[]>;
  /** Saves every station and closes all connections. */
  shutdown(): Promise<void>;
  /** A reconnect storm: every running station drops its connection and reconnects at once. */
  reconnectStorm(): void;
  /**
   * Starts a fault injection on a station: wire faults go to its Fault
   * Injector, meter faults to the charge point, a power loss is carried out
   * here, and a reconnect storm hits every station.
   */
  inject(id: string, request: InjectionRequest): void;
}

/** True when `url` starts with one of `allowed` at a boundary (end, ':', '/' or '?'). */
export function isAllowedCsms(url: string, allowed: readonly string[]): boolean {
  return allowed.some((prefix) => {
    const normalized = prefix.replace(/\/+$/, '');
    if (!url.startsWith(normalized)) return false;
    const next = url.charAt(normalized.length);
    return next === '' || next === ':' || next === '/' || next === '?';
  });
}

interface Entry {
  station: VirtualStation;
  running: boolean;
}

export function createFleet(options: FleetOptions): Fleet {
  const clock = options.clock ?? createSystemClock();
  const ids = options.ids ?? randomIds;
  const certificateTools = createCertificateTools();
  const allowed = options.allowedCsms ?? DEFAULT_ALLOWED_CSMS;
  const emit = options.onEvent ?? (() => {});
  const entries = new Map<string, Entry>();
  const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
  /** Set by shutdown(): stopping connections still emits changes, which must not schedule saves. */
  let shuttingDown = false;

  function save(id: string): void {
    const entry = entries.get(id);
    if (entry === undefined || options.store === undefined) return;
    options.store.saveState(id, entry.station.chargePoint.persistentState());
  }

  /** Coalesces the many 'changed' events of a burst into one write. */
  function scheduleSave(id: string): void {
    if (options.store === undefined || shuttingDown || pendingSaves.has(id)) return;
    pendingSaves.set(
      id,
      setTimeout(() => {
        pendingSaves.delete(id);
        save(id);
      }, 50),
    );
  }

  const saveTimer =
    options.store === undefined
      ? undefined
      : setInterval(() => {
          for (const [id, entry] of entries) if (entry.running) save(id);
        }, options.saveIntervalMs ?? 10_000);
  saveTimer?.unref();

  function build(
    definition: StationDefinition,
    restore?: PersistedChargePoint,
    replace = false,
  ): VirtualStation {
    if (!replace && entries.has(definition.id))
      throw new Error(`station ${definition.id} already exists`);
    if (!isAllowedCsms(definition.csmsUrl, allowed)) {
      throw new Error(
        `CSMS address ${definition.csmsUrl} is not allowed (allowed: ${allowed.join(', ')})`,
      );
    }
    const persona = options.personas.get(definition.persona);
    if (persona === undefined) throw new Error(`unknown persona ${definition.persona}`);
    const { options: personaOptions } = persona;
    const configValues: Record<string, string> = {
      ...personaOptions.config?.values,
      ...(definition.password !== undefined && { AuthorizationKey: definition.password }),
      ...(definition.security?.profile !== undefined && {
        SecurityProfile: String(definition.security.profile),
      }),
      ...definition.config,
    };
    const pem = readStationCertificates(definition.security);
    // Throws on invalid overrides, before anything starts.
    const config = createConfig({
      numberOfConnectors: personaOptions.connectors,
      values: configValues,
    });

    // The transport's callbacks need the charge point, which needs the transport's send().
    const holder: { chargePoint?: ChargePoint } = {};
    let connectionError: string | undefined;
    /** Security events already recorded for this run of failed attempts (sent once, A00.FR.315). */
    const reported = new Set<string>();
    const transport = createTransport({
      url: definition.csmsUrl,
      chargeBoxId: definition.id,
      connectionSettings: () =>
        holder.chargePoint === undefined
          ? {}
          : connectionSettings(definition.csmsUrl, holder.chargePoint.connectionSecurity()),
      onConnectFailed: () => holder.chargePoint?.connectionFailed(),
      pingIntervalMs: configInt(config, 'WebSocketPingInterval') * 1000,
      ...(options.backoff !== undefined && { backoff: options.backoff }),
      onText: (text) => injector.incoming(text),
      onOpen: () => holder.chargePoint?.connected(),
      onClose: () => holder.chargePoint?.disconnected(),
      onEvent: (event) => {
        if (event.type === 'error') {
          connectionError = event.message;
          const type = securityEventFor(event.message);
          if (type !== undefined && !reported.has(type)) {
            reported.add(type);
            holder.chargePoint?.securityEvent(type, event.message);
          }
        }
        if (event.type === 'open') {
          connectionError = undefined;
          reported.clear();
        }
        emit({ stationId: definition.id, type: 'transport', event });
      },
    });
    const frame = (direction: WireDirection, text: string, injected?: string, dropped = false) =>
      emit({
        stationId: definition.id,
        type: 'frame',
        direction,
        text,
        ...(injected !== undefined && { injected }),
        ...(dropped && { dropped }),
      });
    const injector = createFaultInjector({
      toCsms: (text, injected) => {
        frame('cp-to-csms', text, injected);
        transport.send(text);
      },
      toChargePoint: (text) => {
        frame('csms-to-cp', text);
        holder.chargePoint?.receive(text);
      },
      swallowed: (direction, text, injected) => frame(direction, text, injected, true),
      goOffline: () => transport.goOffline('clean'),
      goOnline: () => transport.goOnline(),
      onChange: () => emit({ stationId: definition.id, type: 'injections' }),
    });
    const cp = createChargePoint({
      ...personaOptions,
      config: { ...personaOptions.config, values: configValues },
      clock,
      ids,
      ...(definition.energyMultiplier !== undefined && {
        energyMultiplier: definition.energyMultiplier,
      }),
      ...(persona.definition.firmware?.transfer === 'real' && {
        transfer: createHttpFileTransfer(),
      }),
      send: (text) => injector.outgoing(text),
      restart: (downtimeMs) => transport.restartAfter(downtimeMs),
      reconnect: () => transport.restartAfter(0),
      // The PEM files are where a new station starts; its saved certificates take over later.
      certificates: {
        centralSystemRoots: pem.ca === undefined ? [] : [pem.ca],
        manufacturerRoots: pem.manufacturerRoot === undefined ? [] : [pem.manufacturerRoot],
        ...(pem.cert !== undefined &&
          pem.key !== undefined && { chargePoint: { certificate: pem.cert, privateKey: pem.key } }),
      },
      certificateTools,
      serialNumber: definition.id,
      onEvent: (event) => {
        if (event.type === 'changed') scheduleSave(definition.id);
        emit({ stationId: definition.id, type: 'charge-point', event });
      },
      ...(restore !== undefined && { restore }),
    });

    holder.chargePoint = cp;
    const station: VirtualStation = {
      id: definition.id,
      definition,
      persona,
      chargePoint: cp,
      transport,
      injector,
      get running() {
        return entries.get(definition.id)?.running ?? false;
      },
      snapshot: () => ({
        ...cp.snapshot(),
        id: definition.id,
        persona: definition.persona,
        csmsUrl: definition.csmsUrl,
        running: station.running,
        transport: transport.state,
        injections: injector.list(),
        ...(connectionError !== undefined && { connectionError }),
      }),
    };
    entries.set(definition.id, { station, running: false });
    return station;
  }

  /**
   * Power loss: the station goes dark (its state saved, connection dropped)
   * for `offMs`, then starts again from the saved state, as after a power
   * cut: transactions end with PowerLoss and queued messages keep their
   * timestamps. Repeated `times`, `onMs` apart.
   */
  async function powerLoss(
    id: string,
    { offMs, onMs, times }: { offMs: number; onMs: number; times: number },
  ): Promise<void> {
    for (let cycle = 0; cycle < times; cycle++) {
      const entry = entries.get(id);
      if (entry === undefined || shuttingDown) return;
      const { station } = entry;
      const state = station.chargePoint.persistentState();
      options.store?.saveState(id, state);
      emit({
        stationId: id,
        type: 'charge-point',
        event: { type: 'log', message: `power loss for ${offMs} ms` },
      });
      station.injector.clear();
      entry.running = false;
      await station.transport.stop();
      await new Promise((resolve) => setTimeout(resolve, offMs).unref());
      if (shuttingDown || entries.get(id) !== entry) return;
      build(station.definition, state, true);
      startStation(id);
      if (cycle < times - 1) await new Promise((resolve) => setTimeout(resolve, onMs).unref());
    }
  }

  function startStation(id: string): void {
    const entry = entries.get(id);
    if (entry === undefined) throw new Error(`unknown station ${id}`);
    if (entry.running) return;
    entry.running = true;
    entry.station.transport.start();
  }

  async function stopStation(id: string): Promise<void> {
    const entry = entries.get(id);
    if (entry === undefined || !entry.running) return;
    entry.running = false;
    await entry.station.transport.stop();
    save(id);
  }

  return {
    add(definition, addOptions = {}) {
      const station = build(definition);
      options.store?.saveStation(definition);
      save(definition.id);
      if (addOptions.start !== false) startStation(definition.id);
      return station;
    },

    get: (id) => entries.get(id)?.station,

    inject(id, request) {
      const entry = entries.get(id);
      if (entry === undefined) throw new Error(`unknown station ${id}`);
      const { injection } = request;
      const cp = entry.station.chargePoint;
      const register = (connectorId: number) =>
        cp.snapshot().connectors.find((c) => c.connectorId === connectorId)?.energyWh;
      switch (injection.type) {
        case 'reconnectStorm':
          for (const other of entries.values()) {
            if (other.running) other.station.transport.restartAfter(0);
          }
          return;
        case 'meterReset':
          cp.setMeterRegister(injection.connector, 0);
          return;
        case 'meterRollback': {
          const current = register(injection.connector);
          if (current === undefined)
            throw new Error(`station ${id} has no connector ${injection.connector}`);
          cp.setMeterRegister(injection.connector, current - injection.wh);
          return;
        }
        case 'powerLoss':
          void powerLoss(id, injection);
          return;
        default:
          entry.station.injector.add(request);
      }
    },

    reconnectStorm() {
      for (const entry of entries.values()) {
        if (entry.running) entry.station.transport.restartAfter(0);
      }
    },
    list: () => [...entries.values()].map((entry) => entry.station),
    start: startStation,
    stop: stopStation,

    async remove(id) {
      await stopStation(id);
      const pending = pendingSaves.get(id);
      if (pending !== undefined) clearTimeout(pending);
      pendingSaves.delete(id);
      entries.delete(id);
      options.store?.deleteStation(id);
    },

    async restore() {
      const restored: VirtualStation[] = [];
      for (const definition of options.store?.listStations() ?? []) {
        if (entries.has(definition.id)) continue;
        const state = options.store?.loadState(definition.id);
        restored.push(build(definition, state));
        startStation(definition.id);
      }
      return restored;
    },

    async shutdown() {
      shuttingDown = true;
      if (saveTimer !== undefined) clearInterval(saveTimer);
      for (const timer of pendingSaves.values()) clearTimeout(timer);
      pendingSaves.clear();
      await Promise.all([...entries.keys()].map((id) => stopStation(id)));
      // One final save per station; nothing is written after this.
      for (const id of entries.keys()) save(id);
    },
  };
}

/** The PEM contents of a station's certificate files. */
interface StationCertificates {
  ca?: string;
  cert?: string;
  key?: string;
  manufacturerRoot?: string;
}

function readStationCertificates(security: StationSecurity | undefined): StationCertificates {
  const read = (path: string | undefined, what: string) => {
    if (path === undefined) return undefined;
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(
        `cannot read the ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
  const ca = read(security?.ca, 'CA certificate');
  const cert = read(security?.cert, 'client certificate');
  const key = read(security?.key, 'client key');
  const manufacturerRoot = read(security?.manufacturerRoot, 'manufacturer root certificate');
  return {
    ...(ca !== undefined && { ca }),
    ...(cert !== undefined && { cert }),
    ...(key !== undefined && { key }),
    ...(manufacturerRoot !== undefined && { manufacturerRoot }),
  };
}

/**
 * How a station authenticates per Security Profile (Security Whitepaper 2.3 to
 * 2.5). 0: Basic Auth only if a password is set. 1: Basic Auth over ws or wss.
 * 2: wss with the server certificate checked against `ca`, plus Basic Auth.
 * 3: wss with the client certificate, no Basic Auth. Profiles 2 and 3 need
 * TLS 1.2 or above.
 */
export function connectionSettings(
  csmsUrl: string,
  security: ConnectionSecurity,
): ConnectionSettings {
  const { profile, authorizationKey, centralSystemRoots, chargePointCertificate } = security;
  const ca = centralSystemRoots.length > 0 ? { ca: centralSystemRoots.join('\n') } : {};
  if (profile <= 1) {
    if (profile === 1 && authorizationKey === undefined) {
      return { error: 'Security Profile 1 needs an AuthorizationKey' };
    }
    return {
      ...(authorizationKey !== undefined && { password: authorizationKey }),
      ...(centralSystemRoots.length > 0 && { tls: ca }),
    };
  }
  if (!csmsUrl.startsWith('wss://')) {
    return { error: `Security Profile ${profile} needs a wss:// CSMS address` };
  }
  if (profile === 2) {
    if (authorizationKey === undefined) {
      return { error: 'Security Profile 2 needs an AuthorizationKey' };
    }
    return { password: authorizationKey, tls: { ...ca, minVersion: 'TLSv1.2' } };
  }
  if (chargePointCertificate === undefined) {
    return { error: 'Security Profile 3 needs a client certificate and key' };
  }
  return {
    tls: {
      ...ca,
      cert: chargePointCertificate.certificate,
      key: chargePointCertificate.privateKey,
      minVersion: 'TLSv1.2',
    },
  };
}

/**
 * The security event a failed connection attempt stands for (Security
 * Whitepaper A00.FR.309, A00.FR.315), judged from the error message.
 */
export function securityEventFor(message: string): string | undefined {
  if (/Unexpected server response: 401/.test(message)) return 'FailedToAuthenticateAtCentralSystem';
  if (
    /unsupported protocol|wrong version number|protocol version|no protocols available/i.test(
      message,
    )
  )
    return 'InvalidTLSVersion';
  if (/certificate|self[- ]signed|CERT_|altname|issuer/i.test(message))
    return 'InvalidCentralSystemCertificate';
  return undefined;
}
