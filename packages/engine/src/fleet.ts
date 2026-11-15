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
  createChargePoint201,
  MESSAGE_SETS,
  DEFAULT_RAMP_UP,
  createUsageDriver,
  rampUpDelays,
  resolveUsage,
  seededRandom,
  stationSeed,
  type RampUp,
  type UsageDriver,
  type UsageEvent,
  type ChargePoint,
  type ChargePointEvent,
  type ChargePointSnapshot,
  type Clock,
  type ConnectionSecurity,
  type IdGenerator,
  type InjectionRequest,
  type DeviceModelOverrides,
  type PersistedChargePoint201,
  type PersistedStation,
  type ResolvedPersona,
} from '@ocpp-mimic/core';
import {
  createFaultInjector,
  type ActiveInjection,
  type FaultInjector,
  type WireDirection,
} from './fault-injector.js';
import { resolveEv } from './evs.js';
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
  /** Something the usage model's driver did. */
  | { stationId: string; type: 'usage'; event: UsageEvent }
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
  tags: string[];
  group?: string;
  /** Whether the usage model runs; absent when the station has none. */
  usage?: boolean;
}

export interface VirtualStation {
  readonly id: string;
  readonly definition: StationDefinition;
  readonly persona: ResolvedPersona;
  readonly chargePoint: ChargePoint;
  readonly transport: Transport;
  readonly injector: FaultInjector;
  /** The usage model's driver, when the station has a model. */
  readonly usage?: UsageDriver;
  /** The connection itself, for a replay station. */
  readonly wire?: StationWire;
  readonly running: boolean;
  snapshot(): StationSnapshot;
}

/** A replay station's connection, driven directly instead of by its charge point. */
export interface StationWire {
  /** Sends a frame to the CSMS, through the Fault Injector. */
  send(text: string): void;
  /** Listens to the CSMS's frames; returns the unsubscribe function. */
  onFrame(listener: (text: string) => void): () => void;
  readonly open: boolean;
  /** Resolves once the connection is open. */
  whenOpen(timeoutMs: number): Promise<void>;
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
  /** How long changes collect before they are saved together. Default 1 s. */
  saveBatchMs?: number;
  onEvent?: (event: FleetEvent) => void;
}

export interface Fleet {
  /** Adds a station; it starts unless `start` is false. Throws on invalid definitions. */
  add(definition: StationDefinition, options?: { start?: boolean }): VirtualStation;
  /**
   * Adds many stations, all or none: one invalid definition throws and adds
   * nothing. They are saved in one transaction and, unless `start` is false,
   * started along the ramp-up (default 20 a second).
   */
  addMany(
    definitions: readonly StationDefinition[],
    options?: { start?: boolean; rampUp?: RampUp | false },
  ): VirtualStation[];
  /** Starts stations along a ramp-up; one that is stopped or removed before its turn stays stopped. */
  startMany(ids: readonly string[], rampUp?: RampUp | false): void;
  stopMany(ids: readonly string[]): Promise<void>;
  /** Stops stations and deletes them from the store in one transaction. */
  removeMany(ids: readonly string[]): Promise<void>;
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
  /** Switches a station's usage model on or off; throws when it has none. */
  setUsage(id: string, enabled: boolean): void;
  /** Listens to every fleet event beside `onEvent`; returns the unsubscribe function. */
  subscribe(listener: (event: FleetEvent) => void): () => void;
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
  /** Whether the usage model should run while the station runs. */
  usage: boolean;
}

/** A persona's Device Model overrides with a station's on top, variable by variable. */
function mergeDeviceModel(
  persona: DeviceModelOverrides | undefined,
  station: Record<string, Record<string, string>> | undefined,
): DeviceModelOverrides | undefined {
  if (station === undefined) return persona;
  const merged: DeviceModelOverrides = { ...persona };
  for (const [component, variables] of Object.entries(station)) {
    merged[component] = { ...merged[component], ...variables };
  }
  return merged;
}

