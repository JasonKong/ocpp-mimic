/**
 * EV model: a battery with a state of charge (SoC) and the power its on-board
 * charger accepts. Below the taper point the EV takes its full power; above
 * it the accepted power falls linearly to a floor at the target SoC, where
 * the EV stops drawing. The power actually delivered is the smaller of what
 * the charge point offers and what the EV accepts.
 *
 * Charging is solved exactly instead of in time steps: with a constant power
 * the SoC rises linearly, and in the taper region the power decays
 * exponentially (dP/dt is proportional to -P), so any duration can be
 * advanced in one call and the moment the EV is full is known in advance.
 */

/**
 * How the EV talks to the station: `basic` is AC with the PWM signal only (the
 * station never learns the SoC), `dc` is DIN 70121 or CHAdeMO (SoC is known),
 * `iso15118` also tells the charging needs (capacity, target, departure).
 */
export const EV_COMMUNICATION = ['basic', 'dc', 'iso15118'] as const;
export type EvCommunication = (typeof EV_COMMUNICATION)[number];

export interface EvProfile {
  /** Usable battery capacity in kWh. */
  capacityKWh: number;
  /** State of charge when the EV is plugged in, in percent. */
  initialSoc: number;
  /** The most power the on-board charger takes, in W. */
  maxPowerW: number;
  /** Phases the on-board charger uses. */
  phases: 1 | 3;
  /** SoC (percent) above which the accepted power tapers. Default 80. */
  taperSoc?: number;
  /** SoC (percent) at which the EV stops drawing power. Default 100. */
  targetSoc?: number;
  /**
   * How the EV talks to the station. Without it the station knows the SoC,
   * as before the setting existed.
   */
  communication?: EvCommunication;
}

/** Whether the station learns the EV's SoC, and so can report it. */
export function reportsSoc(profile: EvProfile): boolean {
  return profile.communication !== 'basic';
}

export interface EvState {
  readonly profile: EvProfile;
  /** State of charge in percent, as a float. */
  readonly soc: number;
}

export interface EvAdvance {
  ev: EvState;
  /** Energy delivered during the advance, in Wh. */
  energyWh: number;
  /** Power drawn at the end of the advance, in W. */
  powerW: number;
}

/** At the target SoC the EV still takes this share of its maximum power, then stops. */
export const TAPER_FLOOR = 0.1;

const MS_PER_HOUR = 3_600_000;

/** Problems with a profile, empty when it is usable. */
export function evProfileProblems(profile: EvProfile): string[] {
  const problems: string[] = [];
  const taper = profile.taperSoc ?? 80;
  const target = profile.targetSoc ?? 100;
  if (!(profile.capacityKWh > 0)) problems.push('capacityKWh must be greater than 0');
  if (!(profile.maxPowerW > 0)) problems.push('maxPowerW must be greater than 0');
  if (profile.phases !== 1 && profile.phases !== 3) problems.push('phases must be 1 or 3');
  if (!(target > 0 && target <= 100)) problems.push('targetSoc must be above 0 and at most 100');
  if (!(taper >= 0 && taper <= target)) problems.push('taperSoc must be between 0 and targetSoc');
  if (!(profile.initialSoc >= 0 && profile.initialSoc <= 100)) {
    problems.push('initialSoc must be between 0 and 100');
  }
  if (
    profile.communication !== undefined &&
    !(EV_COMMUNICATION as readonly string[]).includes(profile.communication)
  ) {
    problems.push(`communication must be one of ${EV_COMMUNICATION.join(', ')}`);
  }
  return problems;
}

/** A freshly plugged-in EV. Throws a RangeError for an unusable profile. */
export function createEv(profile: EvProfile): EvState {
  const problems = evProfileProblems(profile);
  if (problems.length > 0) throw new RangeError(`invalid EV profile: ${problems.join('; ')}`);
  return { profile, soc: profile.initialSoc };
}

interface Curve {
  capacityWh: number;
  maxW: number;
  floorW: number;
  taper: number;
  target: number;
  /** Fall of the accepted power per percent of SoC in the taper region, in W. */
  slope: number;
}

