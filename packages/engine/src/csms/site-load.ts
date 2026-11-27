/**
 * Site load management for the built-in CSMS: a site has a grid capacity and
 * the stations behind it, and the CSMS shares the capacity between the
 * running sessions with smart charging, as a CSMS or an energy manager does.
 * Each session gets a TxProfile in W; equal shares, what a car does not take
 * passes to the others, every session gets at least a minimum (6 A on one
 * phase), and sessions that cannot get it wait at 0: full cars first, then
 * the latest.
 */
import type { JsonObject, OcppVersion } from '@ocpp-mimic/core';

export interface SiteDefinition {
  /** The grid capacity the site's sessions share, in W. */
  capacityW: number;
  /** The stations behind it (their chargeBoxIds). */
  stations: string[];
  /** The least a session is given; below it a session waits at 0. Default 1380 W (6 A at 230 V). */
  minimumW?: number;
}

export const DEFAULT_MINIMUM_W = 1380;

/** A running session as the CSMS sees it from the station's messages. */
export interface SessionLoad {
  stationId: string;
  /** The 1.6 connectorId or the 2.x evseId. */
  evseId: number;
  /** A number on 1.6, a string on 2.x. */
  transactionId: number | string;
  /** When the CSMS learnt of it; earlier sessions keep their power first. */
  startedAt: number;
  /** The power it last reported (Power.Active.Import), in W. */
  measuredW?: number;
  /** The EV takes no power (SuspendedEV), for example because it is full. */
  evSuspended: boolean;
  /** The limit last sent, in W. */
  limitW?: number;
}

export const sessionKey = (s: { stationId: string; evseId: number }) =>
  `${s.stationId} ${s.evseId}`;

/**
 * A session takes clearly less than its limit when it draws under 90 % of it
 * and 300 W below; it then needs only a little above what it draws.
 */
function demandOf(session: SessionLoad, minimumW: number): number {
  if (session.evSuspended) return minimumW;
  const { measuredW, limitW } = session;
  if (measuredW !== undefined && limitW !== undefined && measuredW < limitW * 0.9 - 300) {
    return Math.max(minimumW, measuredW * 1.1 + 300);
  }
  return Infinity;
}

/**
 * The limit for each session (by sessionKey). Sessions whose car takes power
 * come first, then cars in SuspendedEV (a full car must not keep a charging
 * one waiting), each group earliest first; as many as fit the capacity at the
 * minimum each are admitted, the rest get 0. Admitted sessions share the
 * capacity by water-filling: equal shares, a session that needs less than its
 * share gets what it needs, the others split the rest.
 */
export function allocate(
  capacityW: number,
  sessions: readonly SessionLoad[],
  minimumW = DEFAULT_MINIMUM_W,
): Map<string, number> {
  const limits = new Map<string, number>();
  const ordered = [...sessions].sort(
    (a, b) =>
      Number(a.evSuspended) - Number(b.evSuspended) ||
      a.startedAt - b.startedAt ||
      sessionKey(a).localeCompare(sessionKey(b)),
  );
  const fits = minimumW > 0 ? Math.floor(Math.max(0, capacityW) / minimumW) : ordered.length;
  const admitted = ordered.slice(0, fits);
  for (const session of ordered.slice(fits)) limits.set(sessionKey(session), 0);
  let left = Math.max(0, capacityW);
  let open = admitted;
  while (open.length > 0) {
    const share = left / open.length;
    const under = open.filter((s) => demandOf(s, minimumW) <= share);
    if (under.length === 0) {
      for (const s of open) limits.set(sessionKey(s), Math.floor(share));
      break;
    }
    for (const s of under) {
      const need = Math.round(demandOf(s, minimumW));
      limits.set(sessionKey(s), need);
      left -= need;
    }
    open = open.filter((s) => demandOf(s, minimumW) > share);
  }
  return limits;
}

/** Whether a new limit is worth a SetChargingProfile: it moved by more than 5 % and 250 W. */
export function worthSending(previousW: number | undefined, nextW: number): boolean {
  if (previousW === undefined) return true;
  if ((previousW === 0) !== (nextW === 0)) return true;
  const moved = Math.abs(nextW - previousW);
  return moved > 250 && moved > Math.max(previousW, nextW) * 0.05;
}

/** The profile id the CSMS uses for its site limits on an EVSE, so each one replaces the last. */
export const siteProfileId = (evseId: number) => 9000 + evseId;

/** SetChargingProfile for a session's limit, in the station's version. */
export function siteLimitRequest(
  ocpp: OcppVersion,
  session: SessionLoad,
  limitW: number,
): JsonObject {
  const period = [{ startPeriod: 0, limit: limitW }];
  const id = siteProfileId(session.evseId);
  if (ocpp === '1.6') {
    return {
      connectorId: session.evseId,
      csChargingProfiles: {
        chargingProfileId: id,
        transactionId: Number(session.transactionId),
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Relative',
        chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: period },
      },
    };
  }
  return {
    evseId: session.evseId,
    chargingProfile: {
      id,
      stackLevel: 1,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Relative',
      transactionId: String(session.transactionId),
      chargingSchedule: [{ id, chargingRateUnit: 'W', chargingSchedulePeriod: period }],
    },
  };
}

