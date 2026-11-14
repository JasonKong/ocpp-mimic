import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_CACHE_SIZE,
  cachedAuthorization,
  clearAuthorizationCache,
  decideLocalAuthorization,
  EMPTY_AUTHORIZATION_CACHE,
  isAccepted,
  rememberAuthorization,
} from './auth.js';
import { createConfig, type ConfigState } from './config.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const config = createConfig({ numberOfConnectors: 1 });
const withValues = (values: Record<string, string>): ConfigState =>
  createConfig({ numberOfConnectors: 1, values });

describe('isAccepted', () => {
  it('requires Accepted and an expiry date still ahead', () => {
    expect(isAccepted({ status: 'Accepted' }, NOW)).toBe(true);
    expect(isAccepted({ status: 'Accepted', expiryDate: '2026-11-15T00:00:00Z' }, NOW)).toBe(true);
    expect(isAccepted({ status: 'Accepted', expiryDate: '2026-11-13T00:00:00Z' }, NOW)).toBe(false);
    for (const status of ['Blocked', 'Expired', 'Invalid', 'ConcurrentTx'] as const) {
      expect(isAccepted({ status }, NOW)).toBe(false);
    }
  });
});

describe('authorization cache', () => {
  it('remembers answers and forgets them on ClearCache', () => {
    const cache = rememberAuthorization(EMPTY_AUTHORIZATION_CACHE, config, 'TAG', {
      status: 'Accepted',
    });
    expect(cachedAuthorization(cache, config, 'TAG')).toEqual({ status: 'Accepted' });
    expect(cachedAuthorization(clearAuthorizationCache(), config, 'TAG')).toBeUndefined();
  });

  it('neither stores nor reads anything when AuthorizationCacheEnabled is false', () => {
    const off = withValues({ AuthorizationCacheEnabled: 'false' });
    const cache = rememberAuthorization(EMPTY_AUTHORIZATION_CACHE, off, 'TAG', {
      status: 'Accepted',
    });
    expect(cache).toBe(EMPTY_AUTHORIZATION_CACHE);
    const filled = rememberAuthorization(EMPTY_AUTHORIZATION_CACHE, config, 'TAG', {
      status: 'Accepted',
    });
    expect(cachedAuthorization(filled, off, 'TAG')).toBeUndefined();
  });
});

describe('decideLocalAuthorization', () => {
  const accepted = rememberAuthorization(EMPTY_AUTHORIZATION_CACHE, config, 'OK', {
    status: 'Accepted',
  });
  const blocked = rememberAuthorization(EMPTY_AUTHORIZATION_CACHE, config, 'BAD', {
    status: 'Blocked',
  });
  const decide = (cache: typeof accepted, idTag: string, online: boolean, cfg = config) =>
    decideLocalAuthorization({ cache, config: cfg, idTag, online, now: NOW });

  it('asks the CSMS when online, unless LocalPreAuthorize trusts a cached Accepted', () => {
    expect(decide(accepted, 'OK', true)).toBe('ask');
    expect(decide(accepted, 'OK', true, withValues({ LocalPreAuthorize: 'true' }))).toBe('start');
    expect(decide(blocked, 'BAD', true, withValues({ LocalPreAuthorize: 'true' }))).toBe('ask');
  });

  it('uses the cache offline when LocalAuthorizeOffline allows it', () => {
    expect(decide(accepted, 'OK', false)).toBe('start');
    expect(decide(accepted, 'OK', false, withValues({ LocalAuthorizeOffline: 'false' }))).toBe(
      'reject',
    );
    expect(decide(blocked, 'BAD', false)).toBe('reject');
  });

  it('starts offline for unknown cards only with AllowOfflineTxForUnknownId', () => {
    expect(decide(EMPTY_AUTHORIZATION_CACHE, 'NEW', false)).toBe('reject');
    expect(
      decide(
        EMPTY_AUTHORIZATION_CACHE,
        'NEW',
        false,
        withValues({ AllowOfflineTxForUnknownId: 'true' }),
      ),
    ).toBe('start');
    expect(decide(blocked, 'BAD', false, withValues({ AllowOfflineTxForUnknownId: 'true' }))).toBe(
      'reject',
    );
  });

  it('keeps the authorization cache to its size, dropping the card seen longest ago', () => {
    const config = createConfig({ numberOfConnectors: 1 });
    let cache = EMPTY_AUTHORIZATION_CACHE;
    for (let i = 0; i < AUTHORIZATION_CACHE_SIZE + 5; i++) {
      cache = rememberAuthorization(cache, config, `TAG-${i}`, { status: 'Accepted' });
    }
    // Seeing TAG-5 again makes it the newest.
    cache = rememberAuthorization(cache, config, 'TAG-5', { status: 'Blocked' });
    cache = rememberAuthorization(cache, config, 'NEW', { status: 'Accepted' });
    expect(Object.keys(cache)).toHaveLength(AUTHORIZATION_CACHE_SIZE);
    expect(cache['TAG-5']).toEqual({ status: 'Blocked' });
    expect(cache['TAG-6']).toBeUndefined();
    expect(cache['TAG-7']).toBeDefined();
    expect(Object.keys(cache).slice(-2)).toEqual(['TAG-5', 'NEW']);
  });
});
