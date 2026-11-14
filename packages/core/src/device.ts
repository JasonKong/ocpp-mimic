/**
 * Device model: Station → EVSE → Connector, and the OCPP 1.6 connector
 * state machine as a pure reducer.
 *
 * A connector's status is never stored as a free-standing value. It is
 * derived from physical and logical facts (cable plugged, transaction
 * running, EV or EVSE suspended, fault, availability), so only the
 * transitions the 1.6 status table allows can happen. The reducer applies one
 * input event and returns the StatusNotification requests for every status
 * that changed.
 */
import type { ChargePointStatus } from './ocpp16.js';
import type { RequestOf } from './ocpp16-messages.js';

export type StatusNotificationRequest = RequestOf<'StatusNotification'>;
export type StatusErrorCode = StatusNotificationRequest['errorCode'];
export type Availability = 'Operative' | 'Inoperative';

export interface Fault {
  errorCode: Exclude<StatusErrorCode, 'NoError'>;
  info?: string;
  vendorErrorCode?: string;
}

/** What a StatusNotification last told the CSMS, used to report only changes. */
export interface ReportedStatus {
  status: ChargePointStatus;
  errorCode: StatusErrorCode;
  info?: string;
  vendorErrorCode?: string;
}

export interface ConnectorState {
  /** The OCPP 1.6 connectorId (1-based). */
  readonly connectorId: number;
  readonly plugged: boolean;
  readonly locked: boolean;
  /** Authorized, or a remote start was accepted, and the transaction has not started yet. */
  readonly prepared: boolean;
  readonly transactionId?: number;
  /** A transaction ended while the cable is still plugged in. */
  readonly finishing: boolean;
  readonly evSuspended: boolean;
  readonly evseSuspended: boolean;
  readonly fault?: Fault;
  readonly availability: Availability;
  /** The reservation holding this connector, while no session has begun on it. */
  readonly reservationId?: number;
  /** Availability requested during a transaction, applied when it ends. */
  readonly scheduledAvailability?: Availability;
  readonly reported?: ReportedStatus;
}

export interface EvseState {
  readonly id: number;
  readonly connectors: readonly ConnectorState[];
}

export interface StationState {
  readonly evses: readonly EvseState[];
  /** A fault of the whole charge point (connectorId 0). */
  readonly fault?: Fault;
  /**
   * Availability of the whole charge point. Only ChangeAvailability with
   * connectorId 0 sets it; changing every connector one by one does not.
   */
  readonly availability: Availability;
  /** Availability requested for connectorId 0 while transactions run, applied when the last one ends. */
  readonly scheduledAvailability?: Availability;
  /** What was last reported for connectorId 0. */
  readonly reported?: ReportedStatus;
}

/** Input events. `connectorId` 0 addresses the whole charge point where allowed. */
export type DeviceEvent =
  | { type: 'ReportAll' }
  | { type: 'Plug' | 'Unplug' | 'Lock' | 'Unlock'; connectorId: number }
  | { type: 'Prepare' | 'CancelPrepare'; connectorId: number }
  | { type: 'Reserve'; connectorId: number; reservationId: number }
  | { type: 'Unreserve'; connectorId: number }
  | { type: 'TransactionStarted'; connectorId: number; transactionId: number }
  | { type: 'TransactionEnded'; connectorId: number }
  | { type: 'EvSuspend' | 'EvResume' | 'EvseSuspend' | 'EvseResume'; connectorId: number }
  | ({ type: 'FaultRaised'; connectorId: number } & Fault)
  | { type: 'FaultCleared'; connectorId: number }
  | { type: 'ChangeAvailability'; connectorId: number; availability: Availability };

export interface ReduceResult {
  state: StationState;
  /** StatusNotification requests for every status that changed, connectorId 0 first. */
  messages: StatusNotificationRequest[];
  /** For ChangeAvailability: applied now, or scheduled until a running transaction ends. */
  changeAvailability?: 'Accepted' | 'Scheduled';
  /** Set when the event was rejected; the state is then unchanged. */
  error?: string;
}

/**
 * A charge point with `connectors` connectors. OCPP 1.6 has no EVSE concept,
 * so each connector gets its own EVSE with the same id.
 */
export function createStation(connectors: number): StationState {
  if (!Number.isInteger(connectors) || connectors < 1) {
    throw new RangeError(`a charge point needs at least one connector, got ${connectors}`);
  }
  return {
    availability: 'Operative',
    evses: Array.from({ length: connectors }, (_, index) => ({
      id: index + 1,
      connectors: [
        {
          connectorId: index + 1,
          plugged: false,
          locked: false,
          prepared: false,
          finishing: false,
          evSuspended: false,
          evseSuspended: false,
          availability: 'Operative',
        },
      ],
    })),
  };
}

