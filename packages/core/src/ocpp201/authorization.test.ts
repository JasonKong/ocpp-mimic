import { describe, expect, it } from 'vitest';
import {
  applyLocalList,
  AUTH_CACHE_SIZE,
  cachedToken,
  decideToken,
  EMPTY_LOCAL_LIST_201,
  rememberToken,
  sameGroup,
  tokenKey,
  type AuthorizationSettings,
} from './authorization.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const tag = (idToken: string) => ({ idToken, type: 'ISO14443' as const });
const accepted = { status: 'Accepted' as const };
const blocked = { status: 'Blocked' as const };
const settings = (overrides: Partial<AuthorizationSettings> = {}): AuthorizationSettings => ({
  online: true,
  listEnabled: true,
  cacheEnabled: true,
  cacheLifeTimeS: 3600,
  localPreAuthorize: false,
  localAuthorizeOffline: true,
  offlineTxForUnknownIdEnabled: false,
  disableRemoteAuthorization: false,
  disablePostAuthorize: false,
  ...overrides,
});

describe('the 2.0.1 authorization cache', () => {
  it('expires entries after LifeTime or at cacheExpiryDateTime', () => {
    let cache = rememberToken({}, tag('A'), accepted, T0);
    cache = rememberToken(
      cache,
      tag('B'),
      { status: 'Accepted', cacheExpiryDateTime: '2026-11-15T10:00:10Z' },
      T0,
    );
    expect(cachedToken(cache, tag('A'), T0 + 3_599_000, 3600)).toEqual(accepted);
    expect(cachedToken(cache, tag('A'), T0 + 3_600_000, 3600)).toBeUndefined();
    expect(cachedToken(cache, tag('B'), T0 + 9_000, 3600)).toBeDefined();
    expect(cachedToken(cache, tag('B'), T0 + 10_000, 3600)).toBeUndefined();
    // The type is part of the key.
    expect(cachedToken(cache, { idToken: 'A', type: 'KeyCode' }, T0, 3600)).toBeUndefined();
  });

  it('drops entries that are not Accepted first when full, then the oldest', () => {
    let cache = rememberToken({}, tag('BAD'), blocked, T0);
    for (let i = 0; i < AUTH_CACHE_SIZE - 1; i++)
      cache = rememberToken(cache, tag(`T${i}`), accepted, T0);
    cache = rememberToken(cache, tag('NEW'), accepted, T0);
    expect(Object.keys(cache)).toHaveLength(AUTH_CACHE_SIZE);
    expect(cache[tokenKey(tag('BAD'))]).toBeUndefined();
    cache = rememberToken(cache, tag('NEWER'), accepted, T0);
    expect(cache[tokenKey(tag('T0'))]).toBeUndefined();
    expect(Object.keys(cache).at(-1)).toBe(tokenKey(tag('NEWER')));
  });
});

describe('the 2.0.1 Local Authorization List', () => {
  it('applies full and differential updates with versions (D01)', () => {
    const full = applyLocalList(
      EMPTY_LOCAL_LIST_201,
      {
        versionNumber: 3,
        updateType: 'Full',
        localAuthorizationList: [
          { idToken: tag('A'), idTokenInfo: accepted },
          { idToken: tag('B'), idTokenInfo: blocked },
        ],
      },
      100,
    );
    expect(full.status).toBe('Accepted');
    expect(full.list.version).toBe(3);
    expect(Object.keys(full.list.entries)).toHaveLength(2);
    const diff = applyLocalList(
      full.list,
      {
        versionNumber: 4,
        updateType: 'Differential',
        localAuthorizationList: [
          { idToken: tag('B') },
          { idToken: tag('C'), idTokenInfo: accepted },
        ],
      },
      100,
    );
    expect(Object.keys(diff.list.entries).sort()).toEqual([tokenKey(tag('A')), tokenKey(tag('C'))]);
    expect(
      applyLocalList(diff.list, { versionNumber: 4, updateType: 'Differential' }, 100).status,
    ).toBe('VersionMismatch');
    expect(applyLocalList(diff.list, { versionNumber: 0, updateType: 'Full' }, 100).status).toBe(
      'Failed',
    );
    expect(
      applyLocalList(
        diff.list,
        {
          versionNumber: 9,
          updateType: 'Full',
          localAuthorizationList: [
            { idToken: tag('X'), idTokenInfo: accepted },
            { idToken: tag('X'), idTokenInfo: accepted },
          ],
        },
        100,
      ).status,
    ).toBe('Failed');
    expect(
      applyLocalList(
        diff.list,
        {
          versionNumber: 9,
          updateType: 'Full',
          localAuthorizationList: [{ idToken: tag('X'), idTokenInfo: accepted }],
        },
        0,
      ).status,
    ).toBe('Failed');
    // An empty Full list clears it but keeps the version.
    expect(applyLocalList(diff.list, { versionNumber: 10, updateType: 'Full' }, 100).list).toEqual({
      version: 10,
      entries: {},
    });
  });
});

describe('the 2.0.1 local decision', () => {
  const list = applyLocalList(
    EMPTY_LOCAL_LIST_201,
    {
      versionNumber: 1,
      updateType: 'Full',
      localAuthorizationList: [
        { idToken: tag('LISTED'), idTokenInfo: accepted },
        { idToken: tag('LISTED-BLOCKED'), idTokenInfo: blocked },
      ],
    },
    100,
  ).list;
  let cache = rememberToken({}, tag('CACHED'), accepted, T0);
  cache = rememberToken(cache, tag('CACHED-BLOCKED'), blocked, T0);
  const decide = (token: string, s: Partial<AuthorizationSettings> = {}) =>
    decideToken(tag(token), cache, list, settings(s), T0).decision;

  it('online: the list starts at once, the cache with LocalPreAuthorize, else Authorize', () => {
    expect(decide('LISTED')).toBe('start');
    expect(decide('LISTED-BLOCKED')).toBe('ask');
    expect(decide('CACHED')).toBe('ask');
    expect(decide('CACHED', { localPreAuthorize: true })).toBe('start');
    expect(decide('CACHED-BLOCKED')).toBe('ask');
    expect(decide('CACHED-BLOCKED', { disablePostAuthorize: true })).toBe('reject');
    expect(decide('UNKNOWN')).toBe('ask');
    expect(decide('UNKNOWN', { disableRemoteAuthorization: true })).toBe('reject');
    // A disabled list is not used.
    expect(decide('LISTED', { listEnabled: false })).toBe('ask');
  });

  it('offline: the list, the cache with LocalAuthorizeOffline, unknown ids only when allowed', () => {
    expect(decide('LISTED', { online: false })).toBe('start');
    expect(decide('LISTED-BLOCKED', { online: false })).toBe('reject');
    expect(decide('CACHED', { online: false })).toBe('start');
    expect(decide('CACHED', { online: false, localAuthorizeOffline: false })).toBe('reject');
    expect(decide('UNKNOWN', { online: false })).toBe('reject');
    expect(
      decideToken(
        tag('UNKNOWN'),
        cache,
        list,
        settings({ online: false, offlineTxForUnknownIdEnabled: true }),
        T0,
      ),
    ).toEqual({
      decision: 'start',
      unknownOffline: true,
    });
  });

  it('compares groups by groupIdToken', () => {
    const group = { status: 'Accepted' as const, groupIdToken: tag('G1') };
    expect(sameGroup(group, { ...group })).toBe(true);
    expect(sameGroup(group, { status: 'Accepted', groupIdToken: tag('G2') })).toBe(false);
    expect(sameGroup(group, accepted)).toBe(false);
  });
});
