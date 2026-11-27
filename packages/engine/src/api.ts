/**
 * The engine's HTTP API. Everything the Web UI does goes through here, so
 * every action is also available to scripts and curl.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BEHAVIOUR,
  expandIdPattern,
  ID_TOKEN_TYPES,
  nameProblem,
  OCPP16_SUBPROTOCOL,
  OCPP201_SUBPROTOCOL,
  OCPP21_SUBPROTOCOL,
  parseInjection,
  parseRampUp,
  tagsProblem,
  tariffProblems,
  UsageOverrideSchema,
  validate,
  VERSION,
  type RampUp,
  type UsageOverride,
  type ChargePointBehaviour,
  type Fault,
  type PluggedEv,
  type ChargePoint201,
  type TerminalCard,
  type WebPaymentLimits,
  type ReferenceTariff,
} from '@ocpp-mimic/core';
import { controlVia, probeCsms, siteVia } from './csms/probe.js';
import { resolveEv } from './evs.js';
import { exportLog } from './logs/export.js';
import type { Fleet, StationSnapshot, VirtualStation } from './fleet.js';
import type { Metrics } from './metrics.js';
import type { PersonaRegistry } from './personas.js';
import type { RecordEntry, Recorder } from './recorder.js';
import type { SessionService, SessionSummary } from './sessions.js';
import type { StationDefinition, StationSecurity } from './state-store.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Context {
  fleet: Fleet;
  personas: PersonaRegistry;
  recorder: Recorder;
  metrics?: Metrics;
  sessions?: SessionService | undefined;
  /** The built-in CSMS's control API token, for remote starts through it. */
  csmsApiToken?: string;
}

interface Request {
  method: string;
  params: string[];
  query: URLSearchParams;
  body: () => Promise<Record<string, unknown>>;
}

type Handler = (request: Request, context: Context) => Promise<unknown> | unknown;

const NO_CONTENT = Symbol('no content');

/** A body that is not JSON, offered as a download. */
class FileResponse {
  constructor(
    readonly contentType: string,
    readonly body: string,
    readonly filename: string,
  ) {}
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  status?: number;
}

const SEGMENT = '([^/]+)';

function route(method: string, path: string, handler: Handler, status?: number): Route {
  const pattern = new RegExp(`^${path.replaceAll(':param', SEGMENT)}$`);
  return { method, pattern, handler, ...(status !== undefined && { status }) };
}

function stationOf(context: Context, id: string | undefined): VirtualStation {
  const station = id === undefined ? undefined : context.fleet.get(id);
  if (station === undefined) throw new HttpError(404, `no station ${String(id)}`);
  return station;
}

function sessionsOf(context: Context): SessionService {
  if (context.sessions === undefined)
    throw new HttpError(404, 'sessions are not tracked by this engine');
  return context.sessions;
}

function sessionNumber(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new HttpError(400, 'a session number is a whole number from 1');
  return n;
}

function connectorIdOf(station: VirtualStation, value: string | undefined): number {
  const connectorId = Number(value);
  if (!station.snapshot().connectors.some((c) => c.connectorId === connectorId)) {
    throw new HttpError(404, `station ${station.id} has no connector ${String(value)}`);
  }
  return connectorId;
}

/** A station's `security`: profile 0 to 3 and PEM file paths on the engine's machine. */
function securityField(value: unknown): StationSecurity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, '"security" must be an object');
  }
  const security = value as Record<string, unknown>;
  const unknown = Object.keys(security).filter(
    (key) => !['profile', 'ca', 'cert', 'key', 'manufacturerRoot'].includes(key),
  );
  if (unknown.length > 0)
    throw new HttpError(400, `"security" has unknown fields: ${unknown.join(', ')}`);
  const { profile } = security;
  if (
    profile !== undefined &&
    !(Number.isInteger(profile) && Number(profile) >= 0 && Number(profile) <= 3)
  ) {
    throw new HttpError(400, '"security.profile" must be 0, 1, 2 or 3');
  }
  const ca = stringField(security, 'ca');
  const cert = stringField(security, 'cert');
  const key = stringField(security, 'key');
  const manufacturerRoot = stringField(security, 'manufacturerRoot');
  return {
    ...(profile !== undefined && { profile: Number(profile) }),
    ...(ca !== undefined && { ca }),
    ...(cert !== undefined && { cert }),
    ...(key !== undefined && { key }),
    ...(manufacturerRoot !== undefined && { manufacturerRoot }),
  };
}

function stringField(body: Record<string, unknown>, name: string, required: true): string;
function stringField(
  body: Record<string, unknown>,
  name: string,
  required?: false,
): string | undefined;
function stringField(
  body: Record<string, unknown>,
  name: string,
  required = false,
): string | undefined {
  const value = body[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `"${name}" must be a non-empty string`);
  }
  return value;
}

function multiplierField(body: Record<string, unknown>): number {
  const value = body.energyMultiplier;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, '"energyMultiplier" must be a number above 0');
  }
  return value;
}

