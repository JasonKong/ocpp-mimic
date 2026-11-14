/**
 * State Store: station definitions and each charge point's persisted state
 * (configuration, meters, authorization cache, running transactions, queued
 * messages) in SQLite, through Node's built-in node:sqlite.
 */
import { DatabaseSync } from 'node:sqlite';
import type { PersistedChargePoint } from '@ocpp-mimic/core';

/** What the fleet needs to recreate a virtual charge point. */
export interface StationDefinition {
  /** The chargeBoxId. */
  id: string;
  /** Persona id. */
  persona: string;
  /** The CSMS's OCPP-J URL; the chargeBoxId is appended. */
  csmsUrl: string;
  /** Basic Auth password, if the CSMS requires one. */
  password?: string;
  /** Configuration values on top of the persona's. */
  config?: Record<string, string>;
  /** Initial energy multiplier; the saved charge point state keeps later changes. */
  energyMultiplier?: number;
}

export interface StateStore {
  listStations(): StationDefinition[];
  saveStation(definition: StationDefinition): void;
  deleteStation(id: string): void;
  loadState(id: string): PersistedChargePoint | undefined;
  saveState(id: string, state: PersistedChargePoint): void;
  close(): void;
}

/** Opens (and creates if needed) a store at `path`; ':memory:' keeps it in memory. */
export function openStateStore(path: string): StateStore {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      definition TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS station_state (
      id TEXT PRIMARY KEY REFERENCES stations (id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    );
    PRAGMA foreign_keys = ON;
  `);
  const listStations = db.prepare('SELECT definition FROM stations ORDER BY id');
  const upsertStation = db.prepare(
    'INSERT INTO stations (id, definition) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET definition = excluded.definition',
  );
  const deleteStation = db.prepare('DELETE FROM stations WHERE id = ?');
  const loadState = db.prepare('SELECT state FROM station_state WHERE id = ?');
  const upsertState = db.prepare(
    'INSERT INTO station_state (id, state, saved_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, saved_at = excluded.saved_at',
  );

  return {
    listStations: () =>
      listStations.all().map((row) => JSON.parse(String(row.definition)) as StationDefinition),
    saveStation: (definition) => {
      upsertStation.run(definition.id, JSON.stringify(definition));
    },
    deleteStation: (id) => {
      deleteStation.run(id);
    },
    loadState: (id) => {
      const row = loadState.get(id);
      return row === undefined
        ? undefined
        : (JSON.parse(String(row.state)) as PersistedChargePoint);
    },
    saveState: (id, state) => {
      upsertState.run(id, JSON.stringify(state), state.savedAt);
    },
    close: () => db.close(),
  };
}