function curve(profile: EvProfile): Curve {
  const taper = profile.taperSoc ?? 80;
  const target = profile.targetSoc ?? 100;
  const maxW = profile.maxPowerW;
  const floorW = maxW * TAPER_FLOOR;
  return {
    capacityWh: profile.capacityKWh * 1000,
    maxW,
    floorW,
    taper,
    target,
    slope: target > taper ? (maxW - floorW) / (target - taper) : Infinity,
  };
}

/** The power the EV accepts at `soc` percent, in W. */
export function acceptedPowerW(profile: EvProfile, soc: number): number {
  const c = curve(profile);
  if (soc >= c.target) return 0;
  if (soc <= c.taper) return c.maxW;
  return c.maxW - c.slope * (soc - c.taper);
}

/** The power drawn at the EV's current SoC when the charge point offers `offeredW`. */
export function evPowerW(ev: EvState, offeredW: number): number {
  return Math.max(0, Math.min(offeredW, acceptedPowerW(ev.profile, ev.soc)));
}

/** The SoC from which the EV accepts less than `limitW`. */
function limitedFrom(c: Curve, limitW: number): number {
  if (limitW <= c.floorW) return c.target;
  return Math.min(c.target, c.taper + (c.maxW - limitW) / c.slope);
}

/** Advances charging by `durationMs` with the charge point offering `offeredW`. */
export function advanceEv(ev: EvState, offeredW: number, durationMs: number): EvAdvance {
  const c = curve(ev.profile);
  let soc = ev.soc;
  let remainingH = Math.max(0, durationMs) / MS_PER_HOUR;
  let energyWh = 0;
  const limitW = Math.min(Math.max(0, offeredW), c.maxW);

  if (limitW > 0 && remainingH > 0 && soc < c.target) {
    // Constant power until the EV accepts less than the limit.
    const switchSoc = limitedFrom(c, limitW);
    if (soc < switchSoc) {
      const neededH = ((switchSoc - soc) * c.capacityWh) / 100 / limitW;
      const usedH = Math.min(neededH, remainingH);
      energyWh += limitW * usedH;
      soc = usedH === neededH ? switchSoc : soc + (100 * limitW * usedH) / c.capacityWh;
      remainingH -= usedH;
    }
    // Taper: P(t) = P0·e^(−λt) until P reaches the floor at the target SoC.
    if (remainingH > 0 && soc < c.target) {
      const p0 = acceptedPowerW(ev.profile, soc);
      const lambda = (100 * c.slope) / c.capacityWh;
      const neededH = Math.log(p0 / c.floorW) / lambda;
      if (remainingH >= neededH) {
        energyWh += (p0 - c.floorW) / lambda;
        soc = c.target;
      } else {
        const p = p0 * Math.exp(-lambda * remainingH);
        energyWh += (p0 - p) / lambda;
        soc = c.taper + (c.maxW - p) / c.slope;
      }
    }
  }

  const next: EvState = { profile: ev.profile, soc: Math.min(soc, c.target) };
  return { ev: next, energyWh, powerW: evPowerW(next, offeredW) };
}

/**
 * Milliseconds until the EV reaches its target SoC and stops drawing power,
 * or undefined when it never will (nothing offered). 0 when already full.
 */
export function msUntilFull(ev: EvState, offeredW: number): number | undefined {
  const c = curve(ev.profile);
  if (ev.soc >= c.target) return 0;
  const limitW = Math.min(Math.max(0, offeredW), c.maxW);
  if (limitW <= 0) return undefined;
  let soc = ev.soc;
  let hours = 0;
  const switchSoc = limitedFrom(c, limitW);
  if (soc < switchSoc) {
    hours += ((switchSoc - soc) * c.capacityWh) / 100 / limitW;
    soc = switchSoc;
  }
  if (soc < c.target) {
    const lambda = (100 * c.slope) / c.capacityWh;
    hours += Math.log(acceptedPowerW(ev.profile, soc) / c.floorW) / lambda;
  }
  return Math.ceil(hours * MS_PER_HOUR);
}
