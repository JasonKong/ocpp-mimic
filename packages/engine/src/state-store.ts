/**
 * State Store: station definitions and each charge point's persisted state
 * (configuration, meters, authorization cache, running transactions, queued
 * messages) in SQLite, through Node's built-in node:sqlite.
 */
import type { PersistedStation, SessionRecord, UsageOverride } from '@ocpp-mimic/core';

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
  /** Configuration values on top of the persona's (1.6 stations). */
  config?: Record<string, string>;
  /** Device Model values on top of the persona's (2.0.1 stations): component → variable → value. */
  deviceModel?: Record<string, Record<string, string>>;
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
  /** A station's sessions, newest first. */
  loadSessions(stationId: string): SessionRecord[];
  loadSession(stationId: string, n: number): SessionRecord | undefined;
  /** Saves sessions and frames to add to them, in one transaction. */
  saveSessions(sessions: Iterable<{ record: SessionRecord; frames?: readonly unknown[] }>): void;
  /** A session's frames, in the order they were added. */
  sessionFrames(stationId: string, n: number): unknown[];
  /** Moves a merged session's frames to the session that took it over, and deletes it. */
  mergeSession(stationId: string, from: number, into: number): void;
  /** Deletes all but the station's newest `keep` sessions and the `protect`ed ones, with their frames. */
  pruneSessions(stationId: string, keep: number, protect?: readonly number[]): void;
  /** A setting, such as the reference tariff. */
  loadSetting(key: string): unknown;
  saveSetting(key: string, value: unknown): void;
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
    CREATE TABLE IF NOT EXISTS sessions (
      station_id TEXT NOT NULL REFERENCES stations (id) ON DELETE CASCADE,
      n INTEGER NOT NULL,
      record TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (station_id, n)
    );
    CREATE TABLE IF NOT EXISTS session_frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      record TEXT NOT NULL,
      FOREIGN KEY (station_id, n) REFERENCES sessions (station_id, n) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS session_frames_by_session ON session_frames (station_id, n);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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

  const loadSessions = db.prepare(
    'SELECT record FROM sessions WHERE station_id = ? ORDER BY n DESC',
  );
  const loadSession = db.prepare('SELECT record FROM sessions WHERE station_id = ? AND n = ?');
  const upsertSession = db.prepare(
    'INSERT INTO sessions (station_id, n, record, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (station_id, n) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at',
  );
  const insertFrame = db.prepare(
    'INSERT INTO session_frames (station_id, n, record) VALUES (?, ?, ?)',
  );
  const sessionFrames = db.prepare(
    'SELECT record FROM session_frames WHERE station_id = ? AND n = ? ORDER BY id',
  );
  const moveFrames = db.prepare('UPDATE session_frames SET n = ? WHERE station_id = ? AND n = ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE station_id = ? AND n = ?');
  const loadSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
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
    loadSessions: (stationId) =>
      loadSessions.all(stationId).map((row) => JSON.parse(String(row.record)) as SessionRecord),
    loadSession: (stationId, n) => {
      const row = loadSession.get(stationId, n);
      return row === undefined ? undefined : (JSON.parse(String(row.record)) as SessionRecord);
    },
    saveSessions: (sessions) => {
      transaction(() => {
        const now = Date.now();
        for (const { record, frames } of sessions) {
          upsertSession.run(record.stationId, record.n, JSON.stringify(record), now);
          for (const frame of frames ?? []) {
            insertFrame.run(record.stationId, record.n, JSON.stringify(frame));
          }
        }
      });
    },
    sessionFrames: (stationId, n) =>
      sessionFrames.all(stationId, n).map((row) => JSON.parse(String(row.record)) as unknown),
    mergeSession: (stationId, from, into) => {
      transaction(() => {
        moveFrames.run(into, stationId, from);
        deleteSession.run(stationId, from);
      });
    },
    pruneSessions: (stationId, keep, protect = []) => {
      const kept = db
        .prepare('SELECT n FROM sessions WHERE station_id = ? ORDER BY n DESC LIMIT ?')
        .all(stationId, keep)
        .map((row) => Number(row.n));
      const spare = new Set([...kept, ...protect]);
      const all = db
        .prepare('SELECT n FROM sessions WHERE station_id = ?')
        .all(stationId)
        .map((row) => Number(row.n));
      const drop = all.filter((n) => !spare.has(n));
      if (drop.length === 0) return;
      transaction(() => {
        for (const n of drop) deleteSession.run(stationId, n);
      });
    },
    loadSetting: (key) => {
      const row = loadSetting.get(key);
      return row === undefined ? undefined : (JSON.parse(String(row.value)) as unknown);
    },
    saveSetting: (key, value) => {
      upsertSetting.run(key, JSON.stringify(value));
    },
    close: () => db.close(),
  };
}
