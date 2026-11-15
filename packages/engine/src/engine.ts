/**
 * The engine process: the persona registry, the state store, the fleet of
 * virtual charge points, the event recorder, and the HTTP / WebSocket API
 * (plus the Web UI's static files) on one port.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { VERSION, type OcppVersion, type UsageEvent } from '@ocpp-mimic/core';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleApi, sendJson, stationSummary, type ApiEvent, type StationSummary } from './api.js';
import { createFleet, type Fleet } from './fleet.js';
import { createMetrics, type Metrics } from './metrics.js';
import { startOtlpExporter, type OtlpExporter, type OtlpOptions } from './otlp.js';
import { createSystemClock } from './system-clock.js';
import { loadOcaSchemas, OCA_SCHEMA_DIRS, type OcaSchemas } from './oca-schemas.js';
import { BUILT_IN_PERSONAS_DIR, loadPersonas, type PersonaRegistry } from './personas.js';
import { createRecorder, type Recorder } from './recorder.js';
import { openStateStore, type StateStore } from './state-store.js';
import { serveStatic } from './static.js';
import type { BackoffPolicy } from './transport.js';

export const DEFAULT_PORT = 7300;

export interface EngineOptions {
  /** Port for the HTTP API; 0 picks a free one. Defaults to {@link DEFAULT_PORT}. */
  port?: number;
  /** Interface to bind. Defaults to 127.0.0.1 so the API is not exposed to the network. */
  host?: string;
  /** Extra persona directories, loaded after the built-in personas. */
  personaDirs?: readonly string[];
  /** SQLite file for station state. Without it nothing is persisted. */
  storePath?: string;
  /** CSMS URL prefixes stations may connect to. Default: loopback addresses only. */
  allowedCsms?: readonly string[];
  /** Directory with the built Web UI, served at /. */
  webRoot?: string;
  backoff?: Partial<BackoffPolicy>;
  /** Records the Event Recorder keeps per station (default 1000; 0 keeps none). */
  recordLimit?: number;
  /** Push metrics to an OpenTelemetry collector. */
  otlp?: OtlpOptions;
  /** Names this run in OTLP resource attributes (`ocpp_mimic.run`); random by default. */
  runId?: string;
  /** Problems that do not stop the engine, such as a failing OTLP export. Default console.warn. */
  onWarning?: (message: string) => void;
}

export interface Engine {
  start(): Promise<{ url: string }>;
  stop(): Promise<void>;
  /** Available after start(). */
  readonly fleet: Fleet | undefined;
  readonly personas: PersonaRegistry | undefined;
  readonly recorder: Recorder;
  readonly metrics: Metrics;
}

/** A usage model event as a log line. */
function usageLine(event: UsageEvent): string {
  switch (event.type) {
    case 'arrived':
      return `usage: a driver arrives at connector ${event.connectorId} with ${event.idTag}${event.ev === undefined ? '' : ` and EV ${event.ev}`}`;
    case 'turned-away':
      return `usage: connector ${event.connectorId} is not free; the driver leaves`;
    case 'refused':
      return `usage: ${event.idTag} is refused at connector ${event.connectorId}; the driver gives up`;
    case 'left':
      return `usage: the driver at connector ${event.connectorId} leaves (${event.by === 'card' ? 'card' : 'unplugs'})`;
  }
}

