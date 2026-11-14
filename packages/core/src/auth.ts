/**
 * Authorization: the cache of IdTagInfo answers and the decision a charge
 * point makes when a card is presented.
 */
import { configBool, type ConfigState } from './config.js';
import type { IdTagInfo } from './ocpp16-messages.js';

/** idTag → the latest IdTagInfo the CSMS gave for it. */
export type AuthorizationCache = Readonly<Record<string, IdTagInfo>>;

export const EMPTY_AUTHORIZATION_CACHE: AuthorizationCache = {};

/** True when the status is Accepted and the expiry date, if any, is still ahead. */
export function isAccepted(info: IdTagInfo, now: number): boolean {
  if (info.status !== 'Accepted') return false;
  return info.expiryDate === undefined || Date.parse(info.expiryDate) > now;
}

/**
 * Records the IdTagInfo from an Authorize, StartTransaction or
 * StopTransaction response. Does nothing when AuthorizationCacheEnabled is
 * false.
 */
export function rememberAuthorization(
  cache: AuthorizationCache,
  config: ConfigState,
  idTag: string,
  info: IdTagInfo,
): AuthorizationCache {
  if (!configBool(config, 'AuthorizationCacheEnabled')) return cache;
  return { ...cache, [idTag]: info };
}

/** Answers ClearCache. */
export function clearAuthorizationCache(): AuthorizationCache {
  return EMPTY_AUTHORIZATION_CACHE;
}

/** The cached answer for `idTag`, if the cache is enabled and holds one. */
export function cachedAuthorization(
  cache: AuthorizationCache,
  config: ConfigState,
  idTag: string,
): IdTagInfo | undefined {
  if (!configBool(config, 'AuthorizationCacheEnabled')) return undefined;
  return cache[idTag];
}

/**
 * What to do when a card is presented locally:
 * - `start`: start the transaction without asking the CSMS first;
 * - `ask`: send Authorize and act on the answer;
 * - `reject`: refuse.
 *
 * An entry in the Local Authorization List (when LocalAuthListEnabled) takes
 * priority over the cache. Online, a known Accepted card starts at once only
 * with LocalPreAuthorize. Offline, it starts with LocalAuthorizeOffline; a
 * card on the local list that is not Accepted is refused, and a card neither
 * list nor cache knows starts only with AllowOfflineTxForUnknownId.
 */
export function decideLocalAuthorization(input: {
  cache: AuthorizationCache;
  config: ConfigState;
  idTag: string;
  online: boolean;
  now: number;
  localList?: Readonly<Record<string, IdTagInfo>>;
}): 'start' | 'ask' | 'reject' {
  const { config, online, now } = input;
  const listed =
    input.localList !== undefined && configBool(config, 'LocalAuthListEnabled')
      ? input.localList[input.idTag]
      : undefined;
  if (listed !== undefined) {
    const ok = isAccepted(listed, now);
    if (online) return ok && configBool(config, 'LocalPreAuthorize') ? 'start' : 'ask';
    return ok && configBool(config, 'LocalAuthorizeOffline') ? 'start' : 'reject';
  }
  const cached = cachedAuthorization(input.cache, config, input.idTag);
  const cachedOk = cached !== undefined && isAccepted(cached, now);
  if (online) {
    return cachedOk && configBool(config, 'LocalPreAuthorize') ? 'start' : 'ask';
  }
  if (cachedOk && configBool(config, 'LocalAuthorizeOffline')) return 'start';
  if (cached === undefined && configBool(config, 'AllowOfflineTxForUnknownId')) return 'start';
  return 'reject';
}
