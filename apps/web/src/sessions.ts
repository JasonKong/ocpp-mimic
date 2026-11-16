/**
 * Formatting for the Sessions view: start sources, states, timelines,
 * durations, and the `#/stations/<id>/sessions/<n>` links.
 */
import type {
  ReportedSample,
  SessionDetail,
  SessionSource,
  SessionState,
  SessionSummary,
  TimelineStep,
} from './api.js';

export const SOURCE_LABELS: Record<SessionSource, string> = {
  local: 'Card',
  remote: 'Remote start',
  noAuth: 'No authorization',
  payment: 'Payment',
};

export const SOURCE_HINTS: Record<SessionSource, string> = {
  local: 'Started with a card (idTag / idToken) at the station',
  remote:
    'Started by the CSMS (RemoteStartTransaction / RequestStartTransaction): the path a third-party app takes',
  noAuth: 'Started without authorization (idToken type NoAuthorization)',
  payment:
    "Paid ad hoc (OCPP 2.1, idToken type DirectPayment): at the station's payment terminal or on a web page the CSMS started it from",
};

export const STATE_LABELS: Record<SessionState, string> = {
  starting: 'Starting',
  running: 'Running',
  finished: 'Finished',
  'not-started': 'Not started',
};

/** The CSS tone of a session state. */
export function stateTone(state: SessionState): string {
  switch (state) {
    case 'running':
      return 'good';
    case 'starting':
      return 'pending';
    case 'not-started':
      return 'bad';
    default:
      return 'muted';
  }
}

/** `1:42` or `1 h 05 min`-style text for a duration in milliseconds. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.round(ms / 1000)} s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes} min` : `${hours} h ${String(minutes).padStart(2, '0')} min`;
}

/** How long a session has run: from its start to its end, or to `now`. */
export function sessionDuration(
  session: Pick<SessionSummary, 'startedAt' | 'endedAt'>,
  now: number,
): number | undefined {
  if (session.startedAt === undefined) return undefined;
  return (
    (session.endedAt === undefined ? now : Date.parse(session.endedAt)) -
    Date.parse(session.startedAt)
  );
}

/** A timeline step as one line: `CSMS → CP RemoteStartTransaction`, or its answer. */
export function stepLabel(step: TimelineStep): string {
  const arrow = step.direction === 'cp-to-csms' ? 'CP → CSMS' : 'CSMS → CP';
  const kind = step.messageType === 2 ? '' : step.messageType === 3 ? ' answer' : ' error';
  return `${arrow} ${step.action}${kind}`;
}

/** The time a step took to come: `+80 ms`, `+1.2 s`. */
export function stepDelay(step: TimelineStep): string {
  const ms = step.sincePreviousMs;
  if (ms === undefined) return '';
  return ms < 1000 ? `+${ms} ms` : `+${(ms / 1000).toFixed(1)} s`;
}

/** Why a session never started, in words. */
export function failureText(
  failure: { reason: string; detail?: string } | undefined,
): string | undefined {
  if (failure === undefined) return undefined;
  const reason =
    {
      Rejected: 'The station rejected the remote start',
      NotAuthorized: 'Not authorized',
      ConnectionTimeout: 'No cable within the connection timeout',
      StartFailed: 'The transaction could not start',
    }[failure.reason] ?? failure.reason;
  return failure.detail === undefined ? reason : `${reason} (${failure.detail})`;
}

export interface SessionRoute {
  stationId: string;
  /** The Sessions tab, and the session open in it. */
  sessions: boolean;
  n?: number;
}

/** Reads `#/stations/<id>`, `#/stations/<id>/sessions` or `#/stations/<id>/sessions/<n>`. */
export function parseRoute(hash: string): SessionRoute | undefined {
  const match = /^#\/stations\/([^/]+)(\/sessions(?:\/(\d+))?)?$/.exec(hash);
  if (match === null) return undefined;
  const route: SessionRoute = {
    stationId: decodeURIComponent(match[1] ?? ''),
    sessions: match[2] !== undefined,
  };
  if (match[3] !== undefined) route.n = Number(match[3]);
  return route;
}

export function formatRoute(route: SessionRoute): string {
  const base = `#/stations/${encodeURIComponent(route.stationId)}`;
  if (!route.sessions) return base;
  return route.n === undefined ? `${base}/sessions` : `${base}/sessions/${route.n}`;
}

