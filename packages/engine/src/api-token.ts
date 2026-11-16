/**
 * API tokens for the engine's HTTP API and the built-in CSMS's control API.
 * Without a token nothing is checked, as before; with one, requests need
 * `Authorization: Bearer <token>`. Browsers cannot give a WebSocket headers,
 * so the events WebSocket also takes the token as a subprotocol
 * (`ocpp-mimic.token.<base64url>`), which keeps it out of URLs and logs.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** The subprotocol the events WebSocket speaks, offered next to the token. */
export const EVENTS_PROTOCOL = 'ocpp-mimic';

/** Subprotocols starting with this carry the token, base64url-encoded. */
export const TOKEN_PROTOCOL_PREFIX = 'ocpp-mimic.token.';

/** The environment variable `serve`, `load` and `csms` read the token from. */
export const API_TOKEN_ENV = 'OCPP_MIMIC_API_TOKEN';

/** The subprotocol that carries `token`. */
export function tokenProtocol(token: string): string {
  return TOKEN_PROTOCOL_PREFIX + Buffer.from(token, 'utf8').toString('base64url');
}

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();

/**
 * Whether a request carries the token, compared in constant time (digests of
 * equal length, so the token's length does not leak either). Always true when
 * no token is set.
 */
export function createTokenCheck(token: string | undefined): (req: IncomingMessage) => boolean {
  if (token === undefined || token === '') return () => true;
  const expected = digest(token);
  const matches = (given: string) => timingSafeEqual(digest(given), expected);
  return (req) => {
    const header = req.headers.authorization;
    if (header !== undefined) {
      const [scheme, value] = header.split(/\s+/, 2);
      if (scheme?.toLowerCase() === 'bearer' && value !== undefined && matches(value)) return true;
    }
    const protocols = req.headers['sec-websocket-protocol'];
    for (const protocol of (protocols ?? '').split(',')) {
      const trimmed = protocol.trim();
      if (!trimmed.startsWith(TOKEN_PROTOCOL_PREFIX)) continue;
      const encoded = trimmed.slice(TOKEN_PROTOCOL_PREFIX.length);
      if (matches(Buffer.from(encoded, 'base64url').toString('utf8'))) return true;
    }
    return false;
  };
}

/** The answer to a request without the token. */
export const UNAUTHORIZED = {
  status: 401,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': 'Bearer realm="ocpp-mimic"',
  },
  body: JSON.stringify({ error: 'an API token is required: Authorization: Bearer <token>' }),
} as const;

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);

/** Whether a listen address is reachable only from this machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host);
}

/** The warning for a server that listens beyond loopback without a token, if it does. */
export function exposedWithoutTokenWarning(
  what: string,
  host: string,
  token: string | undefined,
): string | undefined {
  if (isLoopbackHost(host) || (token !== undefined && token !== '')) return undefined;
  return `${what} listens on ${host} without an API token: anyone who can reach it controls it. Set ${API_TOKEN_ENV} or --api-token.`;
}
