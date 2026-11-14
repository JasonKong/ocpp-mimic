/**
 * The engine's HTTP API. Everything the Web UI does goes through here, so
 * every action is also available to scripts and curl.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BEHAVIOUR,
  OCPP16_SUBPROTOCOL,
  VERSION,
  type ChargePointBehaviour,
  type Fault,
} from '@ocpp-mimic/core';
import type { Fleet, VirtualStation } from './fleet.js';
import type { PersonaRegistry } from './personas.js';
import type { RecordEntry, Recorder } from './recorder.js';
import type { StationDefinition } from './state-store.js';

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
}

interface Request {
  method: string;
  params: string[];
  query: URLSearchParams;
  body: () => Promise<Record<string, unknown>>;
}

type Handler = (request: Request, context: Context) => Promise<unknown> | unknown;

const NO_CONTENT = Symbol('no content');

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

  route('GET', '/api/personas', (_request, { personas }) => ({
    personas: personas.list().map((persona) => ({
      id: persona.id,
      description: persona.definition.description,
      connectors: persona.definition.connectors,
      boot: persona.definition.boot,
      faults: persona.definition.faults ?? [],
      warnings: persona.warnings,
    })),
    errors: personas.errors,
  })),

  route('GET', '/api/stations', (_request, { fleet }) => ({
    stations: fleet.list().map((station) => station.snapshot()),
  })),

  route(
    'POST',
    '/api/stations',
    async (request, { fleet }) => {
      const body = await request.body();
      const config = body.config;
      if (
        config !== undefined &&
        (typeof config !== 'object' || config === null || Array.isArray(config))
      ) {
        throw new HttpError(400, '"config" must be an object of strings');
      }
      const definition: StationDefinition = {
        id: stringField(body, 'id', true),
        persona: stringField(body, 'persona', true),
        csmsUrl: stringField(body, 'csmsUrl', true),
        ...(body.password !== undefined && { password: stringField(body, 'password') ?? '' }),
        ...(config !== undefined && {
          config: Object.fromEntries(
            Object.entries(config).map(([key, value]) => [key, String(value)]),
          ),
        }),
      };
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

  route('PATCH', '/api/stations/:param/behaviour', async (request, context) => {
    const station = stationOf(context, request.params[0]);
    station.chargePoint.setBehaviour(behaviourChanges(await request.body()));
    return station.snapshot();
  }),

  route(
    'POST',
    '/api/stations/:param/connectors/:param/plug',
    connectorAction((s, c) => s.chargePoint.plugIn(c)),
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
    } else {
      sendJson(res, found.status ?? 200, result);
    }
  } catch (error) {
    if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
    else sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

/** What the /api/events WebSocket pushes. */
export type ApiEvent =
  | { type: 'record'; entry: RecordEntry }
  | { type: 'station'; station: ReturnType<VirtualStation['snapshot']> }
  | { type: 'station-removed'; stationId: string };
