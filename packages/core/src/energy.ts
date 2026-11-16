/**
 * Power and energy of a station's connectors: the meter register, the EV
 * plugged in (SoC, charging curve), the energy multiplier, the limit in
 * force, and the timer that notices when an EV's battery is full. The
 * station decides whether a connector may draw power (a running transaction,
 * not suspended) and what limit applies; this module turns that into power,
 * energy and SoC. Shared by the charge points of every OCPP version.
 */
import type { Clock, TimerHandle } from './clock.js';
import {
  acceptedPowerW,
  advanceEv,
  createEv,
  evProfileProblems,
  evPowerW as evDrawW,
  msUntilFull,
  reportsSoc,
  type EvProfile,
  type EvState,
} from './ev.js';
import { createMeter, meterAt, withPower, type MeterState } from './meter.js';
import type { StationTimers } from './station-timers.js';

/** An EV plugged into a connector: a profile, with the persona's name for it when it has one. */
export interface PluggedEv {
  name?: string;
  profile: EvProfile;
}

export interface EnergyOptions {
  clock: Clock;
  timers: StationTimers;
  connectorIds: readonly number[];
  /** Power each connector offers, in W. */
  offeredW: number;
  /** Power drawn without an EV when allowed, in W. */
  evPowerW: number;
  /** Energy advances this many times faster than real time. */
  multiplier: number;
  /** connectorId → energy register in Wh, from a saved state. */
  registers?: Readonly<Record<string, number>>;
  /** The EV on a connector became full; the station suspends it. */
  onFull(connectorId: number): void;
  log(message: string): void;
}

export interface Energy {
  /** The meter as last brought up to date. */
  meter(connectorId: number): MeterState;
  /** Brings the meter (and the EV's SoC) up to now and returns it. */
  sync(connectorId: number): MeterState;
  /** Readings outside the meter for samples: the EV's SoC and phases. */
  extras(connectorId: number): { socPercent?: number; phases?: number };
  /** Voltage and phases for converting A to W. */
  conversion(connectorId: number): { voltageV: number; phases: number };
  setPower(connectorId: number, powerW: number): void;
  /**
   * Sets what the connector offers (the station's rating, capped by `limitW`)
   * and the power drawn: nothing unless `running`, otherwise what the EV
   * accepts, or the fixed power without an EV.
   */
  update(connectorId: number, running: boolean, limitW: number | undefined): void;
  /** Plugs in an EV; throws a RangeError for an unusable profile, before anything changes. */
  plugEv(connectorId: number, ev: PluggedEv): void;
  /**
   * The plugged-in EV's settings change (its target, its departure) and its SoC
   * stays; throws a RangeError for an unusable profile. False without an EV.
   */
  changeEv(connectorId: number, profile: EvProfile): boolean;
  /** The EV leaves; false when none was plugged in. */
  removeEv(connectorId: number): boolean;
  ev(connectorId: number): { name?: string; state: EvState } | undefined;
  /** Whether a suspended EV would draw power again (its battery is not full). */
  canResume(connectorId: number): boolean;
  /** Sets the energy register, as a faulty meter would; returns the value before. */
  setRegister(connectorId: number, energyWh: number): number;
  readonly multiplier: number;
  setMultiplier(multiplier: number): void;
  /** connectorId → energy register in Wh, for saving. */
  registers(): Record<string, number>;
}

