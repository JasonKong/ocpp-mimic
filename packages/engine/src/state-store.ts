/**
 * State Store: station definitions and each charge point's persisted state
 * (configuration, meters, authorization cache, running transactions, queued
 * messages) in SQLite, through Node's built-in node:sqlite.
 */
import type { PersistedStation, UsageOverride } from '@ocpp-mimic/core';

/**
 * node:sqlite, loaded on first use: it is still experimental and prints a
 * warning when loaded, which only commands that keep state should show.
 */
const sqlite = () => process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** What the fleet needs to recreate a virtual charge point. */
/** A station's Security Profile settings; certificates are PEM file paths. */
export interface StationSecurity {
  /** The initial SecurityProfile (0 to 3); the saved state keeps later changes. */
  profile?: number;
  /** CentralSystemRootCertificate: the CA to check the CSMS's server certificate with. */
  ca?: string;
  /** ChargePointCertificate and its private key, for Security Profile 3. */
  cert?: string;
  key?: string;
  /** ManufacturerRootCertificate, to check firmware signing certificates with. */
  manufacturerRoot?: string;
}

export interface StationDefinition {
  /** The chargeBoxId. */
  id: string;
  /** Persona id. */
  persona: string;
  /** The CSMS's OCPP-J URL; the chargeBoxId is appended. */
  csmsUrl: string;
  /** Basic Auth password, if the CSMS requires one; the initial AuthorizationKey. */
  password?: string;
  /** Security Profile and the certificates for TLS (Security Whitepaper). */
  security?: StationSecurity;
  /** Configuration values on top of the persona's. */
  config?: Record<string, string>;
  /** Initial energy multiplier; the saved charge point state keeps later changes. */
  energyMultiplier?: number;
  /** Names for selecting stations (at most 10). */
  tags?: string[];
  /** The group the station belongs to, e.g. its template; labels metrics and reports. */
  group?: string;
  /**
   * The usage model: true runs the persona's, an object changes it, false or
   * absent leaves it off (it can still be switched on when the persona has one).
   */
  usage?: boolean | UsageOverride;
  /** The run's seed for the usage model's random numbers; with the id it seeds the station. */
  seed?: number;
  /**
   * A replay station: its charge point stays off the wire (it never sees the
   * connection open), and a replay drives the connection through `wire`.
   */
  replay?: boolean;
}

export interface StateStore {
  listStations(): StationDefinition[];
  saveStation(definition: StationDefinition): void;
  /** Saves many station definitions in one transaction. */
  saveStations(definitions: readonly StationDefinition[]): void;
  deleteStation(id: string): void;
  /** Deletes many stations in one transaction. */
  deleteStations(ids: readonly string[]): void;
  loadState(id: string): PersistedStation | undefined;
  saveState(id: string, state: PersistedStation): void;
  /** Saves many stations' states in one transaction. */
  saveStates(states: Iterable<[id: string, state: PersistedStation]>): void;
  close(): void;
}

/** Opens (and creates if needed) a store at `path`; ':memory:' keeps it in memory. */
export function openStateStore(path: string): StateStore {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path);
  // WAL with synchronous=NORMAL: a commit does not wait for the disk (only
  // checkpoints do), so saves never stall the event loop on a slow fsync. A
  // crash can lose the last commits, which a simulator's state can afford.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
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

  /** Runs `work` in one transaction: all of it is written, or none. */
  const transaction = (work: () => void) => {
    db.exec('BEGIN');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    listStations: () =>
      listStations.all().map((row) => JSON.parse(String(row.definition)) as StationDefinition),
    saveStation: (definition) => {
      upsertStation.run(definition.id, JSON.stringify(definition));
    },
    saveStations: (definitions) => {
      transaction(() => {
        for (const definition of definitions) {
          upsertStation.run(definition.id, JSON.stringify(definition));
        }
      });
    },
    deleteStation: (id) => {
      deleteStation.run(id);
    },
    deleteStations: (ids) => {
      transaction(() => {
        for (const id of ids) deleteStation.run(id);
      });
    },
    loadState: (id) => {
      const row = loadState.get(id);
      return row === undefined ? undefined : (JSON.parse(String(row.state)) as PersistedStation);
    },
    saveState: (id, state) => {
      upsertState.run(id, JSON.stringify(state), state.savedAt);
    },
    saveStates: (states) => {
      transaction(() => {
        for (const [id, state] of states) upsertState.run(id, JSON.stringify(state), state.savedAt);
      });
    },
    close: () => db.close(),
  };
}
