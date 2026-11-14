/**
 * The engine process: the persona registry, the state store, the fleet of
 * virtual charge points, the event recorder, and the HTTP / WebSocket API
 * (plus the Web UI's static files) on one port.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { handleApi, sendJson, type ApiEvent } from './api.js';
import { createFleet, type Fleet } from './fleet.js';
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
}

export interface Engine {
  start(): Promise<{ url: string }>;
  stop(): Promise<void>;
  /** Available after start(). */
  readonly fleet: Fleet | undefined;
  readonly personas: PersonaRegistry | undefined;
  readonly recorder: Recorder;
}

export function createEngine(options: EngineOptions = {}): Engine {
  const { port = DEFAULT_PORT, host = '127.0.0.1' } = options;
  const recorder = createRecorder();
  let fleet: Fleet | undefined;
  let personas: PersonaRegistry | undefined;
  let store: StateStore | undefined;
  const events = new WebSocketServer({ noServer: true });
  const stationUpdates = new Map<string, ReturnType<typeof setTimeout>>();
  /** Energy changes without events while charging, so charging stations are pushed every 2 s. */
  let liveTimer: ReturnType<typeof setInterval> | undefined;

  function broadcast(event: ApiEvent): void {
    const text = JSON.stringify(event);
    for (const client of events.clients) if (client.readyState === client.OPEN) client.send(text);
  }

  recorder.subscribe((entry) => broadcast({ type: 'record', entry }));

  /** Coalesces bursts of changes into one station update per 100 ms. */
  function scheduleStationUpdate(stationId: string): void {
    if (stationUpdates.has(stationId)) return;
    stationUpdates.set(
      stationId,
      setTimeout(() => {
        stationUpdates.delete(stationId);
        const station = fleet?.get(stationId);
        if (station !== undefined) broadcast({ type: 'station', station: station.snapshot() });
        else broadcast({ type: 'station-removed', stationId });
      }, 100),
    );
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (fleet === undefined || personas === undefined) {
      sendJson(res, 503, { error: 'the engine is starting' });
      return;
    }
    if (await handleApi(req, res, { fleet, personas, recorder })) return;
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
      for (const station of fleet?.list() ?? []) {
        ws.send(
          JSON.stringify({ type: 'station', station: station.snapshot() } satisfies ApiEvent),
        );
      }
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

    async start() {
      personas = await loadPersonas([BUILT_IN_PERSONAS_DIR, ...(options.personaDirs ?? [])]);
      if (options.storePath !== undefined) store = openStateStore(options.storePath);
      fleet = createFleet({
        personas,
        ...(store !== undefined && { store }),
        ...(options.allowedCsms !== undefined && { allowedCsms: options.allowedCsms }),
        ...(options.backoff !== undefined && { backoff: options.backoff }),
        onEvent: (event) => {
          if (event.type === 'charge-point') {
            const cpEvent = event.event;
            if (
              cpEvent.type === 'rpc' &&
              (cpEvent.event.type === 'sent' || cpEvent.event.type === 'received')
            ) {
              recorder.frame(
                event.stationId,
                cpEvent.event.type === 'sent' ? 'cp-to-csms' : 'csms-to-cp',
                cpEvent.event.text,
              );
            } else if (cpEvent.type === 'log') {
              recorder.log(event.stationId, cpEvent.message);
            } else if (cpEvent.type === 'changed') {
              scheduleStationUpdate(event.stationId);
            }
          } else if (event.event.type === 'state') {
            recorder.log(event.stationId, `connection ${event.event.state}`);
            scheduleStationUpdate(event.stationId);
          }
        },
      });
      await fleet.restore();
      const running = fleet;
      liveTimer = setInterval(() => {
        for (const station of running.list()) {
          const snapshot = station.snapshot();
          if (snapshot.connectors.some((c) => c.powerW > 0))
            broadcast({ type: 'station', station: snapshot });
        }
      }, 2000);
      liveTimer.unref();

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
      for (const timer of stationUpdates.values()) clearTimeout(timer);
      stationUpdates.clear();
      for (const client of events.clients) client.terminate();
      await fleet?.shutdown();
      store?.close();
      await new Promise<void>((resolve) => events.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
