import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { Logger } from "../logger.js";

interface Migration {
  version: number;
  up(db: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plex_user_id TEXT NOT NULL UNIQUE,
          plex_account_id TEXT,
          tautulli_user_id TEXT,
          username TEXT NOT NULL,
          display_name TEXT NOT NULL,
          avatar_url TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE rolling_shows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sonarr_series_id INTEGER NOT NULL UNIQUE,
          title TEXT NOT NULL,
          tvdb_id INTEGER,
          imdb_id TEXT,
          year INTEGER,
          expanded_seasons TEXT NOT NULL DEFAULT '[]',
          last_activity_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE rolling_show_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rolling_show_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          last_watched_season INTEGER NOT NULL,
          last_watched_episode INTEGER NOT NULL,
          last_watched_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(rolling_show_id, user_id),
          FOREIGN KEY (rolling_show_id) REFERENCES rolling_shows(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE watch_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL CHECK(source IN ('plex-history', 'plex-session', 'tautulli')),
          source_event_id TEXT NOT NULL,
          user_id INTEGER,
          plex_account_id TEXT,
          username TEXT,
          sonarr_series_id INTEGER,
          show_title TEXT NOT NULL,
          season_number INTEGER NOT NULL,
          episode_number INTEGER NOT NULL,
          watched_at TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(source, source_event_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE history_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
          action TEXT NOT NULL,
          title TEXT NOT NULL,
          details TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE job_run_state (
          job_id TEXT PRIMARY KEY,
          last_run_at TEXT,
          last_run_status TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          plex_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX idx_users_account_id ON users(plex_account_id);
        CREATE INDEX idx_rolling_shows_title ON rolling_shows(title);
        CREATE INDEX idx_watch_events_user ON watch_events(user_id);
        CREATE INDEX idx_watch_events_show ON watch_events(sonarr_series_id);
        CREATE INDEX idx_history_events_created ON history_events(created_at);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE ignored_recommendations (
          sonarr_series_id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE recommendation_cache (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          candidates TEXT NOT NULL,
          generated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE sonarr_library_cache (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          series TEXT NOT NULL,
          generated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE reclaimed_storage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rolling_show_id INTEGER,
          sonarr_series_id INTEGER NOT NULL,
          show_title TEXT NOT NULL,
          action TEXT NOT NULL,
          season_number INTEGER,
          file_count INTEGER NOT NULL,
          bytes_reclaimed INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (rolling_show_id) REFERENCES rolling_shows(id) ON DELETE SET NULL
        );
        CREATE INDEX idx_reclaimed_storage_events_created ON reclaimed_storage_events(created_at);
        CREATE INDEX idx_reclaimed_storage_events_series ON reclaimed_storage_events(sonarr_series_id);
      `);
    },
  },
  {
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE plex_artwork (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rolling_show_id INTEGER NOT NULL,
          plex_show_rating_key TEXT NOT NULL,
          plex_season_rating_key TEXT NOT NULL,
          season_number INTEGER NOT NULL,
          original_poster_path TEXT NOT NULL,
          overlay_poster_path TEXT NOT NULL,
          overlay_applied INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(rolling_show_id, plex_season_rating_key),
          FOREIGN KEY (rolling_show_id) REFERENCES rolling_shows(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_plex_artwork_rolling_show ON plex_artwork(rolling_show_id);
      `);
    },
  },
  {
    version: 7,
    up(db) {
      db.exec("ALTER TABLE plex_artwork ADD COLUMN item_type TEXT NOT NULL DEFAULT 'season'");
    },
  },
  {
    version: 8,
    up(db) {
      db.exec("ALTER TABLE plex_artwork ADD COLUMN render_version INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    version: 9,
    up(db) {
      db.exec("ALTER TABLE plex_artwork ADD COLUMN overlay_sha256 TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 10,
    up(db) {
      db.exec("ALTER TABLE plex_artwork ADD COLUMN overlay_thumb TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 11,
    up(db) {
      db.exec(`
        CREATE TABLE rolling_season_inactivity (
          rolling_show_id INTEGER NOT NULL,
          season_number INTEGER NOT NULL,
          inactive_since TEXT NOT NULL,
          PRIMARY KEY (rolling_show_id, season_number),
          FOREIGN KEY (rolling_show_id) REFERENCES rolling_shows(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_rolling_season_inactivity_show ON rolling_season_inactivity(rolling_show_id);
      `);
    },
  },
  {
    version: 12,
    up(db) {
      db.exec(`
        CREATE TABLE rolling_prefetched_episodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rolling_show_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          season_number INTEGER NOT NULL,
          episode_number INTEGER NOT NULL,
          triggered_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(rolling_show_id, season_number, episode_number),
          FOREIGN KEY (rolling_show_id) REFERENCES rolling_shows(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_rolling_prefetched_episodes_show ON rolling_prefetched_episodes(rolling_show_id);
      `);
    },
  },
  {
    // Two indexes for the same watch_events window-function shape, covering it in both
    // directions: listLatestUserProgressForSeries(Batch) leads with sonarr_series_id (the
    // Dashboard and Shows-page queries fixed in #59 — measured on a 932-show library /
    // ~96k watch_events, this took the Shows-page progress query from ~150ms to ~8ms).
    // listLatestWatchProgressForUser leads with user_id instead, for the rarer path that
    // runs during Plex user discovery. Both let SQLite resolve the most recent watch event
    // directly from the index instead of sorting matching rows in a temp b-tree.
    version: 13,
    up(db) {
      db.exec(`
        CREATE INDEX idx_watch_events_series_user_watched
        ON watch_events(sonarr_series_id, user_id, watched_at DESC, id DESC);
        CREATE INDEX idx_watch_events_user_series_watched
        ON watch_events(user_id, sonarr_series_id, watched_at DESC, id DESC);
      `);
    },
  },
  {
    // Session IDs are bearer credentials. Hashing existing rows during the migration
    // preserves valid logins while ensuring a database read cannot be replayed as one.
    version: 14,
    up(db) {
      const sessions = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
      const update = db.prepare("UPDATE sessions SET id = ? WHERE id = ?");
      for (const { id } of sessions) update.run(crypto.createHash("sha256").update(id).digest("hex"), id);
    },
  },
  {
    // Keep completed automatic decisions separate from the replaceable Sonarr library
    // cache, so a restart never repeats a search or baseline for the same arrival.
    version: 15,
    up(db) {
      db.exec(`
        CREATE TABLE new_show_triage (
          sonarr_series_id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          added_at TEXT,
          decision TEXT NOT NULL CHECK(decision IN ('baseline', 'enroll', 'search')),
          completed_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // An automatic enrollment can fail after creating its rolling-show row. Persist
    // that its subsequent mutation phase was Pacearr-initiated so retries never
    // mistake a manual enrollment for incomplete automatic work and apply the pilot
    // baseline to it.
    version: 16,
    up(db) {
      db.exec(`
        CREATE TABLE new_show_triage_pending_enrollments (
          sonarr_series_id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          added_at TEXT,
          started_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // A Tautulli identity may belong to only one Plex user. NULL remains valid for
    // every user until an administrator explicitly maps the identity.
    version: 17,
    up(db) {
      // This migration has not reached a tagged release. Preserve the earliest user ID
      // for each identity so an imported duplicate cannot block the uniqueness invariant.
      // Do not move watch events or rolling progress between the duplicate Plex users:
      // the bad mapping gives no evidence that either user's historical activity belongs
      // to the other. Clearing only the later stable-ID mapping preserves that history
      // and lets an administrator correct the ambiguous identity deliberately.
      db.exec(`
        UPDATE users
        SET tautulli_user_id = NULL
        WHERE tautulli_user_id IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM users
            WHERE tautulli_user_id IS NOT NULL
            GROUP BY tautulli_user_id
          );
        CREATE UNIQUE INDEX idx_users_tautulli_user_id ON users(tautulli_user_id) WHERE tautulli_user_id IS NOT NULL;
      `);
    },
  },
  {
    // Preserve the Tautulli username separately from its stable ID so it can be
    // shown and manually corrected in the Pacearr user editor.
    version: 18,
    up(db) {
      db.exec("ALTER TABLE users ADD COLUMN tautulli_username TEXT;");
    },
  },
  {
    // Existing matched Tautulli history already contains the username Pacearr used,
    // so expose it in the user editor without requiring another import first.
    version: 19,
    up(db) {
      db.exec(`
        UPDATE users
        SET tautulli_username = (
          SELECT username FROM watch_events
          WHERE source = 'tautulli' AND user_id = users.id AND username IS NOT NULL AND trim(username) <> ''
          ORDER BY watched_at DESC, id DESC LIMIT 1
        )
        WHERE tautulli_username IS NULL OR trim(tautulli_username) = '';
      `);
    },
  },
  {
    // Migration 19 shipped before managed-user history used Tautulli's friendly
    // name as a fallback. Re-run the corrected blank-only backfill for upgrades.
    version: 20,
    up(db) {
      db.exec(`
        UPDATE users
        SET tautulli_username = (
          SELECT COALESCE(NULLIF(trim(username), ''), NULLIF(trim(json_extract(raw_payload, '$.user')), ''))
          FROM watch_events
          WHERE source = 'tautulli' AND user_id = users.id
            AND COALESCE(NULLIF(trim(username), ''), NULLIF(trim(json_extract(raw_payload, '$.user')), '')) IS NOT NULL
          ORDER BY watched_at DESC, id DESC LIMIT 1
        )
        WHERE tautulli_username IS NULL OR trim(tautulli_username) = '';
      `);
    },
  },
  {
    // History sources retain their own identity evidence. A verified Plex lookup must
    // never become evidence for a Tautulli event (or vice versa).
    version: 21,
    up(db) {
      db.exec(`
        CREATE TABLE source_identity_cache (
          source TEXT NOT NULL CHECK(source IN ('plex', 'tautulli')),
          identity_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('resolved', 'missing', 'ambiguous')),
          tvdb_id INTEGER,
          imdb_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (source, identity_key)
        );
      `);
    },
  },
];

export function runMigrations(db: Database.Database, logger?: Logger, targetVersion?: number): void {
  let currentVersion = db.pragma("user_version", { simple: true }) as number;
  const latestVersion = migrations[migrations.length - 1]?.version ?? 0;
  const finalVersion = Math.min(targetVersion ?? latestVersion, latestVersion);
  if (currentVersion >= finalVersion) return;

  for (const migration of migrations) {
    if (migration.version <= currentVersion || migration.version > finalVersion) continue;
    logger?.info("Applying database migration", { from: currentVersion, to: migration.version });
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
    currentVersion = migration.version;
  }
}