export function connectors(station: StationState): ConnectorState[] {
  return station.evses.flatMap((evse) => evse.connectors);
}

export function findConnector(
  station: StationState,
  connectorId: number,
): ConnectorState | undefined {
  return connectors(station).find((connector) => connector.connectorId === connectorId);
}

function withFault(status: ChargePointStatus, fault: Fault | undefined): ReportedStatus {
  if (fault === undefined) return { status, errorCode: 'NoError' };
  return {
    status,
    errorCode: fault.errorCode,
    ...(fault.info !== undefined && { info: fault.info }),
    ...(fault.vendorErrorCode !== undefined && { vendorErrorCode: fault.vendorErrorCode }),
  };
}

/** The status a connector reports, derived from its state and the station's. */
export function connectorStatus(connector: ConnectorState, station: StationState): ReportedStatus {
  const fault = connector.fault ?? station.fault;
  if (fault !== undefined) return withFault('Faulted', fault);
  if (connector.availability === 'Inoperative') return withFault('Unavailable', undefined);
  if (connector.transactionId !== undefined) {
    // Unplugged during a transaction: the EV side disconnected and the transaction is stopping.
    if (!connector.plugged) return withFault('Finishing', undefined);
    if (connector.evseSuspended) return withFault('SuspendedEVSE', undefined);
    if (connector.evSuspended) return withFault('SuspendedEV', undefined);
    return withFault('Charging', undefined);
  }
  if (connector.finishing) return withFault('Finishing', undefined);
  if (connector.plugged || connector.prepared) return withFault('Preparing', undefined);
  if (connector.reservationId !== undefined) return withFault('Reserved', undefined);
  return withFault('Available', undefined);
}

/**
 * The status of connectorId 0: only Available, Unavailable or Faulted. It
 * follows the charge point's own availability and faults, not its connectors.
 */
export function stationStatus(station: StationState): ReportedStatus {
  if (station.fault !== undefined) return withFault('Faulted', station.fault);
  if (station.availability === 'Inoperative') return withFault('Unavailable', undefined);
  return withFault('Available', undefined);
}

function sameStatus(a: ReportedStatus | undefined, b: ReportedStatus): boolean {
  return (
    a !== undefined &&
    a.status === b.status &&
    a.errorCode === b.errorCode &&
    a.info === b.info &&
    a.vendorErrorCode === b.vendorErrorCode
  );
}

function updateConnectors(
  station: StationState,
  matches: (connector: ConnectorState) => boolean,
  update: (connector: ConnectorState) => ConnectorState,
): StationState {
  return {
    ...station,
    evses: station.evses.map((evse) => ({
      ...evse,
      connectors: evse.connectors.map((connector) =>
        matches(connector) ? update(connector) : connector,
      ),
    })),
  };
}

function setAvailability(connector: ConnectorState, availability: Availability): ConnectorState {
  const { scheduledAvailability: _dropped, ...rest } = connector;
  if (connector.transactionId !== undefined && availability !== connector.availability) {
    return { ...rest, scheduledAvailability: availability };
  }
  return { ...rest, availability };
}

function endTransaction(connector: ConnectorState): ConnectorState {
  const { transactionId: _ended, scheduledAvailability, ...rest } = connector;
  return {
    ...rest,
    finishing: connector.plugged,
    evSuspended: false,
    evseSuspended: false,
    ...(scheduledAvailability !== undefined && { availability: scheduledAvailability }),
  };
}

/** Applies a scheduled connectorId 0 availability once no transaction is running. */
function applyScheduledStation(station: StationState): StationState {
  const { scheduledAvailability, ...rest } = station;
  if (scheduledAvailability === undefined) return station;
  if (connectors(station).some((c) => c.transactionId !== undefined)) return station;
  return { ...rest, availability: scheduledAvailability };
}

function setStationAvailability(station: StationState, availability: Availability): StationState {
  const { scheduledAvailability: _dropped, ...rest } = station;
  const busy = connectors(station).some((c) => c.transactionId !== undefined);
  if (busy && availability !== station.availability) {
    return { ...rest, scheduledAvailability: availability };
  }
  return { ...rest, availability };
}

function clearFault(connector: ConnectorState): ConnectorState {
  const { fault: _cleared, ...rest } = connector;
  return rest;
}

