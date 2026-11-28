/**
 * The station list's filters (id text, connection state, group, tag) and the
 * bulk actions on the stations they leave in view.
 */
import type { StationSummary } from './api.js';

export interface StationFilter {
  text: string;
  state: string;
  group: string;
  tag: string;
}

export const NO_FILTER: StationFilter = { text: '', state: '', group: '', tag: '' };

/** The stations the filters leave in view, in the list's order. */
export function filterStations(
  stations: readonly StationSummary[],
  filter: StationFilter,
): StationSummary[] {
  const text = filter.text.trim().toLowerCase();
  return stations.filter(
    (s) =>
      (text === '' || s.id.toLowerCase().includes(text)) &&
      (filter.state === '' || s.state === filter.state) &&
      (filter.group === '' || s.group === filter.group) &&
      (filter.tag === '' || s.tags.includes(filter.tag)),
  );
}

/** Every group, and every tag, the stations have, sorted. */
export const stationGroups = (stations: readonly StationSummary[]) =>
  [...new Set(stations.flatMap((s) => (s.group === undefined ? [] : [s.group])))].sort();
export const stationTags = (stations: readonly StationSummary[]) =>
  [...new Set(stations.flatMap((s) => s.tags))].sort();

/** What the bulk buttons do, through POST /api/stations/bulk/<action> or DELETE /api/stations/bulk. */
export type BulkAction = 'start' | 'stop' | 'offline' | 'online' | 'delete';

export const BULK_ACTIONS: readonly { id: BulkAction; label: string }[] = [
  { id: 'start', label: 'Start' },
  { id: 'stop', label: 'Stop' },
  { id: 'offline', label: 'Offline' },
  { id: 'online', label: 'Online' },
  { id: 'delete', label: 'Delete' },
];

/** The question asked before deleting the stations in view. */
export const deleteQuestion = (count: number) =>
  `Delete ${count} station${count === 1 ? '' : 's'}? Their saved state and sessions go too.`;
