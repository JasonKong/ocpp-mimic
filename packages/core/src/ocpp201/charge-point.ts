/**
 * An OCPP 2.0.1 charging station, built on the same pure parts as the 1.6
 * charge point (device facts, timers, outbox, energy) with 2.0.1's messages:
 * boot and registration, heartbeats, StatusNotification per EVSE and
 * connector, and ChangeAvailability for the station, an EVSE or a connector.
 * Later M5 tasks add the Device Model, transactions, authorization and the
 * feature profiles.
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
import type { IdGenerator } from '../ids.js';
import { OCPP201_MESSAGE_SET, type Ocpp201RpcTypes } from '../message-set.js';
import { createOutbox, type OutboxEntry } from '../outbox.js';
import {
  createRpc,
  type CallOutcome,
  type Rpc,
  type RpcHandlers,
  type RpcOutcome,
} from '../rpc.js';
import { createStationTimers } from '../station-timers.js';
import type {
  BootReasonEnumType,
  ChargingStationType,
  Ocpp201RequestOf,
  Ocpp201ResponseOf,
} from './messages.js';
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
  let heartbeatIntervalS = 0;
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
    retryPolicy: () => ({ attempts: 3, intervalS: 60 }),
    nextKey: () => nextKey('msg'),
    log,
    changed,
  });

  // ---- Status -------------------------------------------------------------

  /** What a StatusNotification last reported, by connector. */
  const reported = new Map<number, ConnectorStatus201>();

  /** Reports every connector whose status changed, or all of them. */
  function reportStatuses(all = false): void {
    for (const connector of connectors(station)) {
      const status = connectorStatus201(connector, station);
      if (!all && reported.get(connector.connectorId) === status) continue;
      reported.set(connector.connectorId, status);
      void sendIfOnline('StatusNotification', {
        timestamp: timestamp(),
        connectorStatus: status,
        evseId: connector.connectorId,
        connectorId: 1,
      });
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
    if (online()) reportStatuses();
    changed();
    return result;
  }

  function updatePower(connectorId: number): void {
    // No transactions yet: nothing draws power.
    energy.update(connectorId, false, undefined);
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
    if (interval > 0) heartbeatIntervalS = interval;
    startHeartbeat();
    reportStatuses(true);
    outbox.pump();
  }

  function startHeartbeat(): void {
    stopTimer(heartbeatTimer);
    heartbeatTimer = undefined;
    if (heartbeatIntervalS <= 0) return;
    heartbeatTimer = later(heartbeatIntervalS * 1000, () => {
      void sendIfOnline('Heartbeat', {});
      startHeartbeat();
    });
  }

  // ---- Commands from the CSMS ---------------------------------------------

  const handlers: RpcHandlers<Ocpp201RpcTypes> = {
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

  const notYet = (what: string) => log(`${what} is not available on 2.0.1 stations yet`);

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
      applyDevice({ type: 'Plug', connectorId });
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
      if (energy.removeEv(connectorId)) changed();
      return 'unplugged';
    },

    async presentIdTag(connectorId): Promise<IdTagResult> {
      if (findConnector(station, connectorId) === undefined) return 'unknown-connector';
      notYet('Authorization');
      return 'rejected';
    },

    evSuspend(connectorId) {
      if (applyDevice({ type: 'EvSuspend', connectorId }).error === undefined) {
        updatePower(connectorId);
      }
    },

    evResume(connectorId) {
      if (!energy.canResume(connectorId)) {
        log(`connector ${connectorId}: the EV is full and does not resume`);
        return;
      }
      if (applyDevice({ type: 'EvResume', connectorId }).error === undefined) {
        updatePower(connectorId);
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
      applyDevice({ type: 'FaultRaised', connectorId, ...fault });
    },

    clearFault(connectorId) {
      applyDevice({ type: 'FaultCleared', connectorId });
    },

    dataTransfer(request) {
      const sent = sendIfOnline('DataTransfer', request as Ocpp201RequestOf<'DataTransfer'>);
      return (sent ?? Promise.resolve({ ok: false, failure: { kind: 'Closed' } })) as Promise<
        CallOutcome<'DataTransfer'>
      >;
    },

    setBehaviour(changes) {
      behaviour = { ...behaviour, ...changes };
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
          return {
            connectorId: connector.connectorId,
            evseId: connector.connectorId,
            status: connectorStatus201(connector, station),
            errorCode: connector.fault === undefined ? 'NoError' : connector.fault.errorCode,
            plugged: connector.plugged,
            locked: connector.locked,
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
        config: {},
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
