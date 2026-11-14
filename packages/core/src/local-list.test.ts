import { describe, expect, it } from 'vitest';
import { decideLocalAuthorization, EMPTY_AUTHORIZATION_CACHE } from './auth.js';
import { createConfig } from './config.js';
import { applySendLocalList, EMPTY_LOCAL_LIST, localListVersion } from './local-list.js';

const LIMITS = { sendMax: 3, listMax: 4 };
const accepted = { status: 'Accepted' as const };
const blocked = { status: 'Blocked' as const };

describe('local authorization list', () => {
  it('replaces the list with a Full update and reports version 0 when empty', () => {
    const full = applySendLocalList(
      EMPTY_LOCAL_LIST,
      {
        listVersion: 5,
        updateType: 'Full',
        localAuthorizationList: [
          { idTag: 'A', idTagInfo: accepted },
          { idTag: 'B', idTagInfo: blocked },
        ],
      },
      LIMITS,
    );
    expect(full).toEqual({
      status: 'Accepted',
      list: { version: 5, entries: { A: accepted, B: blocked } },
    });
    expect(localListVersion(full.list)).toBe(5);
    const emptied = applySendLocalList(full.list, { listVersion: 9, updateType: 'Full' }, LIMITS);
    expect(emptied.status).toBe('Accepted');
    expect(localListVersion(emptied.list)).toBe(0);
    expect(localListVersion(EMPTY_LOCAL_LIST)).toBe(0);
  });

  it('applies Differential updates with a higher version: entries with idTagInfo added, without deleted', () => {
    const start = { version: 5, entries: { A: accepted, B: blocked } };
    const diff = applySendLocalList(
      start,
      {
        listVersion: 6,
        updateType: 'Differential',
        localAuthorizationList: [{ idTag: 'B' }, { idTag: 'C', idTagInfo: accepted }],
      },
      LIMITS,
    );
    expect(diff).toEqual({
      status: 'Accepted',
      list: { version: 6, entries: { A: accepted, C: accepted } },
    });
    expect(
      applySendLocalList(start, { listVersion: 5, updateType: 'Differential' }, LIMITS),
    ).toEqual({
      status: 'VersionMismatch',
      list: start,
    });
  });

  it('fails without changing the list when a limit is exceeded or a Full entry has no idTagInfo', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ idTag: `T${i}`, idTagInfo: accepted }));
    const start = { version: 1, entries: { X: accepted, Y: accepted } };
    expect(
      applySendLocalList(
        start,
        { listVersion: 2, updateType: 'Full', localAuthorizationList: many(4) },
        LIMITS,
      ).status,
    ).toBe('Failed');
    expect(
      applySendLocalList(
        start,
        { listVersion: 2, updateType: 'Differential', localAuthorizationList: many(3) },
        LIMITS,
      ),
    ).toEqual({ status: 'Failed', list: start });
    expect(
      applySendLocalList(
        start,
        { listVersion: 2, updateType: 'Full', localAuthorizationList: [{ idTag: 'Z' }] },
        LIMITS,
      ).status,
    ).toBe('Failed');
  });

  it('takes priority over the cache when deciding on a card', () => {
    const decide = (online: boolean, values: Record<string, string> = {}, idTag = 'A') =>
      decideLocalAuthorization({
        cache: { A: blocked, B: accepted },
        config: createConfig({ numberOfConnectors: 1, values }),
        idTag,
        online,
        now: 0,
        localList: { A: accepted, B: blocked },
      });
    // Online: listed and Accepted starts at once only with LocalPreAuthorize.
    expect(decide(true)).toBe('ask');
    expect(decide(true, { LocalPreAuthorize: 'true' })).toBe('start');
    // Offline: the list wins over the cache in both directions.
    expect(decide(false)).toBe('start');
    expect(decide(false, {}, 'B')).toBe('reject');
    expect(decide(false, { LocalAuthorizeOffline: 'false' })).toBe('reject');
    // Disabled list: the cache decides again.
    expect(decide(false, { LocalAuthListEnabled: 'false' })).toBe('reject');
    expect(decide(false, { LocalAuthListEnabled: 'false' }, 'B')).toBe('start');
    expect(
      decideLocalAuthorization({
        cache: EMPTY_AUTHORIZATION_CACHE,
        config: createConfig({ numberOfConnectors: 1 }),
        idTag: 'A',
        online: false,
        now: 0,
        localList: { A: { status: 'Accepted', expiryDate: '1970-01-01T00:00:00Z' } },
      }),
    ).toBe('reject');
  });
});
