/**
 * Whether a station's CSMS is ocpp-mimic's built-in CSMS, and remote starts
 * through its control API. Only CSMSs on this machine are asked: an external
 * CSMS never gets a request it did not expect, and against one a remote start
 * must come from that CSMS itself.
 */
import { BUILTIN_CSMS_SERVICE } from './builtin-csms.js';

export type CsmsKind = 'builtin' | 'external';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The HTTP origin of a ws:// or wss:// CSMS URL on this machine; undefined for any other. */
export function localControlOrigin(csmsUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(csmsUrl);
  } catch {
    return undefined;
  }
  if (!LOOPBACK.has(url.hostname)) return undefined;
  const protocol =
    url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : undefined;
  return protocol === undefined ? undefined : `${protocol}//${url.host}`;
}

/** Asks a local CSMS's `/api/health` whether it is the built-in CSMS. */
export async function probeCsms(csmsUrl: string, timeoutMs = 2000): Promise<CsmsKind> {
  const origin = localControlOrigin(csmsUrl);
  if (origin === undefined) return 'external';
  try {
    const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return 'external';
    const body = (await res.json()) as { service?: unknown };
    return body.service === BUILTIN_CSMS_SERVICE ? 'builtin' : 'external';
  } catch {
    return 'external';
  }
}

export interface RemoteStartRequest {
  evseId?: number;
  idToken: { idToken: string; type?: string };
}

/** Has the built-in CSMS send a remote start to the station; resolves with its HTTP answer. */
export function remoteStartVia(
  csmsUrl: string,
  stationId: string,
  request: RemoteStartRequest,
  apiToken?: string,
): Promise<{ status: number; body: unknown }> {
  return controlVia(csmsUrl, stationId, 'remote-start', request, apiToken);
}

/**
 * Sends a command (`remote-start`, `remote-stop`, `auto-start`, ...) to the
 * built-in CSMS's control API for a station; resolves with its HTTP answer.
 */
export async function controlVia(
  csmsUrl: string,
  stationId: string,
  command: string,
  body: object,
  apiToken?: string,
): Promise<{ status: number; body: unknown }> {
  const origin = localControlOrigin(csmsUrl);
  if (origin === undefined) throw new Error('the station does not use a CSMS on this machine');
  const res = await fetch(`${origin}/api/stations/${encodeURIComponent(stationId)}/${command}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiToken !== undefined && { authorization: `Bearer ${apiToken}` }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

/** A site request (`PUT`, `GET`, `DELETE /api/sites/<id>`) to the built-in CSMS's control API. */
export function siteVia(
  csmsUrl: string,
  method: 'PUT' | 'GET' | 'DELETE',
  siteId: string,
  body?: object,
  apiToken?: string,
): Promise<{ status: number; body: unknown }> {
  return requestVia(csmsUrl, method, `/api/sites/${encodeURIComponent(siteId)}`, body, apiToken);
}

/** Any request to the built-in CSMS's control API, at `path`. */
export async function requestVia(
  csmsUrl: string,
  method: 'PUT' | 'GET' | 'DELETE',
  path: string,
  body?: object,
  apiToken?: string,
): Promise<{ status: number; body: unknown }> {
  const origin = localControlOrigin(csmsUrl);
  if (origin === undefined) throw new Error('the site does not use a CSMS on this machine');
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(apiToken !== undefined && { authorization: `Bearer ${apiToken}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}