/** Reads a partial set of behaviour switches; unknown names and non-booleans are errors. */
function behaviourChanges(body: Record<string, unknown>): Partial<ChargePointBehaviour> {
  const changes: Partial<ChargePointBehaviour> = {};
  for (const [name, value] of Object.entries(body)) {
    if (!(name in DEFAULT_BEHAVIOUR)) {
      throw new HttpError(
        400,
        `unknown switch "${name}" (known: ${Object.keys(DEFAULT_BEHAVIOUR).join(', ')})`,
      );
    }
    if (typeof value !== 'boolean') throw new HttpError(400, `"${name}" must be true or false`);
    changes[name as keyof ChargePointBehaviour] = value;
  }
  return changes;
}

/** The EV for a plug-in, with lookup errors as 400. */
function evOf(station: VirtualStation, value: unknown): PluggedEv | undefined {
  try {
    return resolveEv(station, value);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
}

/** `deviceModel`: an object of components, each an object of variables with scalar values. */
function deviceModelField(value: unknown): Record<string, Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(value)) throw new HttpError(400, '"deviceModel" must be an object of components');
  const out: Record<string, Record<string, string>> = {};
  for (const [component, variables] of Object.entries(value)) {
    if (!isObject(variables)) {
      throw new HttpError(400, `"deviceModel.${component}" must be an object of variables`);
    }
    out[component] = {};
    for (const [variable, v] of Object.entries(variables)) {
      if (!['string', 'number', 'boolean'].includes(typeof v)) {
        throw new HttpError(
          400,
          `"deviceModel.${component}.${variable}" must be a string, number or boolean`,
        );
      }
      out[component][variable] = String(v);
    }
  }
  return out;
}

/**
 * A station definition from a request body (`id` given separately for
 * templates). Unknown fields are ignored, as before.
 */
function definitionFrom(body: Record<string, unknown>, id: string): StationDefinition {
  const config = body.config;
  if (
    config !== undefined &&
    (typeof config !== 'object' || config === null || Array.isArray(config))
  ) {
    throw new HttpError(400, '"config" must be an object of strings');
  }
  const deviceModel = deviceModelField(body.deviceModel);
  if (body.tags !== undefined) {
    const problem = tagsProblem(body.tags);
    if (problem !== undefined) throw new HttpError(400, `"tags": ${problem}`);
  }
  if (body.group !== undefined) {
    const problem = nameProblem(body.group, 'the group');
    if (problem !== undefined) throw new HttpError(400, `"group": ${problem}`);
  }
  if (body.usage !== undefined && typeof body.usage !== 'boolean') {
    const checked = validate(UsageOverrideSchema, body.usage);
    if (!checked.ok) {
      throw new HttpError(
        400,
        checked.issues.map((i) => `"usage"${i.path.slice(1)}: ${i.message}`).join('; '),
      );
    }
  }
  if (body.seed !== undefined && !(Number.isInteger(body.seed) && Number(body.seed) >= 0)) {
    throw new HttpError(400, '"seed" must be a whole number of 0 or more');
  }
  return {
    id,
    persona: stringField(body, 'persona', true),
    csmsUrl: stringField(body, 'csmsUrl', true),
    ...(body.password !== undefined && { password: stringField(body, 'password') ?? '' }),
    ...(config !== undefined && {
      config: Object.fromEntries(
        Object.entries(config).map(([key, value]) => [key, String(value)]),
      ),
    }),
    ...(deviceModel !== undefined && { deviceModel }),
    ...(body.energyMultiplier !== undefined && {
      energyMultiplier: multiplierField(body),
    }),
    ...(body.security !== undefined && { security: securityField(body.security) }),
    ...(body.tags !== undefined && { tags: body.tags as string[] }),
    ...(body.group !== undefined && { group: body.group as string }),
    ...(body.usage !== undefined && { usage: body.usage as boolean | UsageOverride }),
    ...(body.seed !== undefined && { seed: body.seed as number }),
  };
}

function rampUpField(value: unknown): RampUp | false {
  const parsed = parseRampUp(value);
  if (!parsed.ok) throw new HttpError(400, parsed.problem);
  return parsed.ramp;
}

/** How a station's connection stands, for filters and summaries. */
export type ConnectionState = 'connected' | 'connecting' | 'offline' | 'stopped';

export function connectionState(snapshot: StationSnapshot): ConnectionState {
  if (!snapshot.running || snapshot.transport === 'stopped') return 'stopped';
  if (snapshot.transport === 'open') return 'connected';
  if (snapshot.transport === 'offline' || snapshot.transport === 'half-open') return 'offline';
  return 'connecting';
}

export interface StationSummary {
  id: string;
  persona: string;
  /** The OCPP version the station speaks. */
  ocpp: string;
  group?: string;
  tags: string[];
  state: ConnectionState;
  registration: string;
  connectors: { connectorId: number; status: string }[];
}

