/**
 * Formatting for the Sessions view: start sources, states, timelines,
 * durations, and the `#/stations/<id>/sessions/<n>` links.
 */
import type { SessionSource, SessionState, SessionSummary, TimelineStep } from './api.js';

export const SOURCE_LABELS: Record<SessionSource, string> = {
  local: 'Card',
  remote: 'Remote start',
  noAuth: 'No authorization',
};

export const SOURCE_HINTS: Record<SessionSource, string> = {
  local: 'Started with a card (idTag / idToken) at the station',
  remote:
    'Started by the CSMS (RemoteStartTransaction / RequestStartTransaction): the path a third-party app takes',
  noAuth: 'Started without authorization (idToken type NoAuthorization)',
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
