/**
 * OCPP 2.0.1's view of the device facts: the connector status a
 * StatusNotification reports. The facts themselves (cable, transaction,
 * reservation, fault, availability) live in the device reducer, which the
 * 1.6 status table reads too, so both versions agree on what happened.
 */
import type { ConnectorState, StationState } from '../device.js';
import type { ConnectorStatusEnumType } from './messages.js';

export type ConnectorStatus201 = ConnectorStatusEnumType;

/**
 * Faulted (a fault on the connector or the whole station), Unavailable
 * (Inoperative at either level), Occupied (a cable plugged in or a
 * transaction running), Reserved, otherwise Available. Authorization alone
 * does not occupy a connector: 2.0.1 has no Preparing.
 */
export function connectorStatus201(
  connector: ConnectorState,
  station: StationState,
): ConnectorStatus201 {
  if (connector.fault !== undefined || station.fault !== undefined) return 'Faulted';
  if (connector.availability === 'Inoperative' || station.availability === 'Inoperative') {
    return 'Unavailable';
  }
  if (connector.plugged || connector.transactionId !== undefined) return 'Occupied';
  if (connector.reservationId !== undefined) return 'Reserved';
  return 'Available';
}

/** The station's own state for snapshots: Faulted, Unavailable or Available. */
export function stationStatus201(station: StationState): 'Available' | 'Unavailable' | 'Faulted' {
  if (station.fault !== undefined) return 'Faulted';
  if (station.availability === 'Inoperative') return 'Unavailable';
  return 'Available';
}