/** Whether a saved state belongs to a 2.0.1 station. */
function isState201(state: PersistedStation): state is PersistedChargePoint201 {
  return (state as { ocpp?: string }).ocpp === '2.0.1';
}

export function createFleet(options: FleetOptions): Fleet {
  const clock = options.clock ?? createSystemClock();
  const ids = options.ids ?? randomIds;
  const certificateTools = createCertificateTools();
  const allowed = options.allowedCsms ?? DEFAULT_ALLOWED_CSMS;
  const listeners = new Set<(event: FleetEvent) => void>();
  const emit = (event: FleetEvent) => {
    options.onEvent?.(event);
    listeners.forEach((listener) => listener(event));
  };
  const entries = new Map<string, Entry>();
  /** Stations with changes not saved yet; written together, in one transaction. */
  const pendingSaves = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set by shutdown(): stopping connections still emits changes, which must not schedule saves. */
  let shuttingDown = false;

  function save(id: string): void {
    const entry = entries.get(id);
    if (entry === undefined || options.store === undefined) return;
    options.store.saveState(id, entry.station.chargePoint.persistentState());
  }

  /** Saves stations' states in one transaction. */
  function saveMany(ids: Iterable<string>): void {
    const store = options.store;
    if (store === undefined) return;
    const states: [string, PersistedStation][] = [];
    for (const id of ids) {
      const entry = entries.get(id);
      if (entry !== undefined) states.push([id, entry.station.chargePoint.persistentState()]);
    }
    if (states.length > 0) store.saveStates(states);
  }

  /** Collects the many 'changed' events of all stations into one write a batch interval. */
  function scheduleSave(id: string): void {
    if (options.store === undefined || shuttingDown) return;
    pendingSaves.add(id);
    flushTimer ??= setTimeout(() => {
      flushTimer = undefined;
      const ids = [...pendingSaves];
      pendingSaves.clear();
      saveMany(ids);
    }, options.saveBatchMs ?? 1000);
  }

  // Meters advance without events, so every running station is saved every
  // saveIntervalMs: a tenth of them each tenth of the interval, so no single
  // transaction holds the event loop for long.
  const SAVE_SLICES = 10;
  let saveTick = 0;
  const saveTimer =
    options.store === undefined
      ? undefined
      : setInterval(
          () => {
            const slice = saveTick++ % SAVE_SLICES;
            const running = [...entries].filter(([, entry]) => entry.running).map(([id]) => id);
            saveMany(running.filter((_, i) => i % SAVE_SLICES === slice));
          },
          (options.saveIntervalMs ?? 10_000) / SAVE_SLICES,
        );
  saveTimer?.unref();

  function build(
    definition: StationDefinition,
    restore?: PersistedStation,
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
    if (persona.ocpp === '2.0.1' && definition.config !== undefined) {
      throw new Error(
        `station ${definition.id}: config holds 1.6 configuration keys; a 2.0.1 station takes deviceModel`,
      );
    }
    if (persona.ocpp === '1.6' && definition.deviceModel !== undefined) {
      throw new Error(`station ${definition.id}: deviceModel is for 2.0.1 stations; use config`);
    }
    if (
      persona.ocpp === '2.0.1' &&
      (definition.password !== undefined || definition.security !== undefined)
    ) {
      throw new Error(
        `station ${definition.id}: password and security are not supported for 2.0.1 stations yet`,
      );
    }
    // The station's Device Model values go on top of the persona's, variable by variable.
    const deviceModel =
      persona.ocpp === '2.0.1'
        ? mergeDeviceModel(persona.options.deviceModel, definition.deviceModel)
        : undefined;
    const configValues: Record<string, string> = {
      ...(persona.ocpp === '1.6' ? persona.options.config?.values : {}),
      ...(definition.password !== undefined && { AuthorizationKey: definition.password }),
      ...(definition.security?.profile !== undefined && {
        SecurityProfile: String(definition.security.profile),
      }),
      ...definition.config,
    };
    const pem = readStationCertificates(definition.security);
    const wire =
      definition.replay === true ? createWire((text) => injector.outgoing(text)) : undefined;
    const usage = resolveUsage(persona.definition.usage, definition.usage);
    const unknownEvs = Object.keys(usage.model?.evs ?? {}).filter(
      (name) => persona.definition.evs?.[name] === undefined,
    );
    if (unknownEvs.length > 0) {
      usage.problems.push(`$.usage.evs: persona ${persona.id} has no EV ${unknownEvs.join(', ')}`);
    }
    if (usage.problems.length > 0) {
      throw new Error(`station ${definition.id}: ${usage.problems.join('; ')}`);
    }
    // Throws on invalid overrides, before anything starts.
    const config =
      persona.ocpp === '1.6'
        ? createConfig({ numberOfConnectors: personaOptions.connectors, values: configValues })
        : undefined;

    // The transport's callbacks need the charge point, which needs the transport's send().
    const holder: { chargePoint?: ChargePoint } = {};
    let connectionError: string | undefined;
    /** Security events already recorded for this run of failed attempts (sent once, A00.FR.315). */
    const reported = new Set<string>();
    const transport = createTransport({
      url: definition.csmsUrl,
      subprotocol: MESSAGE_SETS[persona.ocpp].subprotocol,
      chargeBoxId: definition.id,
      connectionSettings: () =>
        holder.chargePoint === undefined
          ? {}
          : connectionSettings(definition.csmsUrl, holder.chargePoint.connectionSecurity()),
      onConnectFailed: () => holder.chargePoint?.connectionFailed(),
      pingIntervalMs:
        config === undefined
          ? Number(deviceModel?.OCPPCommCtrlr?.WebSocketPingInterval ?? 30) * 1000
          : configInt(config, 'WebSocketPingInterval') * 1000,
      ...(options.backoff !== undefined && { backoff: options.backoff }),
      onText: (text) => injector.incoming(text),
      onOpen: () => (wire === undefined ? holder.chargePoint?.connected() : wire.opened()),
      onClose: () => (wire === undefined ? holder.chargePoint?.disconnected() : wire.closed()),
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
        if (wire === undefined) holder.chargePoint?.receive(text);
        else wire.deliver(text);
      },
      swallowed: (direction, text, injected) => frame(direction, text, injected, true),
      goOffline: () => transport.goOffline('clean'),
      goOnline: () => transport.goOnline(),
      onChange: () => emit({ stationId: definition.id, type: 'injections' }),
    });
    const common = {
      clock,
      ids,
      ...(definition.energyMultiplier !== undefined && {
        energyMultiplier: definition.energyMultiplier,
      }),
      send: (text: string) => injector.outgoing(text),
      restart: (downtimeMs: number) => transport.restartAfter(downtimeMs),
      reconnect: () => transport.restartAfter(0),
      onEvent: (event: ChargePointEvent) => {
        if (event.type === 'changed') scheduleSave(definition.id);
        emit({ stationId: definition.id, type: 'charge-point', event });
      },
    };
    // A saved state of the other version (the persona changed) is not restored.
    const cp =
      persona.ocpp === '2.0.1'
        ? createChargePoint201({
            ...persona.options,
            ...common,
            ...(deviceModel !== undefined && { deviceModel }),
            ...(restore !== undefined && isState201(restore) && { restore }),
          })
        : createChargePoint({
            ...persona.options,
            ...common,
            config: { ...persona.options.config, values: configValues },
            ...(persona.definition.firmware?.transfer === 'real' && {
              transfer: createHttpFileTransfer(),
            }),
            // The PEM files are where a new station starts; its saved certificates take over later.
            certificates: {
              centralSystemRoots: pem.ca === undefined ? [] : [pem.ca],
              manufacturerRoots: pem.manufacturerRoot === undefined ? [] : [pem.manufacturerRoot],
              ...(pem.cert !== undefined &&
                pem.key !== undefined && {
                  chargePoint: { certificate: pem.cert, privateKey: pem.key },
                }),
            },
            certificateTools,
            serialNumber: definition.id,
            ...(restore !== undefined && !isState201(restore) && { restore }),
          });

    holder.chargePoint = cp;
    const connectorOf = (connectorId: number) =>
      cp.snapshot().connectors.find((c) => c.connectorId === connectorId);
    const driver =
      usage.model === undefined
        ? undefined
        : createUsageDriver({
            clock,
            random: randomFor(definition),
            model: usage.model,
            actions: {
              connectorIds: () =>
                Array.from({ length: personaOptions.connectors }, (_, i) => i + 1),
              isFree: (connectorId) => {
                const connector = connectorOf(connectorId);
                return connector?.status === 'Available' && !connector.plugged;
              },
              plugIn: (connectorId, ev) => cp.plugIn(connectorId, resolveEv(station, ev)),
              unplug: (connectorId) => {
                cp.unplug(connectorId);
              },
              presentIdTag: async (connectorId, idTag) => {
                const result = await cp.presentIdTag(connectorId, idTag);
                return result === 'authorized' || result === 'stopping' ? result : 'other';
              },
              isPluggedIn: (connectorId) => connectorOf(connectorId)?.plugged ?? false,
              hasTransaction: (connectorId) =>
                ['Charging', 'SuspendedEV', 'SuspendedEVSE'].includes(
                  connectorOf(connectorId)?.status ?? '',
                ),
            },
            onEvent: (event) => emit({ stationId: definition.id, type: 'usage', event }),
          });
    const station: VirtualStation = {
      id: definition.id,
      definition,
      persona,
      chargePoint: cp,
      transport,
      injector,
      ...(driver !== undefined && { usage: driver }),
      ...(wire !== undefined && { wire: wire.wire }),
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
        tags: definition.tags ?? [],
        ...(definition.group !== undefined && { group: definition.group }),
        ...(driver !== undefined && { usage: driver.running }),
      }),
    };
    const previous = entries.get(definition.id);
    entries.set(definition.id, {
      station,
      running: false,
      // A power loss rebuilds the station; a usage switch made since carries over.
      usage:
        replace && previous !== undefined
          ? previous.usage
          : definition.usage !== undefined && definition.usage !== false,
    });
    return station;
  }

  /** One random generator per station id, kept across power losses so sessions go on. */
  const randoms = new Map<string, () => number>();
  function randomFor(definition: StationDefinition): () => number {
    let random = randoms.get(definition.id);
    if (random === undefined) {
      random = seededRandom(stationSeed(definition.seed ?? 0, definition.id));
      randoms.set(definition.id, random);
    }
    return random;
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
      station.usage?.stop();
      entry.running = false;
      await station.transport.stop();
      // The station that went dark is replaced; its timers must not keep it alive.
      station.chargePoint.halt();
      await new Promise((resolve) => setTimeout(resolve, offMs).unref());
      if (shuttingDown || entries.get(id) !== entry) return;
      build(station.definition, state, true);
      startStation(id);
      if (cycle < times - 1) await new Promise((resolve) => setTimeout(resolve, onMs).unref());
    }
  }

  /** Stations waiting for their turn in a ramp-up. */
  const pendingStarts = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelPendingStart(id: string): void {
    const timer = pendingStarts.get(id);
    if (timer !== undefined) clearTimeout(timer);
    pendingStarts.delete(id);
  }

  function startStation(id: string): void {
    const entry = entries.get(id);
    if (entry === undefined) throw new Error(`unknown station ${id}`);
    cancelPendingStart(id);
    if (entry.running) return;
    entry.running = true;
    entry.station.transport.start();
    if (entry.usage) entry.station.usage?.start();
  }

  function startMany(ids: readonly string[], rampUp: RampUp | false = DEFAULT_RAMP_UP): void {
    const delays = rampUpDelays(ids.length, rampUp, Math.random);
    ids.forEach((id, i) => {
      if (!entries.has(id)) throw new Error(`unknown station ${id}`);
      const delay = delays[i] ?? 0;
      if (delay <= 0) {
        startStation(id);
        return;
      }
      cancelPendingStart(id);
      const timer = setTimeout(() => {
        pendingStarts.delete(id);
        if (entries.has(id)) startStation(id);
      }, delay);
      timer.unref();
      pendingStarts.set(id, timer);
    });
  }

  async function stopStation(id: string): Promise<void> {
    cancelPendingStart(id);
    const entry = entries.get(id);
    if (entry === undefined || !entry.running) return;
    entry.station.usage?.stop();
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

    addMany(definitions, addOptions = {}) {
      const ids = new Set<string>();
      for (const { id } of definitions) {
        if (ids.has(id)) throw new Error(`station ${id} is listed twice`);
        ids.add(id);
      }
      const built: VirtualStation[] = [];
      try {
        for (const definition of definitions) built.push(build(definition));
      } catch (error) {
        // All or none: the stations built so far never started; forget them.
        for (const station of built) entries.delete(station.id);
        throw error;
      }
      options.store?.saveStations(definitions);
      saveMany(built.map((station) => station.id));
      if (addOptions.start !== false) {
        startMany(
          built.map((station) => station.id),
          addOptions.rampUp ?? DEFAULT_RAMP_UP,
        );
      }
      return built;
    },

    startMany,

    async stopMany(ids) {
      await Promise.all(ids.map((id) => stopStation(id)));
    },

    async removeMany(ids) {
      await Promise.all(ids.map((id) => stopStation(id)));
      for (const id of ids) {
        entries.get(id)?.station.chargePoint.halt();
        pendingSaves.delete(id);
        entries.delete(id);
        randoms.delete(id);
      }
      options.store?.deleteStations(ids);
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
    setUsage(id, enabled) {
      const entry = entries.get(id);
      if (entry === undefined) throw new Error(`unknown station ${id}`);
      const driver = entry.station.usage;
      if (driver === undefined) {
        throw new Error(`station ${id} has no usage model (give one in its persona or definition)`);
      }
      entry.usage = enabled;
      if (enabled && entry.running) driver.start();
      if (!enabled) driver.stop();
      emit({ stationId: id, type: 'charge-point', event: { type: 'changed' } });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => [...entries.values()].map((entry) => entry.station),
    start: startStation,
    stop: stopStation,

    async remove(id) {
      await stopStation(id);
      entries.get(id)?.station.chargePoint.halt();
      pendingSaves.delete(id);
      entries.delete(id);
      randoms.delete(id);
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
      for (const timer of pendingStarts.values()) clearTimeout(timer);
      pendingStarts.clear();
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushTimer = undefined;
      pendingSaves.clear();
      await Promise.all([...entries.keys()].map((id) => stopStation(id)));
      // One final save of every station, in one transaction; nothing is written after this.
      saveMany(entries.keys());
      for (const entry of entries.values()) entry.station.chargePoint.halt();
    },
  };
}

/** The wire of a replay station, and the hooks the transport calls. */
function createWire(send: (text: string) => void) {
  const listeners = new Set<(text: string) => void>();
  const waiting = new Set<() => void>();
  let open = false;
  const wire: StationWire = {
    send: (text) => send(text),
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get open() {
      return open;
    },
    whenOpen(timeoutMs) {
      if (open) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          waiting.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          waiting.delete(done);
          reject(new Error(`the connection did not open within ${timeoutMs} ms`));
        }, timeoutMs);
        waiting.add(done);
      });
    },
  };
  return {
    wire,
    opened() {
      open = true;
      for (const done of [...waiting]) done();
    },
    closed() {
      open = false;
    },
    deliver(text: string) {
      for (const listener of listeners) listener(text);
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