export function createEngine(options: EngineOptions = {}): Engine {
  const { port = DEFAULT_PORT, host = '127.0.0.1' } = options;
  // Every frame is also checked against OCA's official schemas of its station's
  // version; problems show up on the record. A version's set loads when first needed.
  const oca = new Map<OcppVersion, OcaSchemas>();
  const ocaFor = (version: OcppVersion) => {
    let schemas = oca.get(version);
    if (schemas === undefined) {
      schemas = loadOcaSchemas(OCA_SCHEMA_DIRS[version]);
      oca.set(version, schemas);
    }
    return schemas;
  };
  const recorder = createRecorder({
    check: (action, kind, payload, stationId) =>
      ocaFor(fleet?.get(stationId)?.chargePoint.ocpp ?? '1.6').check(action, kind, payload),
    ...(options.recordLimit !== undefined && { limit: options.recordLimit }),
  });
  let fleet: Fleet | undefined;
  let personas: PersonaRegistry | undefined;
  let store: StateStore | undefined;
  let exporter: OtlpExporter | undefined;
  const metrics = createMetrics({
    version: VERSION,
    stations: function* () {
      for (const station of fleet?.list() ?? []) {
        yield {
          id: station.id,
          persona: station.definition.persona,
          ...(station.definition.group !== undefined && { group: station.definition.group }),
          running: station.running,
          transport: station.transport.state,
          queuedMessages: () => station.chargePoint.snapshot().queuedMessages,
        };
      }
    },
    labelsOf: (id) => {
      const definition = fleet?.get(id)?.definition;
      return definition === undefined
        ? undefined
        : { persona: definition.persona, group: definition.group ?? '' };
    },
  });
  const events = new WebSocketServer({ noServer: true });
  /** The stations each events client shows; only they get its records and full snapshots. */
  const subscriptions = new WeakMap<WebSocket, Set<string>>();
  const stationUpdates = new Map<string, ReturnType<typeof setTimeout>>();
  /** Stations whose summary changed since the last fleet batch. */
  const changed = new Set<string>();
  /** Energy changes without events while charging, so charging stations are pushed every 2 s. */
  let liveTimer: ReturnType<typeof setInterval> | undefined;
  let fleetTimer: ReturnType<typeof setInterval> | undefined;

  /** Whether anyone listens on the events WebSocket; without listeners nothing is built for it. */
  const listening = () => events.clients.size > 0;
  const open = () => [...events.clients].filter((client) => client.readyState === client.OPEN);
  const subscribersOf = (stationId: string) =>
    open().filter((client) => subscriptions.get(client)?.has(stationId) === true);

  function sendTo(clients: readonly WebSocket[], event: ApiEvent): void {
    if (clients.length === 0) return;
    const text = JSON.stringify(event);
    for (const client of clients) client.send(text);
  }

  recorder.subscribe((entry) => {
    if (listening()) sendTo(subscribersOf(entry.stationId), { type: 'record', entry });
  });

  /**
   * A station changed: its summary goes out with the next fleet batch (at
   * most once a second), and its subscribers get a full snapshot, coalesced
   * per 100 ms.
   */
  function scheduleStationUpdate(stationId: string): void {
    if (!listening()) return;
    changed.add(stationId);
    if (stationUpdates.has(stationId) || subscribersOf(stationId).length === 0) return;
    stationUpdates.set(
      stationId,
      setTimeout(() => {
        stationUpdates.delete(stationId);
        const station = fleet?.get(stationId);
        if (station !== undefined) {
          sendTo(subscribersOf(stationId), { type: 'station', station: station.snapshot() });
        }
      }, 100),
    );
  }

  /** The station ids the last fleet batch knew, to find added and removed ones. */
  let known = new Set<string>();

  function sendFleetBatch(): void {
    const current = new Set((fleet?.list() ?? []).map((station) => station.id));
    const removed = [...known].filter((id) => !current.has(id));
    for (const id of current) if (!known.has(id)) changed.add(id);
    known = current;
    if ((changed.size === 0 && removed.length === 0) || !listening()) {
      changed.clear();
      return;
    }
    const stations: StationSummary[] = [];
    for (const id of changed) {
      const station = fleet?.get(id);
      if (station !== undefined) stations.push(stationSummary(station.snapshot()));
    }
    changed.clear();
    sendTo(open(), { type: 'fleet', stations, removed });
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (fleet === undefined || personas === undefined) {
      sendJson(res, 503, { error: 'the engine is starting' });
      return;
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics.prometheus());
      return;
    }
    if (await handleApi(req, res, { fleet, personas, recorder, metrics })) return;
    if (options.webRoot !== undefined && (await serveStatic(req, res, options.webRoot))) return;
    sendJson(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/events') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    events.handleUpgrade(req, socket, head, (ws) => {
      // The whole fleet as summaries; full snapshots only for subscribed stations.
      const stations = (fleet?.list() ?? []).map((station) => stationSummary(station.snapshot()));
      sendTo([ws], { type: 'fleet', stations, removed: [], full: true });
      ws.on('message', (data) => {
        let message: unknown;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        const { type, stations: ids } = (message ?? {}) as { type?: unknown; stations?: unknown };
        if (type !== 'subscribe' || !Array.isArray(ids)) return;
        const wanted = new Set(
          ids.filter((id): id is string => typeof id === 'string').slice(0, 100),
        );
        subscriptions.set(ws, wanted);
        for (const id of wanted) {
          const station = fleet?.get(id);
          if (station !== undefined) sendTo([ws], { type: 'station', station: station.snapshot() });
        }
      });
    });
  });

  return {
    get fleet() {
      return fleet;
    },
    get personas() {
      return personas;
    },
    recorder,
    metrics,

    async start() {
      personas = await loadPersonas([BUILT_IN_PERSONAS_DIR, ...(options.personaDirs ?? [])]);
      if (options.storePath !== undefined) store = openStateStore(options.storePath);
      fleet = createFleet({
        personas,
        clock: createSystemClock({ onLate: (ms) => metrics.lateness(ms) }),
        ...(store !== undefined && { store }),
        ...(options.allowedCsms !== undefined && { allowedCsms: options.allowedCsms }),
        ...(options.backoff !== undefined && { backoff: options.backoff }),
        onEvent: (event) => {
          if (event.type === 'frame') {
            // Frames are recorded on the wire, after the Fault Injector.
            const record = recorder.frame(event.stationId, event.direction, event.text, {
              ...(event.injected !== undefined && { injected: event.injected }),
              ...(event.dropped === true && { dropped: true }),
            });
            metrics.frame(record);
          } else if (event.type === 'charge-point') {
            const cpEvent = event.event;
            if (cpEvent.type === 'rpc') {
              metrics.rpc(event.stationId, cpEvent.event);
            } else if (cpEvent.type === 'log') {
              recorder.log(event.stationId, cpEvent.message);
            } else if (cpEvent.type === 'changed') {
              scheduleStationUpdate(event.stationId);
            }
          } else if (event.type === 'injections') {
            scheduleStationUpdate(event.stationId);
          } else if (event.type === 'usage') {
            metrics.usage(event.stationId, event.event);
            recorder.log(event.stationId, usageLine(event.event));
          } else {
            metrics.transport(event.stationId, event.event);
            if (event.event.type === 'state' && event.event.state !== 'open') {
              recorder.closed(event.stationId);
            }
            if (event.event.type === 'state') {
              recorder.log(event.stationId, `connection ${event.event.state}`);
              scheduleStationUpdate(event.stationId);
            }
          }
        },
      });
      await fleet.restore();
      if (options.otlp !== undefined) {
        exporter = startOtlpExporter(options.otlp, {
          families: () => metrics.families(),
          version: VERSION,
          run: options.runId ?? randomUUID(),
          onError: options.onWarning ?? ((message) => console.warn(message)),
        });
      }
      const running = fleet;
      liveTimer = setInterval(() => {
        if (!listening()) return;
        const watched = new Set(open().flatMap((client) => [...(subscriptions.get(client) ?? [])]));
        for (const id of watched) {
          const snapshot = running.get(id)?.snapshot();
          if (snapshot?.connectors.some((c) => c.powerW > 0)) {
            sendTo(subscribersOf(id), { type: 'station', station: snapshot });
          }
        }
      }, 2000);
      liveTimer.unref();
      fleetTimer = setInterval(sendFleetBatch, 1000);
      fleetTimer.unref();

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const { port: boundPort } = server.address() as AddressInfo;
      return { url: `http://${host}:${boundPort}` };
    },

    async stop() {
      if (liveTimer !== undefined) clearInterval(liveTimer);
      if (fleetTimer !== undefined) clearInterval(fleetTimer);
      for (const timer of stationUpdates.values()) clearTimeout(timer);
      stationUpdates.clear();
      for (const client of events.clients) client.terminate();
      await fleet?.shutdown();
      await exporter?.stop();
      metrics.stop();
      store?.close();
      await new Promise<void>((resolve) => events.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