/** The few fields a fleet list needs. */
export function stationSummary(snapshot: StationSnapshot): StationSummary {
  return {
    id: snapshot.id,
    persona: snapshot.persona,
    ocpp: snapshot.ocpp,
    ...(snapshot.group !== undefined && { group: snapshot.group }),
    tags: snapshot.tags,
    state: connectionState(snapshot),
    registration: snapshot.registration,
    connectors: snapshot.connectors.map((c) => ({
      connectorId: c.connectorId,
      status: c.status,
      ...(c.chargingState !== undefined && { chargingState: c.chargingState }),
    })),
  };
}

/**
 * The stations a bulk action applies to: `{ ids?, tag?, group? }` (all must
 * match), or `{ all: true }`. An empty selector is refused, so a slip cannot
 * stop or delete the whole fleet.
 */
function select(fleet: Fleet, body: Record<string, unknown>): VirtualStation[] {
  const { ids, tag, group, all } = body;
  if (ids === undefined && tag === undefined && group === undefined && all !== true) {
    throw new HttpError(400, 'select stations with "ids", "tag" or "group", or "all": true');
  }
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
    throw new HttpError(400, '"ids" must be a list of station ids');
  }
  if (tag !== undefined && typeof tag !== 'string')
    throw new HttpError(400, '"tag" must be a name');
  if (group !== undefined && typeof group !== 'string') {
    throw new HttpError(400, '"group" must be a name');
  }
  const wanted = ids === undefined ? undefined : new Set(ids as string[]);
  return fleet.list().filter((station) => {
    const { definition } = station;
    if (wanted !== undefined && !wanted.has(station.id)) return false;
    if (tag !== undefined && !(definition.tags ?? []).includes(tag)) return false;
    if (group !== undefined && definition.group !== group) return false;
    return true;
  });
}

/** Runs `fn` on a connector, then answers with the station's snapshot. */
/** A 2.1 station, or 404 for a feature only 2.1 has. */
function station21(station: VirtualStation, what: string): ChargePoint201 {
  if (station.chargePoint.ocpp !== '2.1') {
    throw new HttpError(
      404,
      `station ${station.id} speaks OCPP ${station.chargePoint.ocpp}, without ${what}`,
    );
  }
  return station.chargePoint as ChargePoint201;
}

const WEB_PAYMENT_ERRORS: Record<
  'not-supported' | 'disabled' | 'no-hmac' | 'unknown-connector',
  string
> = {
  'not-supported': "the station's persona has no WebPayments feature",
  disabled: 'WebPaymentsCtrlr.Enabled is false',
  'no-hmac': 'the station has no HMAC-SHA256 for the payment code',
  'unknown-connector': 'no such EVSE',
};

function connectorAction(
  fn: (
    station: VirtualStation,
    connectorId: number,
    body: Record<string, unknown>,
    context: Context,
  ) => unknown,
): Handler {
  return async (request, context) => {
    const station = stationOf(context, request.params[0]);
    const connectorId = connectorIdOf(station, request.params[1]);
    const result = await fn(station, connectorId, await request.body(), context);
    return result ?? station.snapshot();
  };
}

/**
 * Sends a command to the station's CSMS through its control API, when that
 * CSMS is ocpp-mimic's built-in one (409 otherwise); answers with its answer.
 */
async function viaBuiltinCsms(
  station: VirtualStation,
  context: Context,
  command: string,
  what: string,
  body: object,
): Promise<unknown> {
  const csmsUrl = station.definition.csmsUrl;
  if ((station.snapshot().csms ?? (await probeCsms(csmsUrl))) !== 'builtin') {
    throw new HttpError(
      409,
      `the station's CSMS is not ocpp-mimic's built-in CSMS: ${what} must come from that CSMS`,
    );
  }
  const answer = await controlVia(csmsUrl, station.id, command, body, context.csmsApiToken);
  if (answer.status !== 200) {
    const message = (answer.body as { error?: unknown } | undefined)?.error;
    throw new HttpError(
      502,
      `the built-in CSMS answered ${answer.status}: ${String(message ?? '')}`,
    );
  }
  return answer.body;
}

/** Which built-in CSMS holds each site, per fleet, learnt when the site was set through here. */
const siteCsms = new WeakMap<object, Map<string, string>>();
const sitesOf = (context: Context) => {
  let sites = siteCsms.get(context.fleet);
  if (sites === undefined) {
    sites = new Map();
    siteCsms.set(context.fleet, sites);
  }
  return sites;
};

/** Answers with the CSMS's answer to a site request, its errors as HTTP errors. */
async function relaySite(
  context: Context,
  csmsUrl: string,
  method: 'PUT' | 'GET' | 'DELETE',
  siteId: string,
  body?: object,
): Promise<unknown> {
  const answer = await siteVia(csmsUrl, method, siteId, body, context.csmsApiToken);
  if (answer.status !== 200) {
    const message = (answer.body as { error?: unknown } | undefined)?.error;
    throw new HttpError(
      answer.status === 400 || answer.status === 404 ? answer.status : 502,
      String(message ?? `the built-in CSMS answered ${answer.status}`),
    );
  }
  return answer.body;
}