export function createEnergy(options: EnergyOptions): Energy {
  const { clock, timers, offeredW, evPowerW } = options;
  const now = () => clock.now();
  let multiplier = options.multiplier;
  const meters = new Map<number, MeterState>(
    options.connectorIds.map((id) => [id, createMeter({ now: now(), offeredW })]),
  );
  for (const [id, energyWh] of Object.entries(options.registers ?? {})) {
    const connectorId = Number(id);
    if (meters.has(connectorId)) {
      meters.set(connectorId, createMeter({ now: now(), offeredW, energyWh }));
    }
  }
  /** Plugged-in EVs; `drawing` says whether the meter's power currently flows into the battery. */
  const evs = new Map<number, { name?: string; state: EvState; drawing: boolean }>();
  const fullTimers = new Map<number, TimerHandle>();

  function meter(connectorId: number): MeterState {
    const value = meters.get(connectorId);
    if (value === undefined) throw new Error(`no meter for connector ${connectorId}`);
    return value;
  }

  /**
   * Without an EV the power is constant between changes; with one the energy
   * comes from the EV model, so the power follows the charging curve.
   */
  function sync(connectorId: number): MeterState {
    const current = meter(connectorId);
    const ev = evs.get(connectorId);
    let next: MeterState;
    if (ev === undefined || !ev.drawing) {
      next = meterAt(current, now(), multiplier);
    } else {
      const elapsed = Math.max(0, now() - current.updatedAt);
      const step = advanceEv(ev.state, current.offeredW, elapsed * multiplier);
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

  function setPower(connectorId: number, powerW: number): void {
    meters.set(connectorId, withPower(sync(connectorId), now(), powerW));
    const ev = evs.get(connectorId);
    if (ev !== undefined) ev.drawing = powerW > 0;
    scheduleFull(connectorId);
  }

  /** While an EV draws power, a timer tells the station when the battery is full. */
  function scheduleFull(connectorId: number): void {
    timers.stop(fullTimers.get(connectorId));
    fullTimers.delete(connectorId);
    const ev = evs.get(connectorId);
    if (ev === undefined || !ev.drawing) return;
    const energyMs = msUntilFull(ev.state, meter(connectorId).offeredW);
    if (energyMs === undefined) return;
    const ms = Math.ceil(energyMs / multiplier);
    fullTimers.set(
      connectorId,
      timers.later(ms, () => {
        fullTimers.delete(connectorId);
        sync(connectorId);
        // Real timers can fire a moment early; wait for the rest.
        const rest = msUntilFull(ev.state, meter(connectorId).offeredW) ?? 0;
        if (rest > 0) {
          scheduleFull(connectorId);
          return;
        }
        options.log(`connector ${connectorId}: the EV is full`);
        options.onFull(connectorId);
      }),
    );
  }

  return {
    meter,
    sync,
    extras(connectorId) {
      const ev = evs.get(connectorId);
      if (ev === undefined) return {};
      // An EV that only has the PWM signal never tells the station its SoC.
      return reportsSoc(ev.state.profile)
        ? { socPercent: ev.state.soc, phases: ev.state.profile.phases }
        : { phases: ev.state.profile.phases };
    },
    conversion: (connectorId) => ({
      voltageV: meters.get(connectorId)?.voltageV ?? 230,
      phases: evs.get(connectorId)?.state.profile.phases ?? 3,
    }),
    setPower,
    update(connectorId, running, limitW) {
      const ev = evs.get(connectorId);
      // The limit in force becomes the power offered (and Power.Offered).
      const current = sync(connectorId);
      const offered = Math.max(0, Math.min(offeredW, limitW ?? Infinity));
      if (current.offeredW !== offered) meters.set(connectorId, { ...current, offeredW: offered });
      if (ev === undefined) {
        setPower(connectorId, running ? Math.min(evPowerW, offered) : 0);
        return;
      }
      setPower(connectorId, running ? evDrawW(ev.state, offered) : 0);
    },
    plugEv(connectorId, ev) {
      const state = createEv(ev.profile);
      sync(connectorId);
      evs.set(connectorId, {
        ...(ev.name !== undefined && { name: ev.name }),
        state,
        drawing: false,
      });
    },
    changeEv(connectorId, profile) {
      const ev = evs.get(connectorId);
      if (ev === undefined) return false;
      const problems = evProfileProblems(profile);
      if (problems.length > 0) throw new RangeError(`invalid EV profile: ${problems.join('; ')}`);
      sync(connectorId);
      ev.state = { profile, soc: ev.state.soc };
      scheduleFull(connectorId);
      return true;
    },
    removeEv(connectorId) {
      if (!evs.has(connectorId)) return false;
      setPower(connectorId, 0);
      evs.delete(connectorId);
      scheduleFull(connectorId);
      return true;
    },
    ev(connectorId) {
      const ev = evs.get(connectorId);
      return ev === undefined
        ? undefined
        : { ...(ev.name !== undefined && { name: ev.name }), state: ev.state };
    },
    canResume(connectorId) {
      const ev = evs.get(connectorId);
      if (ev === undefined) return true;
      sync(connectorId);
      return acceptedPowerW(ev.state.profile, ev.state.soc) > 0;
    },
    setRegister(connectorId, energyWh) {
      const before = sync(connectorId).energyWh;
      meters.set(connectorId, { ...sync(connectorId), energyWh: Math.max(0, energyWh) });
      return before;
    },
    get multiplier() {
      return multiplier;
    },
    setMultiplier(next) {
      // Energy so far counts at the old rate.
      for (const id of meters.keys()) sync(id);
      multiplier = next;
      for (const id of meters.keys()) scheduleFull(id);
    },
    registers: () =>
      Object.fromEntries([...meters.keys()].map((id) => [String(id), sync(id).energyWh])),
  };
}
