import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChargePoint } from '@ocpp-mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { openStateStore } from './state-store.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const STATE: PersistedChargePoint = {
  version: 1,
  savedAt: Date.parse('2026-11-14T10:00:00Z'),
  config: { HeartbeatInterval: '60' },
  meters: { '1': 1520.5 },
  authCache: { TAG: { status: 'Accepted' } },
  transactions: [],
  outbox: [],
  csmsIds: {},
  sequence: 3,
};

describe('state store', () => {
  it('keeps station definitions and their state across reopening the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-store-'));
    dirs.push(dir);
    const path = join(dir, 'state.db');

    const first = openStateStore(path);
    first.saveStation({ id: 'SIM-2', persona: 'generic-1.6', csmsUrl: 'ws://localhost:9000/ocpp' });
    first.saveStation({ id: 'SIM-1', persona: 'generic-1.6', csmsUrl: 'ws://localhost:9000/ocpp' });
    first.saveState('SIM-1', STATE);
    first.close();

    const second = openStateStore(path);
    expect(second.listStations().map((s) => s.id)).toEqual(['SIM-1', 'SIM-2']);
    expect(second.loadState('SIM-1')).toEqual(STATE);
    expect(second.loadState('SIM-2')).toBeUndefined();
    second.close();
  });

  it('updates in place and deletes a station together with its state', () => {
    const store = openStateStore(':memory:');
    store.saveStation({ id: 'SIM-1', persona: 'a', csmsUrl: 'ws://localhost/ocpp' });
    store.saveStation({ id: 'SIM-1', persona: 'b', csmsUrl: 'ws://localhost/ocpp' });
    store.saveState('SIM-1', STATE);
    store.saveState('SIM-1', { ...STATE, sequence: 4 });
    expect(store.listStations()).toEqual([
      { id: 'SIM-1', persona: 'b', csmsUrl: 'ws://localhost/ocpp' },
    ]);
    expect(store.loadState('SIM-1')?.sequence).toBe(4);
    store.deleteStation('SIM-1');
    expect(store.listStations()).toEqual([]);
    expect(store.loadState('SIM-1')).toBeUndefined();
    store.close();
  });
});