/** Applies the event's facts, without reporting anything yet. */
function applyEvent(
  station: StationState,
  event: Exclude<DeviceEvent, { type: 'ReportAll' }>,
): { station: StationState; changeAvailability?: 'Accepted' | 'Scheduled' } {
  const target = (connector: ConnectorState) => connector.connectorId === event.connectorId;
  const update = (fn: (connector: ConnectorState) => ConnectorState) => ({
    station: updateConnectors(station, target, fn),
  });

  switch (event.type) {
    case 'Plug':
      return update((c) => ({ ...c, plugged: true }));
    case 'Unplug':
      return update((c) => ({
        ...c,
        plugged: false,
        finishing: false,
        prepared: false,
        evSuspended: false,
      }));
    case 'Lock':
      return update((c) => ({ ...c, locked: true }));
    case 'Unlock':
      return update((c) => ({ ...c, locked: false }));
    case 'Prepare':
      return update((c) => ({ ...c, prepared: true }));
    case 'CancelPrepare':
      return update((c) => ({ ...c, prepared: false }));
    case 'Reserve':
      return update((c) => ({ ...c, reservationId: event.reservationId }));
    case 'Unreserve':
      return update((c) => {
        const { reservationId: _ended, ...rest } = c;
        return rest;
      });
    case 'TransactionStarted':
      return update((c) => ({
        ...c,
        transactionId: event.transactionId,
        prepared: false,
        finishing: false,
      }));
    case 'TransactionEnded':
      return { station: applyScheduledStation(updateConnectors(station, target, endTransaction)) };
    case 'EvSuspend':
      return update((c) => ({ ...c, evSuspended: true }));
    case 'EvResume':
      return update((c) => ({ ...c, evSuspended: false }));
    case 'EvseSuspend':
      return update((c) => ({ ...c, evseSuspended: true }));
    case 'EvseResume':
      return update((c) => ({ ...c, evseSuspended: false }));
    case 'FaultRaised': {
      const fault: Fault = {
        errorCode: event.errorCode,
        ...(event.info !== undefined && { info: event.info }),
        ...(event.vendorErrorCode !== undefined && { vendorErrorCode: event.vendorErrorCode }),
      };
      if (event.connectorId === 0) return { station: { ...station, fault } };
      return update((c) => ({ ...c, fault }));
    }
    case 'FaultCleared': {
      if (event.connectorId === 0) {
        const { fault: _cleared, ...rest } = station;
        return { station: rest };
      }
      return update(clearFault);
    }
    case 'ChangeAvailability': {
      // connectorId 0 changes the charge point itself and every connector with it.
      const whole = event.connectorId === 0;
      const matches = whole ? () => true : (connector: ConnectorState) => target(connector);
      let next = updateConnectors(station, matches, (c) => setAvailability(c, event.availability));
      if (whole) next = setStationAvailability(next, event.availability);
      const scheduled =
        (whole && next.scheduledAvailability !== undefined) ||
        connectors(next).some((c) => matches(c) && c.scheduledAvailability !== undefined);
      return { station: next, changeAvailability: scheduled ? 'Scheduled' : 'Accepted' };
    }
  }
}

function validationError(station: StationState, event: DeviceEvent): string | undefined {
  if (event.type === 'ReportAll') return undefined;
  const allowsWholeStation =
    event.type === 'FaultRaised' ||
    event.type === 'FaultCleared' ||
    event.type === 'ChangeAvailability';
  if (event.connectorId === 0 && allowsWholeStation) return undefined;
  if (findConnector(station, event.connectorId) === undefined) {
    return `${event.type}: unknown connector ${event.connectorId}`;
  }
  return undefined;
}

function toRequest(
  connectorId: number,
  reported: ReportedStatus,
  timestamp: string,
): StatusNotificationRequest {
  return { connectorId, ...reported, timestamp };
}

/**
 * Applies `event` at time `now` (milliseconds since the epoch) and returns the
 * new state plus a StatusNotification for each status that changed.
 */
export function reduce(station: StationState, event: DeviceEvent, now: number): ReduceResult {
  const error = validationError(station, event);
  if (error !== undefined) return { state: station, messages: [], error };

  const applied = event.type === 'ReportAll' ? { station } : applyEvent(station, event);
  const reportAll = event.type === 'ReportAll';
  const timestamp = new Date(now).toISOString();
  const messages: StatusNotificationRequest[] = [];

  let next = applied.station;
  const station0 = stationStatus(next);
  if (reportAll || !sameStatus(next.reported, station0)) {
    messages.push(toRequest(0, station0, timestamp));
    next = { ...next, reported: station0 };
  }
  for (const connector of connectors(next)) {
    const status = connectorStatus(connector, next);
    if (reportAll || !sameStatus(connector.reported, status)) {
      messages.push(toRequest(connector.connectorId, status, timestamp));
      next = updateConnectors(
        next,
        (c) => c.connectorId === connector.connectorId,
        (c) => ({ ...c, reported: status }),
      );
    }
  }

  return {
    state: next,
    messages,
    ...(applied.changeAvailability !== undefined && {
      changeAvailability: applied.changeAvailability,
    }),
  };
}