/** The CSMS a site was set on through this engine, or 404. */
function siteCsmsOf(context: Context, siteId: string | undefined): string {
  const csmsUrl = sitesOf(context).get(siteId ?? '');
  if (csmsUrl === undefined) throw new HttpError(404, `no site ${String(siteId)}`);
  return csmsUrl;
}

const routes: Route[] = [
  route('GET', '/api/health', () => ({
    status: 'ok',
    version: VERSION,
    ocpp: [OCPP16_SUBPROTOCOL, OCPP201_SUBPROTOCOL, OCPP21_SUBPROTOCOL],
  })),

  route('GET', '/api/metrics', (_request, { metrics }) => {
    if (metrics === undefined) throw new HttpError(404, 'no metrics');
    return metrics.summary();
  }),

  route('GET', '/api/personas', (_request, { personas }) => ({
    personas: personas.list().map((persona) => ({
      id: persona.id,
      ocpp: persona.ocpp,
      description: persona.definition.description,
      connectors: persona.definition.connectors,
      ...(persona.ocpp !== '1.6' && { features: persona.options.features }),
      boot: persona.definition.boot,
      power: persona.definition.power ?? {},
      faults: persona.definition.faults ?? [],
      evs: persona.definition.evs ?? {},
      warnings: persona.warnings,
    })),
    errors: personas.errors,
  })),

  route('GET', '/api/stations', (request, { fleet }) => {
    const tag = request.query.get('tag');
    const group = request.query.get('group');
    const state = request.query.get('state');
    const view = request.query.get('view');
    if (state !== null && !['connected', 'connecting', 'offline', 'stopped'].includes(state)) {
      throw new HttpError(400, '"state" must be connected, connecting, offline or stopped');
    }
    if (view !== null && view !== 'summary' && view !== 'full') {
      throw new HttpError(400, '"view" must be summary or full');
    }
    const snapshots = fleet
      .list()
      .filter(({ definition }) => tag === null || (definition.tags ?? []).includes(tag))
      .filter(({ definition }) => group === null || definition.group === group)
      .map((station) => station.snapshot())
      .filter((snapshot) => state === null || connectionState(snapshot) === state);
    return { stations: view === 'summary' ? snapshots.map(stationSummary) : snapshots };
  }),

  // Bulk routes come before /api/stations/:param, which would match them too.
  route(
    'POST',
    '/api/stations/bulk',
    async (request, { fleet }) => {
      const body = await request.body();
      const pattern = stringField(body, 'id', true);
      const expanded = expandIdPattern(pattern, Number(body.count));
      if (!expanded.ok) throw new HttpError(400, expanded.problem);
      const taken = expanded.ids.find((id) => fleet.get(id) !== undefined);
      if (taken !== undefined) throw new HttpError(409, `station ${taken} already exists`);
      const rampUp = rampUpField(body.rampUp);
      const definitions = expanded.ids.map((id) => definitionFrom(body, id));
      try {
        fleet.addMany(definitions, { start: body.start !== false, rampUp });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      return { created: definitions.length, ids: expanded.ids };
    },
    201,
  ),

  route('POST', '/api/stations/bulk/:param', async (request, { fleet }) => {
    const action = request.params[0];
    const body = await request.body();
    const stations = select(fleet, body);
    const ids = stations.map((station) => station.id);
    switch (action) {
      case 'start':
        fleet.startMany(ids, rampUpField(body.rampUp));
        break;
      case 'stop':
        await fleet.stopMany(ids);
        break;
      case 'offline':
        for (const station of stations) station.transport.goOffline('clean');
        break;
      case 'online':
        for (const station of stations) station.transport.goOnline();
        break;
      default:
        throw new HttpError(404, `no bulk action ${String(action)} (start, stop, offline, online)`);
    }
    return { stations: ids.length, ids };
  }),

  route('DELETE', '/api/stations/bulk', async (request, context) => {
    const stations = select(context.fleet, await request.body());
    const ids = stations.map((station) => station.id);
    await context.fleet.removeMany(ids);
    for (const id of ids) {
      context.recorder.forget(id);
      context.metrics?.forget(id);
      context.sessions?.forget(id);
    }
    return { deleted: ids.length };
  }),

  route(
    'POST',
    '/api/stations',
    async (request, { fleet }) => {
      const body = await request.body();
      const definition = definitionFrom(body, stringField(body, 'id', true));
      if (definition.id === 'bulk') {
        throw new HttpError(400, '"bulk" is reserved for the bulk routes; pick another id');
      }
      if (fleet.get(definition.id) !== undefined) {
        throw new HttpError(409, `station ${definition.id} already exists`);
      }
      try {
        return fleet.add(definition, { start: body.start !== false }).snapshot();
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
    },
    201,
  ),

  route('GET', '/api/stations/:param', (request, context) =>
    stationOf(context, request.params[0]).snapshot(),
  ),

  route('DELETE', '/api/stations/:param', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    await context.fleet.remove(station.id);
    context.recorder.forget(station.id);
    context.metrics?.forget(station.id);
    context.sessions?.forget(station.id);
    return NO_CONTENT;
  }),

  route('POST', '/api/stations/:param/start', (request, context) => {
    const station = stationOf(context, request.params[0]);
    context.fleet.start(station.id);
    return station.snapshot();
  }),

  route('POST', '/api/stations/:param/stop', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    await context.fleet.stop(station.id);
    return station.snapshot();
  }),

  route('POST', '/api/stations/:param/offline', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    const mode = (await request.body()).mode ?? 'clean';
    if (mode !== 'clean' && mode !== 'half-open') {
      throw new HttpError(400, '"mode" must be "clean" or "half-open"');
    }
    station.transport.goOffline(mode);
    return station.snapshot();
  }),

  route('POST', '/api/stations/:param/online', (request, context) => {
    const station = stationOf(context, request.params[0]);
    station.transport.goOnline();
    return station.snapshot();
  }),

  route('GET', '/api/stations/:param/injections', (request, context) => ({
    injections: stationOf(context, request.params[0]).injector.list(),
  })),

  route('POST', '/api/stations/:param/injections', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    const parsed = parseInjection(await request.body());
    if (!parsed.ok) {
      throw new HttpError(400, parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    }
    try {
      context.fleet.inject(station.id, parsed.request);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    return stationOf(context, station.id).snapshot();
  }),

  route('DELETE', '/api/stations/:param/injections', (request, context) => {
    const station = stationOf(context, request.params[0]);
    station.injector.clear();
    return station.snapshot();
  }),

  route('POST', '/api/stations/:param/security-events', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    const body = await request.body();
    const type = stringField(body, 'type', true);
    const techInfo = stringField(body, 'techInfo');
    if (type.length > 50) throw new HttpError(400, '"type" must be at most 50 characters');
    station.chargePoint.securityEvent(type, techInfo);
    return station.snapshot();
  }),

  route('PATCH', '/api/stations/:param/energy-multiplier', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    station.chargePoint.setEnergyMultiplier(multiplierField(await request.body()));
    return station.snapshot();
  }),

  route('PATCH', '/api/stations/:param/usage', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    const { enabled } = await request.body();
    if (typeof enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false');
    try {
      context.fleet.setUsage(station.id, enabled);
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
    return station.snapshot();
  }),

  route('PATCH', '/api/stations/:param/behaviour', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    station.chargePoint.setBehaviour(behaviourChanges(await request.body()));
    return station.snapshot();
  }),

  route(
    'POST',
    '/api/stations/:param/connectors/:param/plug',
    connectorAction((s, c, body) => s.chargePoint.plugIn(c, evOf(s, body.ev))),
  ),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/unplug',
    connectorAction((s, c) => {
      if (s.chargePoint.unplug(c) === 'locked') {
        throw new HttpError(
          409,
          `connector ${c} is locked; unlock it or end the transaction first`,
        );
      }
    }),
  ),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/ev-suspend',
    connectorAction((s, c) => s.chargePoint.evSuspend(c)),
  ),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/priority',
    connectorAction((s, c, body) => {
      // The driver's priority charging button on a 2.1 station (K22).
      if (s.chargePoint.ocpp !== '2.1') {
        throw new HttpError(
          404,
          `station ${s.id} speaks OCPP ${s.chargePoint.ocpp}, without priority charging`,
        );
      }
      if (typeof body.activate !== 'boolean')
        throw new HttpError(400, '"activate" must be true or false');
      return {
        result: (s.chargePoint as ChargePoint201).priorityCharging(c, body.activate),
        station: s.snapshot(),
      };
    }),
  ),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/ev-needs',
    connectorAction((s, c, body) => {
      // The driver or the EV changes the target or the departure (K20 for ISO 15118-20).
      if (s.chargePoint.ocpp === '1.6') {
        throw new HttpError(404, `station ${s.id} speaks OCPP 1.6, without charging needs`);
      }
      const changes: { targetSoc?: number; departureMinutes?: number; minimumSoc?: number } = {};
      for (const name of ['targetSoc', 'departureMinutes', 'minimumSoc'] as const) {
        if (body[name] === undefined) continue;
        if (typeof body[name] !== 'number') throw new HttpError(400, `"${name}" must be a number`);
        changes[name] = body[name];
      }
      if (Object.keys(changes).length === 0) {
        throw new HttpError(400, 'give targetSoc, departureMinutes or minimumSoc');
      }
      let result: string;
      try {
        result = (s.chargePoint as ChargePoint201).changeEvNeeds(c, changes);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      if (result === 'no-ev') throw new HttpError(409, `no EV on connector ${c}`);
      return { result, station: s.snapshot() };
    }),
  ),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/payment',
    connectorAction(async (s, c, body) => {
      // A card at the EVSE's payment terminal on a 2.1 station (C18): how the PSP
      // answers comes with the card (decline, the settlement, raising the amount).
      const station = station21(s, 'a payment terminal');
      const settlement = stringField(body, 'settlement');
      if (settlement !== undefined && !['Settled', 'Rejected', 'Failed'].includes(settlement)) {
        throw new HttpError(400, '"settlement" must be Settled, Rejected or Failed');
      }
      const card: TerminalCard = {};
      for (const name of [
        'brand',
        'recognition',
        'readingMethod',
        'cardBin',
        'last4',
        'expiry',
      ] as const) {
        const value = stringField(body, name);
        if (value !== undefined) card[name] = value;
      }
      for (const name of ['decline', 'declineIncrement'] as const) {
        if (body[name] === undefined) continue;
        if (typeof body[name] !== 'boolean')
          throw new HttpError(400, `"${name}" must be true or false`);
        card[name] = body[name];
      }
      if (settlement !== undefined)
        card.settlement = settlement as 'Settled' | 'Rejected' | 'Failed';
      return { result: await station.presentPaymentCard(c, card), station: s.snapshot() };
    }),
  ),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/payment/stop',
    connectorAction((s, c) => ({
      // The driver stops at the terminal: canceled before the start (C19), else it ends.
      result: station21(s, 'a payment terminal').stopPayment(c),
      station: s.snapshot(),
    })),
  ),
  route('GET', '/api/stations/:param/connectors/:param/payment-url', async (request, context) => {
    // The dynamic QR code's URL now (C25), with the limits a driver chose.
    const s = stationOf(context, request.params[0]);
    const connectorId = connectorIdOf(s, request.params[1]);
    const limits: WebPaymentLimits = {};
    for (const [parameter, key] of [
      ['maxenergy', 'maxEnergy'],
      ['maxtime', 'maxTime'],
      ['maxcost', 'maxCost'],
    ] as const) {
      const text = request.query.get(parameter);
      if (text === null) continue;
      const value = Number(text);
      if (text === '' || !Number.isFinite(value) || value <= 0) {
        throw new HttpError(400, `"${parameter}" must be a positive number`);
      }
      limits[key] = value;
    }
    const result = station21(s, 'web payments').webPaymentUrl(connectorId, limits);
    if ('error' in result) {
      throw new HttpError(
        result.error === 'unknown-connector' ? 404 : 409,
        WEB_PAYMENT_ERRORS[result.error],
      );
    }
    return result;
  }),
  route('POST', '/api/stations/:param/vat-number', async (request, context) => {
    // A VAT number the driver entered, for the CSMS to check (C18.FR.08).
    const s = stationOf(context, request.params[0]);
    const body = await request.body();
    const vatNumber = stringField(body, 'vatNumber', true);
    if (vatNumber === '' || vatNumber.length > 20) {
      throw new HttpError(400, '"vatNumber" must be 1 to 20 characters');
    }
    let evseId: number | undefined;
    if (body.evseId !== undefined) evseId = connectorIdOf(s, String(body.evseId));
    return station21(s, 'VAT number checks').validateVatNumber(evseId, vatNumber);
  }),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/ev-resume',
    connectorAction((s, c) => s.chargePoint.evResume(c)),
  ),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/id-tag',
    connectorAction(async (s, c, body) => {
      // A 2.x station takes an IdToken type (default ISO14443); 1.6 has none. 2.0.1's
      // types are an enumeration; 2.1's are any string of up to 20 characters.
      const type = stringField(body, 'type', false);
      if (s.chargePoint.ocpp === '2.1') {
        if (type !== undefined && (type === '' || type.length > 20)) {
          throw new HttpError(400, '"type" must be 1 to 20 characters');
        }
      } else if (type !== undefined && !ID_TOKEN_TYPES.includes(type)) {
        throw new HttpError(400, `"type" must be one of ${ID_TOKEN_TYPES.join(', ')}`);
      }
      return {
        result: await s.chargePoint.presentIdTag(c, stringField(body, 'idTag', true), type),
        station: s.snapshot(),
      };
    }),
  ),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/fault',
    connectorAction((s, c, body) => {
      const errorCode = stringField(body, 'errorCode', true);
      if (errorCode === 'NoError') throw new HttpError(400, '"errorCode" cannot be NoError');
      const info = stringField(body, 'info');
      const vendorErrorCode = stringField(body, 'vendorErrorCode');
      s.chargePoint.raiseFault(c, {
        errorCode: errorCode as Fault['errorCode'],
        ...(info !== undefined && { info }),
        ...(vendorErrorCode !== undefined && { vendorErrorCode }),
      });
    }),
  ),
  route(
    'DELETE',
    '/api/stations/:param/connectors/:param/fault',
    connectorAction((s, c) => s.chargePoint.clearFault(c)),
  ),

  route('GET', '/api/stations/:param/device-model', (request, context) => {
    const station = stationOf(context, request.params[0]);
    if (station.chargePoint.ocpp === '1.6') {
      throw new HttpError(404, `station ${station.id} speaks OCPP 1.6, which has no Device Model`);
    }
    return { variables: (station.chargePoint as ChargePoint201).deviceModelView() };
  }),

  route('PATCH', '/api/stations/:param/device-model', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    if (station.chargePoint.ocpp === '1.6') {
      throw new HttpError(404, `station ${station.id} speaks OCPP 1.6, which has no Device Model`);
    }
    const body = await request.body();
    // As a local operator: the SetVariables checks apply; the answer is its attributeStatus.
    return (station.chargePoint as ChargePoint201).setVariable(
      stringField(body, 'component', true),
      stringField(body, 'variable', true),
      typeof body.value === 'string' ? body.value : stringField(body, 'value', true),
    );
  }),

  route('POST', '/api/stations/:param/remote-start', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    const body = await request.body();
    const token = body.idToken;
    if (
      typeof token !== 'object' ||
      token === null ||
      typeof (token as Record<string, unknown>).idToken !== 'string'
    ) {
      throw new HttpError(400, '"idToken" needs an idToken string');
    }
    const { idToken, type } = token as Record<string, unknown>;
    const evseId = body.evseId;
    if (evseId !== undefined && !(Number.isInteger(evseId) && Number(evseId) > 0)) {
      throw new HttpError(400, '"evseId" must be a whole number from 1');
    }
    return viaBuiltinCsms(station, context, 'remote-start', 'a remote start', {
      idToken: { idToken: idToken as string, ...(typeof type === 'string' && { type }) },
      ...(evseId !== undefined && { evseId: Number(evseId) }),
    });
  }),

  route(
    'POST',
    '/api/stations/:param/connectors/:param/remote-stop',
    connectorAction(async (station, connectorId, _body, context) => {
      // The app stops the session on the connector, by the transaction id the CSMS knows.
      const transactionId = station
        .snapshot()
        .connectors.find((c) => c.connectorId === connectorId)?.transactionId;
      if (transactionId === undefined) {
        throw new HttpError(409, `no transaction the CSMS knows of on connector ${connectorId}`);
      }
      return viaBuiltinCsms(station, context, 'remote-stop', 'a remote stop', { transactionId });
    }),
  ),

  route('POST', '/api/stations/:param/web-payment', async (request, context) => {
    // 2.1: the payment page behind the station's QR code (C25), played by the built-in CSMS.
    const station = stationOf(context, request.params[0]);
    const body = await request.body();
    const url = stringField(body, 'url', true);
    const sharedSecret = stringField(body, 'sharedSecret');
    return viaBuiltinCsms(station, context, 'web-payment', 'a web payment', {
      url,
      ...(sharedSecret !== undefined && { sharedSecret }),
    });
  }),

  route('POST', '/api/stations/:param/auto-start', async (request, context) => {
    // Valet: the built-in CSMS starts a session whenever an EV is plugged in.
    const station = stationOf(context, request.params[0]);
    const body = await request.body();
    const token = body.idToken;
    if (
      token !== null &&
      (typeof token !== 'object' ||
        typeof (token as Record<string, unknown>).idToken !== 'string' ||
        (token as Record<string, unknown>).idToken === '')
    ) {
      throw new HttpError(400, '"idToken" needs an idToken string, or is null to stop');
    }
    return viaBuiltinCsms(station, context, 'auto-start', 'an auto start', { idToken: token });
  }),

  // Site load management: the built-in CSMS shares the site's capacity between its sessions.
  route('PUT', '/api/sites/:param', async (request, context) => {
    const siteId = request.params[0] ?? '';
    const body = await request.body();
    const ids = body.stations;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      throw new HttpError(400, '"stations" must be a list of station ids');
    }
    const stations = (ids as string[]).map((id) => stationOf(context, id));
    const csmsUrl = stations[0]?.definition.csmsUrl ?? '';
    if (stations.some((s) => s.definition.csmsUrl !== csmsUrl)) {
      throw new HttpError(400, "a site's stations must use the same CSMS");
    }
    if ((stations[0]?.snapshot().csms ?? (await probeCsms(csmsUrl))) !== 'builtin') {
      throw new HttpError(
        409,
        "the stations' CSMS is not ocpp-mimic's built-in CSMS: load management must come from that CSMS",
      );
    }
    const answer = await relaySite(context, csmsUrl, 'PUT', siteId, body);
    sitesOf(context).set(siteId, csmsUrl);
    return answer;
  }),
  route('GET', '/api/sites/:param', (request, context) =>
    relaySite(context, siteCsmsOf(context, request.params[0]), 'GET', request.params[0] ?? ''),
  ),
  route('DELETE', '/api/sites/:param', async (request, context) => {
    const siteId = request.params[0] ?? '';
    const answer = await relaySite(context, siteCsmsOf(context, siteId), 'DELETE', siteId);
    sitesOf(context).delete(siteId);
    return answer;
  }),

  route('GET', '/api/tariff', (_request, context) => ({ tariff: sessionsOf(context).tariff() })),

  route('PUT', '/api/tariff', async (request, context) => {
    const body = await request.body();
    const value = 'tariff' in body ? body.tariff : body;
    const problems = tariffProblems(value);
    if (problems.length > 0) throw new HttpError(400, `invalid tariff: ${problems.join('; ')}`);
    sessionsOf(context).setTariff(value as ReferenceTariff);
    return { tariff: sessionsOf(context).tariff() };
  }),

  route('GET', '/api/stations/:param/sessions', (request, context) => {
    const station = stationOf(context, request.params[0]);
    return { sessions: sessionsOf(context).list(station.id) };
  }),

  route('GET', '/api/stations/:param/sessions/:param', (request, context) => {
    const station = stationOf(context, request.params[0]);
    const detail = sessionsOf(context).get(station.id, sessionNumber(request.params[1]));
    if (detail === undefined) throw new HttpError(404, `no session ${request.params[1]}`);
    return detail;
  }),

  route('GET', '/api/stations/:param/sessions/:param/frames', (request, context) => {
    const station = stationOf(context, request.params[0]);
    const n = sessionNumber(request.params[1]);
    const service = sessionsOf(context);
    if (service.get(station.id, n) === undefined) {
      throw new HttpError(404, `no session ${request.params[1]}`);
    }
    const frames = service.frames(station.id, n);
    const format = request.query.get('format');
    if (format === 'jsonl') {
      return new FileResponse(
        'application/x-ndjson; charset=utf-8',
        exportLog(frames),
        `${station.id}-session-${n}.jsonl`,
      );
    }
    if (format !== null && format !== 'json')
      throw new HttpError(400, '"format" must be json or jsonl');
    return { frames };
  }),

  route('GET', '/api/stations/:param/messages', (request, context) => {
    const station = stationOf(context, request.params[0]);
    const format = request.query.get('format');
    if (format === 'jsonl') {
      return new FileResponse(
        'application/x-ndjson; charset=utf-8',
        exportLog(context.recorder.query(station.id, { kind: 'frame' })),
        `${station.id}.jsonl`,
      );
    }
    if (format !== null && format !== 'json')
      throw new HttpError(400, '"format" must be json or jsonl');
    const limit = request.query.get('limit');
    const action = request.query.get('action');
    const kind = request.query.get('kind');
    return {
      entries: context.recorder.query(station.id, {
        ...(limit !== null && { limit: Math.max(1, Number(limit) || 1) }),
        ...(action !== null && { action }),
        ...((kind === 'frame' || kind === 'log') && { kind }),
      }),
    };
  }),
];

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) reject(new HttpError(413, 'request body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        const value: unknown = JSON.parse(text);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          reject(new HttpError(400, 'the body must be a JSON object'));
        } else {
          resolve(value as Record<string, unknown>);
        }
      } catch {
        reject(new HttpError(400, 'the body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Handles `/api/...`; answers false when the path is not an API path. */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  context: Context,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') return false;
  const method = req.method ?? 'GET';
  const matches = routes.filter((r) => r.pattern.test(url.pathname));
  const found = matches.find((r) => r.method === method);
  try {
    if (found === undefined) {
      throw matches.length > 0
        ? new HttpError(405, `${method} is not allowed here`)
        : new HttpError(404, 'Not found');
    }
    const params = (found.pattern.exec(url.pathname) ?? []).slice(1).map(decodeURIComponent);
    let body: Promise<Record<string, unknown>> | undefined;
    const result = await found.handler(
      { method, params, query: url.searchParams, body: () => (body ??= readBody(req)) },
      context,
    );
    if (result === NO_CONTENT) {
      res.writeHead(204).end();
    } else if (result instanceof FileResponse) {
      res.writeHead(found.status ?? 200, {
        'content-type': result.contentType,
        'content-disposition': `attachment; filename="${result.filename.replace(/["\\]/g, '_')}"`,
      });
      res.end(result.body);
    } else {
      sendJson(res, found.status ?? 200, result);
    }
  } catch (error) {
    if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
    else sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

/**
 * What the /api/events WebSocket pushes. Every client gets fleet summaries
 * (all of them on connecting, `full`, then the changed ones at most once a
 * second); records and full snapshots go only to the clients that sent
 * `{ "type": "subscribe", "stations": [...] }` for the station.
 */
export type ApiEvent =
  | { type: 'record'; entry: RecordEntry }
  | { type: 'session'; session: SessionSummary }
  | { type: 'station'; station: ReturnType<VirtualStation['snapshot']> }
  | { type: 'fleet'; stations: StationSummary[]; removed: string[]; full?: true };