/** A SetChargingProfile the site manager sent, for the site's history. */
export interface SentLimit {
  at: string;
  stationId: string;
  evseId: number;
  limitW: number;
  status: string;
}

/** What `GET /api/sites/<id>` answers with. */
export interface SiteState extends Required<SiteDefinition> {
  id: string;
  /** The limits now, summed, and the power the sessions last reported, summed (W). */
  allocatedW: number;
  measuredW: number;
  sessions: (Omit<SessionLoad, 'startedAt'> & { state: 'charging' | 'ev-suspended' | 'waiting' })[];
  /** The latest SetChargingProfile messages, newest first. */
  sent: SentLimit[];
}

/** The station side the manager needs: its version, and sending it a CALL. */
export interface SiteStation {
  ocpp: OcppVersion;
  call(action: string, payload: JsonObject): Promise<{ ok: boolean; status?: string }>;
}

export interface SiteLoadOptions {
  station(chargeBoxId: string): SiteStation | undefined;
  now?: () => number;
  /** How long to wait for more news before re-allocating, in ms. Default 200. */
  settleMs?: number;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The last Power.Active.Import in a list of meter values, in W. */
function powerIn(meterValue: unknown): number | undefined {
  if (!Array.isArray(meterValue)) return undefined;
  let found: number | undefined;
  for (const value of meterValue) {
    if (!isObject(value) || !Array.isArray(value.sampledValue)) continue;
    for (const sample of value.sampledValue) {
      if (!isObject(sample) || sample.measurand !== 'Power.Active.Import') continue;
      if (sample.phase !== undefined) continue;
      const unit = isObject(sample.unitOfMeasure) ? sample.unitOfMeasure.unit : sample.unit;
      const multiplier = isObject(sample.unitOfMeasure)
        ? 10 ** Number(sample.unitOfMeasure.multiplier ?? 0)
        : 1;
      const number = Number(sample.value) * multiplier * (unit === 'kW' ? 1000 : 1);
      if (Number.isFinite(number)) found = number;
    }
  }
  return found;
}

export interface SiteLoad {
  /** Creates or replaces a site; its sessions are re-allocated at once. */
  setSite(id: string, site: SiteDefinition): SiteState;
  /** Removes a site and clears the limits it set. */
  deleteSite(id: string): boolean;
  site(id: string): SiteState | undefined;
  /** Sees a station CALL and the CSMS's answer to it. */
  observe(chargeBoxId: string, action: string, payload: JsonObject, reply: JsonObject): void;
  /** Stops pending work. */
  stop(): void;
}

export function createSiteLoad(options: SiteLoadOptions): SiteLoad {
  const now = options.now ?? Date.now;
  const settleMs = options.settleMs ?? 200;
  const sites = new Map<string, Required<SiteDefinition>>();
  const sessions = new Map<string, SessionLoad>();
  const sent = new Map<string, SentLimit[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const siteOf = (stationId: string) =>
    [...sites.entries()].find(([, site]) => site.stations.includes(stationId))?.[0];
  const sessionsOf = (site: Required<SiteDefinition>) =>
    [...sessions.values()].filter((s) => site.stations.includes(s.stationId));

  function schedule(siteId: string | undefined, delay = settleMs): void {
    if (siteId === undefined || timers.has(siteId)) return;
    timers.set(
      siteId,
      setTimeout(() => {
        timers.delete(siteId);
        void reallocate(siteId);
      }, delay),
    );
  }

  async function reallocate(siteId: string): Promise<void> {
    const site = sites.get(siteId);
    if (site === undefined) return;
    const running = sessionsOf(site);
    const limits = allocate(site.capacityW, running, site.minimumW);
    await Promise.all(
      running.map(async (session) => {
        const limitW = limits.get(sessionKey(session)) ?? 0;
        if (!worthSending(session.limitW, limitW)) return;
        const station = options.station(session.stationId);
        if (station === undefined) return;
        session.limitW = limitW;
        const answer = await station
          .call('SetChargingProfile', siteLimitRequest(station.ocpp, session, limitW))
          .catch(() => ({ ok: false, status: 'no answer' }));
        if (!answer.ok || answer.status !== 'Accepted') delete session.limitW;
        const history = sent.get(siteId) ?? [];
        history.unshift({
          at: new Date(now()).toISOString(),
          stationId: session.stationId,
          evseId: session.evseId,
          limitW,
          status: answer.status ?? (answer.ok ? 'Accepted' : 'error'),
        });
        sent.set(siteId, history.slice(0, 50));
      }),
    );
  }

  function stateOf(id: string): SiteState | undefined {
    const site = sites.get(id);
    if (site === undefined) return undefined;
    const running = sessionsOf(site);
    return {
      id,
      ...site,
      allocatedW: running.reduce((sum, s) => sum + (s.limitW ?? 0), 0),
      measuredW: running.reduce((sum, s) => sum + (s.measuredW ?? 0), 0),
      sessions: running.map(({ startedAt: _startedAt, ...s }) => ({
        ...s,
        state: s.limitW === 0 ? 'waiting' : s.evSuspended ? 'ev-suspended' : 'charging',
      })),
      sent: sent.get(id) ?? [],
    };
  }

  function clear(stationIds: readonly string[]): void {
    for (const session of sessions.values()) {
      if (!stationIds.includes(session.stationId) || session.limitW === undefined) continue;
      const station = options.station(session.stationId);
      delete session.limitW;
      const id = siteProfileId(session.evseId);
      void station
        ?.call('ClearChargingProfile', station.ocpp === '1.6' ? { id } : { chargingProfileId: id })
        .catch(() => {});
    }
  }

  return {
    setSite(id, site) {
      const before = sites.get(id);
      const next = { minimumW: DEFAULT_MINIMUM_W, ...site, stations: [...site.stations] };
      sites.set(id, next);
      if (before !== undefined) clear(before.stations.filter((s) => !next.stations.includes(s)));
      schedule(id, 0);
      return stateOf(id) as SiteState;
    },
    deleteSite(id) {
      const site = sites.get(id);
      if (site === undefined) return false;
      sites.delete(id);
      sent.delete(id);
      clear(site.stations);
      return true;
    },
    site: stateOf,
    observe(stationId, action, payload, reply) {
      const station = options.station(stationId);
      const v16 = station?.ocpp === '1.6';
      const keyOf = (evseId: number) => sessionKey({ stationId, evseId });
      const bySession = (transactionId: unknown) =>
        [...sessions.values()].find(
          (s) => s.stationId === stationId && String(s.transactionId) === String(transactionId),
        );
      let touched = false;
      if (action === 'StartTransaction' && typeof reply.transactionId === 'number') {
        const evseId = Number(payload.connectorId);
        sessions.set(keyOf(evseId), {
          stationId,
          evseId,
          transactionId: reply.transactionId,
          startedAt: now(),
          evSuspended: false,
        });
        touched = true;
      } else if (action === 'StopTransaction') {
        const session = bySession(payload.transactionId);
        if (session !== undefined) touched = sessions.delete(sessionKey(session));
      } else if (action === 'StatusNotification' && v16) {
        const session = sessions.get(keyOf(Number(payload.connectorId)));
        if (session !== undefined && (payload.status === 'SuspendedEV') !== session.evSuspended) {
          session.evSuspended = payload.status === 'SuspendedEV';
          touched = true;
        }
      } else if (action === 'MeterValues' && v16) {
        const session = sessions.get(keyOf(Number(payload.connectorId)));
        const power = powerIn(payload.meterValue);
        if (session !== undefined && power !== undefined) {
          session.measuredW = power;
          touched = true;
        }
      } else if (action === 'TransactionEvent') {
        const info = isObject(payload.transactionInfo) ? payload.transactionInfo : {};
        const transactionId = info.transactionId;
        let session = bySession(transactionId);
        if (payload.eventType === 'Ended') {
          if (session !== undefined) touched = sessions.delete(sessionKey(session));
        } else {
          const evse = isObject(payload.evse) ? Number(payload.evse.id) : undefined;
          if (session === undefined && evse !== undefined && typeof transactionId === 'string') {
            session = {
              stationId,
              evseId: evse,
              transactionId,
              startedAt: now(),
              evSuspended: false,
            };
            sessions.set(keyOf(evse), session);
            touched = true;
          }
          if (session !== undefined) {
            if (typeof info.chargingState === 'string') {
              const suspended = info.chargingState === 'SuspendedEV';
              if (suspended !== session.evSuspended) touched = true;
              session.evSuspended = suspended;
            }
            const power = powerIn(payload.meterValue);
            if (power !== undefined) {
              session.measuredW = power;
              touched = true;
            }
          }
        }
      }
      if (touched) schedule(siteOf(stationId));
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** A site from a request body, or what is wrong with it. */
export function parseSite(body: Record<string, unknown>): SiteDefinition | string {
  const { capacityW, stations, minimumW } = body;
  if (typeof capacityW !== 'number' || !Number.isFinite(capacityW) || capacityW < 0) {
    return '"capacityW" must be a number of watts, 0 or more';
  }
  if (
    !Array.isArray(stations) ||
    stations.length === 0 ||
    stations.some((s) => typeof s !== 'string' || s === '')
  ) {
    return '"stations" must be a list of station ids';
  }
  if (
    minimumW !== undefined &&
    (typeof minimumW !== 'number' || !Number.isFinite(minimumW) || minimumW < 0)
  ) {
    return '"minimumW" must be a number of watts, 0 or more';
  }
  return {
    capacityW,
    stations: stations as string[],
    ...(minimumW !== undefined && { minimumW: minimumW as number }),
  };
}
