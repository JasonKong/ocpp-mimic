import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OCPP16_SUBPROTOCOL, VERSION } from '@ocpp-mimic/core';

export const DEFAULT_PORT = 7300;

export interface EngineOptions {
  /** Port for the HTTP API; 0 picks a free one. Defaults to {@link DEFAULT_PORT}. */
  port?: number;
  /** Interface to bind. Defaults to 127.0.0.1 so the API is not exposed to the network. */
  host?: string;
}

export interface Engine {
  start(): Promise<{ url: string }>;
  stop(): Promise<void>;
}

export function createEngine(options: EngineOptions = {}): Engine {
  const { port = DEFAULT_PORT, host = '127.0.0.1' } = options;
  const server = createServer(handleRequest);

  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const { port: boundPort } = server.address() as AddressInfo;
          resolve({ url: `http://${host}:${boundPort}` });
        });
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && req.url === '/api/health') {
    sendJson(res, 200, { status: 'ok', version: VERSION, ocpp: [OCPP16_SUBPROTOCOL] });
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
