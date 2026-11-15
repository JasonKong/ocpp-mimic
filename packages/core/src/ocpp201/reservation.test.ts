import { describe, expect, it } from 'vitest';
import {
  lostReservations,
  matchesReservation,
  reserveAnswer,
  reservedEvses,
  useAt,
  type EvseView,
  type Reservation201,
} from './reservation.js';

const tag = (idToken: string) => ({ idToken, type: 'ISO14443' as const });
const evse = (id: number, status: EvseView['status'] = 'Available', connectorType = 'cType2') => ({
  id,
  status,
  connectorType,
});
const reservation = (id: number, extra: Partial<Reservation201> = {}): Reservation201 => ({
  id,
  idToken: tag(`TAG-${id}`),
  expiresAt: 0,
  ...extra,
});

describe('2.0.1 reservation rules', () => {
  const two = [evse(1), evse(2)];

  it('answers ReserveNow for a specific EVSE (H01.FR.03, .11, .12, .14)', () => {
    expect(reserveAnswer(reservation(1, { evseId: 1 }), [], two, true)).toEqual({
      status: 'Accepted',
    });
    expect(reserveAnswer(reservation(1, { evseId: 3 }), [], two, true).status).toBe('Rejected');
    expect(
      reserveAnswer(reservation(1, { evseId: 1, connectorType: 'cCCS2' }), [], two, true).status,
    ).toBe('Rejected');
    for (const status of ['Occupied', 'Faulted', 'Unavailable'] as const) {
      expect(reserveAnswer(reservation(1, { evseId: 1 }), [], [evse(1, status)], true).status).toBe(
        status,
      );
    }
    // Held by another reservation: Occupied.
    expect(
      reserveAnswer(reservation(2, { evseId: 1 }), [reservation(1, { evseId: 1 })], two, true)
        .status,
    ).toBe('Occupied');
    // Needed by a reservation without evseId: Occupied.
    expect(
      reserveAnswer(
        reservation(2, { evseId: 1 }),
        [reservation(1)],
        [evse(1), evse(2, 'Occupied')],
        true,
      ).status,
    ).toBe('Occupied');
  });

  it('answers ReserveNow without evseId by the free EVSEs and connector types (H01.FR.04, .06, .19)', () => {
    expect(reserveAnswer(reservation(1), [], two, false).status).toBe('Rejected');
    expect(reserveAnswer(reservation(1), [], two, true).status).toBe('Accepted');
    expect(reserveAnswer(reservation(2), [reservation(1)], two, true).status).toBe('Accepted');
    expect(reserveAnswer(reservation(3), [reservation(1), reservation(2)], two, true).status).toBe(
      'Occupied',
    );
    expect(reserveAnswer(reservation(1, { connectorType: 'cCCS2' }), [], two, true).status).toBe(
      'Rejected',
    );
    const mixed = [evse(1, 'Available', 'cType2'), evse(2, 'Available', 'cCCS2')];
    expect(
      reserveAnswer(reservation(2, { connectorType: 'cCCS2' }), [reservation(1)], mixed, true)
        .status,
    ).toBe('Accepted');
    expect(
      reserveAnswer(reservation(1), [], [evse(1, 'Faulted'), evse(2, 'Faulted')], true).status,
    ).toBe('Faulted');
    expect(
      reserveAnswer(reservation(1), [], [evse(1, 'Unavailable'), evse(2, 'Unavailable')], true)
        .status,
    ).toBe('Unavailable');
  });

  it('shows Reserved for held EVSEs and for those the reservations without evseId need (H01.FR.20)', () => {
    expect(reservedEvses([reservation(1, { evseId: 2 })], two)).toEqual(new Map([[2, 1]]));
    expect(reservedEvses([reservation(1)], two)).toEqual(new Map());
    expect(reservedEvses([reservation(1), reservation(2)], two)).toEqual(
      new Map([
        [1, 1],
        [2, 1],
      ]),
    );
    expect(reservedEvses([reservation(1)], [evse(1), evse(2, 'Occupied')])).toEqual(
      new Map([[1, 1]]),
    );
  });

  it('lets the reserved token or its group use a reservation (H03)', () => {
    const group = reservation(1, { evseId: 1, groupIdToken: tag('GROUP') });
    expect(matchesReservation(group, tag('TAG-1'))).toBe(true);
    expect(matchesReservation(group, tag('OTHER'), tag('GROUP'))).toBe(true);
    expect(matchesReservation(group, tag('OTHER'), tag('ELSE'))).toBe(false);
    expect(useAt(1, tag('OTHER'), undefined, [group], two)).toEqual({ ok: false });
    expect(useAt(1, tag('TAG-1'), undefined, [group], two)).toEqual({
      ok: true,
      reservation: group,
    });
    expect(useAt(2, tag('OTHER'), undefined, [group], two)).toEqual({ ok: true });
    // One reservation without evseId and two free EVSEs: one may go to anyone.
    const open = reservation(5);
    expect(useAt(1, tag('OTHER'), undefined, [open], two)).toEqual({ ok: true });
    expect(useAt(1, tag('OTHER'), undefined, [open], [evse(1), evse(2, 'Occupied')])).toEqual({
      ok: false,
    });
    expect(useAt(1, tag('TAG-5'), undefined, [open], [evse(1), evse(2, 'Occupied')])).toEqual({
      ok: true,
      reservation: open,
    });
  });

  it('removes reservations whose EVSEs are all Faulted or Unavailable (H01.FR.16, .17)', () => {
    const held = reservation(1, { evseId: 1 });
    const open = reservation(2);
    expect(lostReservations([held, open], [evse(1, 'Faulted'), evse(2)])).toEqual([held]);
    expect(lostReservations([held, open], [evse(1, 'Faulted'), evse(2, 'Unavailable')])).toEqual([
      held,
      open,
    ]);
  });
});
