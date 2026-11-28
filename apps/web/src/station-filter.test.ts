import { describe, expect, it } from 'vitest';
import type { StationSummary } from './api.js';
import {
  deleteQuestion,
  filterStations,
  NO_FILTER,
  stationGroups,
  stationTags,
} from './station-filter.js';

const station = (id: string, patch: Partial<StationSummary> = {}): StationSummary => ({
  id,
  persona: 'generic-1.6',
  ocpp: '1.6',
  tags: [],
  state: 'connected',
  registration: 'Accepted',
  connectors: [],
  ...patch,
});

describe('the station list filters', () => {
  const stations = [
    station('SIM-001', { group: 'ac', tags: ['load', 'nz'] }),
    station('SIM-002', { group: 'ac', tags: ['load'], state: 'offline' }),
    station('DC-001', { group: 'dc', tags: ['nz'] }),
    station('DEMO-CP-1', { tags: ['demo'] }),
  ];

  it('filters by id text, state, group and tag together', () => {
    const ids = (filter: Partial<typeof NO_FILTER>) =>
      filterStations(stations, { ...NO_FILTER, ...filter }).map((s) => s.id);
    expect(ids({})).toEqual(['SIM-001', 'SIM-002', 'DC-001', 'DEMO-CP-1']);
    expect(ids({ tag: 'nz' })).toEqual(['SIM-001', 'DC-001']);
    expect(ids({ tag: 'load', state: 'connected' })).toEqual(['SIM-001']);
    expect(ids({ text: ' sim ', group: 'ac' })).toEqual(['SIM-001', 'SIM-002']);
    expect(ids({ tag: 'nowhere' })).toEqual([]);
  });

  it('lists the groups and tags in use, and names how many a delete removes', () => {
    expect(stationGroups(stations)).toEqual(['ac', 'dc']);
    expect(stationTags(stations)).toEqual(['demo', 'load', 'nz']);
    expect(deleteQuestion(1)).toBe('Delete 1 station? Their saved state and sessions go too.');
    expect(deleteQuestion(250)).toContain('Delete 250 stations?');
  });
});
