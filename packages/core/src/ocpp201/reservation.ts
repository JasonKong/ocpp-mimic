/**
 * Reservations of a 2.0.1 station (functional block H), as pure rules: a
 * reservation holds a specific EVSE, or one EVSE of any or of a connector
 * type. The station keeps the reservations and the device reducer's
 * Reserved state in step with these answers.
 *
 * EVSEs are seen through their status without reservations: Available,
 * Occupied, Unavailable or Faulted. An EVSE is free when it is Available and
 * no reservation holds it by evseId. Reservations without evseId need one free
 * EVSE each among their candidates (of their connector type), so a free EVSE
 * shows Reserved when the others alone could not serve them (H01.FR.20, .24).
 */
import type { IdTokenType } from './messages.js';

type Bare<T> = Omit<T, 'customData'>;

export interface Reservation201 {
  id: number;
  /** A specific EVSE; without it any EVSE (of `connectorType`) will do. */
  evseId?: number;
  connectorType?: string;
  idToken: Bare<IdTokenType>;
  groupIdToken?: Bare<IdTokenType>;
  /** expiryDateTime, ms since the epoch. */
  expiresAt: number;
}

export type BaseStatus = 'Available' | 'Occupied' | 'Unavailable' | 'Faulted';

export interface EvseView {
  id: number;
  /** ConnectorType of its connector. */
  connectorType: string;
  status: BaseStatus;
}

const sameToken = (a: Bare<IdTokenType> | undefined, b: Bare<IdTokenType> | undefined) =>
  a !== undefined && b !== undefined && a.idToken === b.idToken && a.type === b.type;

/** Whether a token (with its group) may use a reservation (H03.FR.01 to .06). */
export function matchesReservation(
  reservation: Reservation201,
  idToken: Bare<IdTokenType>,
  groupIdToken?: Bare<IdTokenType>,
): boolean {
  return (
    sameToken(reservation.idToken, idToken) ||
    (reservation.groupIdToken !== undefined && sameToken(reservation.groupIdToken, groupIdToken))
  );
}

const candidates = (reservation: Reservation201, evses: readonly EvseView[]) =>
  evses.filter(
    (e) => reservation.connectorType === undefined || e.connectorType === reservation.connectorType,
  );

/** EVSEs free for a new session: Available and not held by a reservation for that EVSE. */
function freeEvses(reservations: readonly Reservation201[], evses: readonly EvseView[]): number[] {
  const held = new Set(reservations.flatMap((r) => (r.evseId === undefined ? [] : [r.evseId])));
  return evses.filter((e) => e.status === 'Available' && !held.has(e.id)).map((e) => e.id);
}

/**
 * Whether each reservation without evseId gets a free EVSE of its own among
 * `free`: the ones with a connector type first, as they have fewer choices.
 */
function servable(
  reservations: readonly Reservation201[],
  free: readonly number[],
  evses: readonly EvseView[],
): boolean {
  const open = reservations
    .filter((r) => r.evseId === undefined)
    .sort((a, b) => Number(a.connectorType === undefined) - Number(b.connectorType === undefined));
  const left = new Set(free);
  for (const reservation of open) {
    const pick = candidates(reservation, evses).find((e) => left.has(e.id));
    if (pick === undefined) return false;
    left.delete(pick.id);
  }
  return true;
}

/** The EVSEs that show Reserved: held by evseId, or needed by the reservations without one. */
export function reservedEvses(
  reservations: readonly Reservation201[],
  evses: readonly EvseView[],
): Map<number, number> {
  const shown = new Map<number, number>();
  for (const r of reservations) {
    if (r.evseId !== undefined) shown.set(r.evseId, r.id);
  }
  const free = freeEvses(reservations, evses);
  const open = reservations.filter((r) => r.evseId === undefined);
  for (const id of free) {
    if (
      open.length > 0 &&
      !servable(
        open,
        free.filter((f) => f !== id),
        evses,
      )
    ) {
      const evse = evses.find((e) => e.id === id);
      const holder = open.find((r) => evse !== undefined && candidates(r, [evse]).length > 0);
      shown.set(id, (holder ?? open[0])?.id ?? 0);
    }
  }
  return shown;
}

