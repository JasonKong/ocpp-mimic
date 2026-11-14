/**
 * The engine's HTTP API. Everything the Web UI does goes through here, so
 * every action is also available to scripts and curl.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BEHAVIOUR,
  expandIdPattern,
  nameProblem,
  OCPP16_SUBPROTOCOL,
  parseInjection,
  parseRampUp,
  tagsProblem,
  UsageOverrideSchema,
  validate,
  VERSION,
  type RampUp,
  type UsageOverride,
  type ChargePointBehaviour,
  type Fault,
  type PluggedEv,
} from '@ocpp-mimic/core';
import { resolveEv } from './evs.js';
import { exportLog } from './logs/export.js';
import type { Fleet, StationSnapshot, VirtualStation } from './fleet.js';
import type { Metrics } from './metrics.js';
import type { PersonaRegistry } from './personas.js';
import type { RecordEntry, Recorder } from './recorder.js';
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
    ...(snapshot.group !== undefined && { group: snapshot.group }),
    tags: snapshot.tags,
    state: connectionState(snapshot),
    registration: snapshot.registration,
    connectors: snapshot.connectors.map((c) => ({
      connectorId: c.connectorId,
      status: c.status,
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
function connectorAction(
  fn: (station: VirtualStation, connectorId: number, body: Record<string, unknown>) => unknown,
): Handler {
  return async (request, context) => {
    const station = stationOf(context, request.params[0]);
    const connectorId = connectorIdOf(station, request.params[1]);
    const result = await fn(station, connectorId, await request.body());
    return result ?? station.snapshot();
  };
}

const routes: Route[] = [
  route('GET', '/api/health', () => ({
    status: 'ok',
    version: VERSION,
    ocpp: [OCPP16_SUBPROTOCOL],
  })),

  route('GET', '/api/metrics', (_request, { metrics }) => {
    if (metrics === undefined) throw new HttpError(404, 'no metrics');
    return metrics.summary();
  }),

  route('GET', '/api/personas', (_request, { personas }) => ({
    personas: personas.list().map((persona) => ({
      id: persona.id,
      description: persona.definition.description,
      connectors: persona.definition.connectors,
      boot: persona.definition.boot,
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
    '/api/stations/:param/connectors/:param/ev-resume',
    connectorAction((s, c) => s.chargePoint.evResume(c)),
  ),
  route(
    'POST',
    '/api/stations/:param/connectors/:param/id-tag',
    connectorAction(async (s, c, body) => ({
      result: await s.chargePoint.presentIdTag(c, stringField(body, 'idTag', true)),
      station: s.snapshot(),
    })),
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
  | { type: 'station'; station: ReturnType<VirtualStation['snapshot']> }
  | { type: 'fleet'; stations: StationSummary[]; removed: string[]; full?: true };