/** The numbers of the energy panel, from a session's detail (R-NRG-1, R-NRG-3, R-NRG-5). */
export interface EnergyFigures {
  energyWh: number;
  /** Latest reported power and SoC; the truth's beside them. */
  powerW?: number;
  socPercent?: number;
  truePowerW?: number;
  trueSocPercent?: number;
  chargingMs: number;
  suspendedMs: number;
  idleMs: number;
  /** The energy multiplier the times below were converted with (1: real time). */
  multiplier: number;
  /** Estimated and true ETA to the target in wall-clock time, and the time left from `now`. */
  etaAt?: string;
  leftMs?: number;
  trueEtaAt?: string;
  trueLeftMs?: number;
  /** Why there is no estimate. */
  reason?: string;
  targetSoc: number;
  targetFrom: 'chargingNeeds' | 'default';
  departureTime?: string;
  reachesTargetBeforeDeparture?: boolean;
  /** The estimate misses the truth by more than 5 minutes or 10 % (of simulated time). */
  off?: boolean;
  /** The gap in wall-clock time. */
  gapMs?: number;
  /** Latest per-phase readings. */
  phases?: { phase: 'L1' | 'L2' | 'L3'; currentA?: number; voltageV?: number }[];
  /** For a finished session. */
  peakPowerW?: number;
  startSocPercent?: number;
  endSocPercent?: number;
}

export function energyFigures(detail: SessionDetail, now: number): EnergyFigures {
  const { session, summary, estimate, truth, gap, durations } = detail;
  const latest = <K extends keyof ReportedSample>(key: K) =>
    [...session.samples].reverse().find((s) => s[key] !== undefined)?.[key];
  const lastTruth = session.truth.at(-1);
  const socs = session.samples.flatMap((s) => (s.socPercent === undefined ? [] : [s.socPercent]));
  const powers = session.samples.flatMap((s) => (s.powerW === undefined ? [] : [s.powerW]));
  const phaseSample = [...session.samples]
    .reverse()
    .find((s) => s.currentA !== undefined || s.voltageV !== undefined);
  const phases = (['L1', 'L2', 'L3'] as const).flatMap((phase) => {
    const currentA = phaseSample?.currentA?.[phase];
    const voltageV = phaseSample?.voltageV?.[phase];
    return currentA === undefined && voltageV === undefined
      ? []
      : [
          {
            phase,
            ...(currentA !== undefined && { currentA }),
            ...(voltageV !== undefined && { voltageV }),
          },
        ];
  });
  // Under an energy multiplier the times to the target are simulated: they pass that much faster.
  const multiplier =
    detail.energyMultiplier !== undefined && detail.energyMultiplier > 0
      ? detail.energyMultiplier
      : 1;
  const wallEta = (at: string | undefined, ms: number | undefined) =>
    at === undefined || ms === undefined
      ? undefined
      : new Date(Date.parse(at) + ms / multiplier).toISOString();
  const etaAt = wallEta(estimate.at, estimate.msToTarget);
  const trueEtaAt = wallEta(truth?.at, truth?.msToTarget);
  const left = (eta: string) => Math.max(0, Date.parse(eta) - now);
  const powerW = latest('powerW');
  const socPercent = latest('socPercent');
  return {
    energyWh: summary.energyWh,
    ...(powerW !== undefined && { powerW }),
    ...(socPercent !== undefined && { socPercent }),
    ...(lastTruth !== undefined && {
      truePowerW: lastTruth.powerW,
      trueSocPercent: lastTruth.socPercent,
    }),
    chargingMs: durations.charging,
    suspendedMs: durations.suspendedEV + durations.suspendedEVSE,
    idleMs: durations.idle,
    multiplier,
    ...(etaAt !== undefined && { etaAt, leftMs: left(etaAt) }),
    ...(trueEtaAt !== undefined && { trueEtaAt, trueLeftMs: left(trueEtaAt) }),
    ...(estimate.reason !== undefined &&
      estimate.reason !== 'target reached' && { reason: estimate.reason }),
    targetSoc: estimate.targetSoc,
    targetFrom: estimate.targetFrom,
    ...(estimate.departureTime !== undefined && { departureTime: estimate.departureTime }),
    ...(estimate.reachesTargetBeforeDeparture !== undefined && {
      reachesTargetBeforeDeparture: estimate.reachesTargetBeforeDeparture,
    }),
    ...(gap !== undefined && { off: gap.off, gapMs: gap.gapMs / multiplier }),
    ...(phases.length > 0 && { phases }),
    ...(powers.length > 0 && { peakPowerW: Math.max(...powers) }),
    ...(socs.length > 0 && { startSocPercent: socs[0] ?? 0, endSocPercent: socs.at(-1) ?? 0 }),
  };
}
