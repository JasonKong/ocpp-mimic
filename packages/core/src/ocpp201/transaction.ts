/**
 * When a 2.0.1 transaction starts and ends (TxCtrlr.TxStartPoint and
 * TxStopPoint), and the charging state it reports. Pure.
 *
 * A transaction starts when any listed start condition becomes true and ends
 * when any listed stop condition stops being true (E01, E06).
 * ParkingBayOccupancy and DataSigned are not supported (no bay sensor, no
 * signed meter values).
 */
import type { ChargingStateEnumType } from './messages.js';

export const TX_POINTS = [
  'EVConnected',
  'Authorized',
  'PowerPathClosed',
  'EnergyTransfer',
] as const;
export type TxPoint = (typeof TX_POINTS)[number];

export interface TxConditions {
  /** A cable is plugged in. */
  evConnected: boolean;
  /** A token is authorized for the connector. */
  authorized: boolean;
  /** Energy is flowing. */
  energyTransfer: boolean;
}

/** The supported points of a TxStartPoint or TxStopPoint value. */
export function parseTxPoints(value: string | undefined): TxPoint[] {
  return (value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p): p is TxPoint => (TX_POINTS as readonly string[]).includes(p));
}

export function holds(point: TxPoint, c: TxConditions): boolean {
  switch (point) {
    case 'EVConnected':
      return c.evConnected;
    case 'Authorized':
      return c.authorized;
    case 'PowerPathClosed':
      return c.evConnected && c.authorized;
    case 'EnergyTransfer':
      return c.energyTransfer;
  }
}

/** The first start point that holds, if any: the transaction starts. */
export function startPoint(points: readonly TxPoint[], c: TxConditions): TxPoint | undefined {
  return points.find((point) => holds(point, c));
}

/** A stop point that no longer holds, if any: the transaction ends. */
export function stopPoint(points: readonly TxPoint[], c: TxConditions): TxPoint | undefined {
  return points.find((point) => !holds(point, c));
}

export interface ChargingFacts {
  plugged: boolean;
  authorized: boolean;
  evSuspended: boolean;
  /** The station holds back energy: suspended by the EVSE, a zero limit, an energy limit reached. */
  evseSuspended: boolean;
  powerW: number;
  /** The EV accepts no more energy (full). */
  evFull: boolean;
}

/**
 * Idle without a cable; EVConnected until authorized; SuspendedEV when the EV
 * pauses or is full; SuspendedEVSE when the station holds back; Charging
 * while energy flows.
 */
export function chargingState(f: ChargingFacts): ChargingStateEnumType {
  if (!f.plugged) return 'Idle';
  if (!f.authorized) return 'EVConnected';
  if (f.evSuspended || f.evFull) return 'SuspendedEV';
  if (f.evseSuspended) return 'SuspendedEVSE';
  return f.powerW > 0 ? 'Charging' : 'SuspendedEV';
}