export type ReserveAnswer = 'Accepted' | 'Faulted' | 'Occupied' | 'Rejected' | 'Unavailable';

/**
 * ReserveNow's answer for `reservation` (H01), with any reservation of the
 * same id already left out of `reservations`.
 */
export function reserveAnswer(
  reservation: Reservation201,
  reservations: readonly Reservation201[],
  evses: readonly EvseView[],
  nonEvseSpecific: boolean,
): { status: ReserveAnswer; reason?: string } {
  if (reservation.evseId !== undefined) {
    const evse = evses.find((e) => e.id === reservation.evseId);
    if (evse === undefined) return { status: 'Rejected', reason: 'unknown EVSE' };
    if (
      reservation.connectorType !== undefined &&
      evse.connectorType !== reservation.connectorType
    ) {
      return { status: 'Rejected', reason: `EVSE ${evse.id} has no ${reservation.connectorType}` };
    }
    if (evse.status !== 'Available') return { status: evse.status as ReserveAnswer };
    const others = reservations.filter((r) => r.id !== reservation.id);
    if (others.some((r) => r.evseId === evse.id)) return { status: 'Occupied' };
    // Holding it must leave the reservations without evseId their EVSEs.
    const free = freeEvses(others, evses).filter((id) => id !== evse.id);
    return servable(others, free, evses)
      ? { status: 'Accepted' }
      : { status: 'Occupied', reason: 'needed by other reservations' };
  }
  // Without evseId only with ReservationCtrlr.NonEvseSpecific (H01.FR.18, .19).
  if (!nonEvseSpecific) return { status: 'Rejected', reason: 'NonEvseSpecific is false' };
  const targets = candidates(reservation, evses);
  if (targets.length === 0) {
    return {
      status: 'Rejected',
      reason: `no connector of type ${reservation.connectorType ?? ''}`,
    };
  }
  if (targets.every((e) => e.status === 'Faulted')) return { status: 'Faulted' };
  if (targets.every((e) => e.status === 'Unavailable')) return { status: 'Unavailable' };
  const all = [...reservations, reservation];
  return servable(all, freeEvses(all, evses), evses)
    ? { status: 'Accepted' }
    : { status: 'Occupied' };
}

/**
 * Whether a token may start at `evseId` given the reservations, and the
 * reservation it uses (H03): a held EVSE only takes its reservation's token
 * or group; otherwise a matching reservation without evseId is used, or the
 * EVSE must not be needed by the reservations without one.
 */
export function useAt(
  evseId: number,
  idToken: Bare<IdTokenType>,
  groupIdToken: Bare<IdTokenType> | undefined,
  reservations: readonly Reservation201[],
  evses: readonly EvseView[],
): { ok: boolean; reservation?: Reservation201 } {
  const held = reservations.find((r) => r.evseId === evseId);
  if (held !== undefined) {
    return matchesReservation(held, idToken, groupIdToken)
      ? { ok: true, reservation: held }
      : { ok: false };
  }
  const evse = evses.find((e) => e.id === evseId);
  const own = reservations.find(
    (r) =>
      r.evseId === undefined &&
      evse !== undefined &&
      candidates(r, [evse]).length > 0 &&
      matchesReservation(r, idToken, groupIdToken),
  );
  if (own !== undefined) return { ok: true, reservation: own };
  const free = freeEvses(reservations, evses).filter((id) => id !== evseId);
  return { ok: servable(reservations, free, evses) };
}

/** Reservations whose EVSEs all became Faulted or Unavailable: they are removed (H01.FR.16, .17). */
export function lostReservations(
  reservations: readonly Reservation201[],
  evses: readonly EvseView[],
): Reservation201[] {
  const gone = (e: EvseView) => e.status === 'Faulted' || e.status === 'Unavailable';
  return reservations.filter((r) => {
    const targets =
      r.evseId === undefined ? candidates(r, evses) : evses.filter((e) => e.id === r.evseId);
    return targets.length > 0 && targets.every(gone);
  });
}
