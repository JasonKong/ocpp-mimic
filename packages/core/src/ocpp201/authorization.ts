/**
 * OCPP 2.0.1 authorization without the CSMS: the Authorization Cache (C10
 * to C12), the Local Authorization List (C13, C14, D01, D02), and the local
 * decision for a presented IdToken. Pure; the station keeps the state.
 */
import type { IdTokenInfoType, IdTokenType, Ocpp21RequestOf } from '../ocpp21/messages.js';

/** The cache and list key of a token: its type and value. */
export const tokenKey = (token: Pick<IdTokenType, 'idToken' | 'type'>) =>
  `${token.type}:${token.idToken}`;

type Info = Omit<IdTokenInfoType, 'customData'>;

export interface CacheEntry {
  idTokenInfo: Info;
  /** When the token was last presented or answered (ms since the epoch). */
  lastUsed: number;
}
/** tokenKey → entry, least recently used first. */
export type AuthCache201 = Record<string, CacheEntry>;

export const AUTH_CACHE_SIZE = 100;

/**
 * Adds or updates a token's answer (C10.FR.04, .05). A full cache drops
 * entries that are not Accepted first, then the one used longest ago
 * (C10.FR.07).
 */
export function rememberToken(
  cache: AuthCache201,
  token: IdTokenType,
  info: Info,
  now: number,
): AuthCache201 {
  const key = tokenKey(token);
  const { [key]: _old, ...rest } = cache;
  const entries = Object.entries(rest);
  while (entries.length >= AUTH_CACHE_SIZE) {
    const notAccepted = entries.findIndex(([, e]) => e.idTokenInfo.status !== 'Accepted');
    entries.splice(notAccepted >= 0 ? notAccepted : 0, 1);
  }
  const next: AuthCache201 = Object.create(null) as AuthCache201;
  for (const [k, e] of entries) next[k] = e;
  next[key] = { idTokenInfo: info, lastUsed: now };
  return next;
}

/**
 * A token's cached answer, unless it expired: at cacheExpiryDateTime when
 * the answer had one (C10.FR.13), otherwise AuthCacheLifeTime after it was
 * last used (C10.FR.08).
 */
export function cachedToken(
  cache: AuthCache201,
  token: IdTokenType,
  now: number,
  lifeTimeS: number,
): Info | undefined {
  const entry = cache[tokenKey(token)];
  if (entry === undefined) return undefined;
  const expiry = entry.idTokenInfo.cacheExpiryDateTime;
  const expiresAt =
    expiry !== undefined ? Date.parse(expiry) : entry.lastUsed + Math.max(0, lifeTimeS) * 1000;
  return now >= expiresAt ? undefined : entry.idTokenInfo;
}

export interface LocalList201 {
  /** 0: no list installed (D01.FR.18). */
  version: number;
  /** tokenKey → answer. */
  entries: Record<string, Info>;
}

export const EMPTY_LOCAL_LIST_201: LocalList201 = { version: 0, entries: {} };

/**
 * Applies a SendLocalList (D01): Full replaces the list, Differential adds
 * or updates entries with idTokenInfo and removes those without; the
 * version becomes the request's. Failed beyond `maxEntries` or for a version
 * of 0 or less, VersionMismatch for a Differential update not newer than the
 * list (D01.FR.19).
 */
export function applyLocalList(
  list: LocalList201,
  request: Ocpp21RequestOf<'SendLocalList'>,
  maxEntries: number,
): { status: 'Accepted' | 'Failed' | 'VersionMismatch'; list: LocalList201 } {
  if (request.versionNumber <= 0) return { status: 'Failed', list };
  const items = request.localAuthorizationList ?? [];
  const keys = items.map((item) => tokenKey(item.idToken));
  if (new Set(keys).size !== keys.length) return { status: 'Failed', list };
  let entries: Record<string, Info>;
  if (request.updateType === 'Full') {
    entries = {};
    for (const item of items) {
      if (item.idTokenInfo !== undefined) entries[tokenKey(item.idToken)] = strip(item.idTokenInfo);
    }
  } else {
    if (request.versionNumber <= list.version) return { status: 'VersionMismatch', list };
    entries = { ...list.entries };
    for (const item of items) {
      const key = tokenKey(item.idToken);
      if (item.idTokenInfo === undefined) delete entries[key];
      else entries[key] = strip(item.idTokenInfo);
    }
  }
  if (Object.keys(entries).length > maxEntries) return { status: 'Failed', list };
  return { status: 'Accepted', list: { version: request.versionNumber, entries } };
}

function strip(info: IdTokenInfoType): Info {
  const { customData: _dropped, ...rest } = info;
  return rest;
}

export interface AuthorizationSettings {
  online: boolean;
  /** LocalAuthListCtrlr.Enabled (and the profile supported). */
  listEnabled: boolean;
  /** AuthCacheCtrlr.Enabled. */
  cacheEnabled: boolean;
  /** AuthCacheCtrlr.LifeTime, seconds. */
  cacheLifeTimeS: number;
  localPreAuthorize: boolean;
  localAuthorizeOffline: boolean;
  offlineTxForUnknownIdEnabled: boolean;
  disableRemoteAuthorization: boolean;
  /** AuthCacheCtrlr.DisablePostAuthorize. */
  disablePostAuthorize: boolean;
}

export type LocalDecision =
  /** Start without the CSMS; `info` is what the list or cache knew, if anything. */
  | { decision: 'start'; info?: Info; unknownOffline?: boolean }
  /** Ask the CSMS with Authorize. */
  | { decision: 'ask' }
  | { decision: 'reject'; info?: Info };

/**
 * What to do with a presented token: the Local Authorization List first
 * (C13.FR.01), then the cache, then the CSMS when online (C12, C14) or the
 * offline rules (C13, C15).
 */
export function decideToken(
  token: IdTokenType,
  cache: AuthCache201,
  list: LocalList201,
  settings: AuthorizationSettings,
  now: number,
): LocalDecision {
  const listed = settings.listEnabled ? list.entries[tokenKey(token)] : undefined;
  const cached = settings.cacheEnabled
    ? cachedToken(cache, token, now, settings.cacheLifeTimeS)
    : undefined;
  if (settings.online) {
    if (listed !== undefined) {
      return listed.status === 'Accepted'
        ? { decision: 'start', info: listed }
        : { decision: 'ask' };
    }
    if (cached !== undefined) {
      if (cached.status === 'Accepted') {
        return settings.localPreAuthorize
          ? { decision: 'start', info: cached }
          : { decision: 'ask' };
      }
      return settings.disablePostAuthorize
        ? { decision: 'reject', info: cached }
        : { decision: 'ask' };
    }
    return settings.disableRemoteAuthorization ? { decision: 'reject' } : { decision: 'ask' };
  }
  if (listed !== undefined) {
    return listed.status === 'Accepted'
      ? { decision: 'start', info: listed }
      : { decision: 'reject', info: listed };
  }
  if (cached !== undefined) {
    return cached.status === 'Accepted' && settings.localAuthorizeOffline
      ? { decision: 'start', info: cached }
      : { decision: 'reject', info: cached };
  }
  return settings.offlineTxForUnknownIdEnabled
    ? { decision: 'start', unknownOffline: true }
    : { decision: 'reject' };
}

/** Whether two tokens belong to the same group (C09): an equal groupIdToken. */
export function sameGroup(a: Info | undefined, b: Info | undefined): boolean {
  const ga = a?.groupIdToken;
  const gb = b?.groupIdToken;
  return ga !== undefined && gb !== undefined && tokenKey(ga) === tokenKey(gb);
}
