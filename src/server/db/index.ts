import path from "node:path";
import Database from "better-sqlite3";
import type {
  AppSettings,
  EventSourceKind,
  HistoryEvent,
  PlexOwnerRecord,
  PlexSettingsInput,
  PlexSettingsView,
  RollingShowRecord,
  RollingShowUserRecord,
  SessionUser,
  SonarrSeries,
  SonarrSettings,
  SonarrSettingsView,
  TautulliSettings,
  TautulliSettingsView,
  UserRecord,
  UnmappedTautulliUser,
  WatchEvent,
  ShowRecommendation,
  ShowUserProgress,
  SonarrLibraryCacheItem,
  DashboardShowActivity,
  PlexArtworkRecord,
  PrefetchedEpisodeRecord,
} from "../../shared/types.js";
import { actionsInCategory, type HistoryCategory } from "../../shared/history.js";
import type { RuntimeConfig } from "../config.js";
import { createSecret, hashSessionId } from "../auth.js";
import type { Logger } from "../logger.js";
import { runMigrations } from "./migrations.js";

const now = () => new Date().toISOString();

// JS Date can only represent times within +/-8,640,000,000,000,000ms of the epoch (see
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date
// #the_epoch_timestamps_and_invalid_date), i.e. +/-100,000,000 days. A day count anywhere
// near that (e.g. a user pasting 1e308 into historyRetentionDays) overflows the
// multiplication to Infinity, producing an invalid Date whose toISOString() throws -
// confirmed this crashes pruneHistoryEvents specifically. This ceiling exists purely to
// stay inside Date's valid range; it is not a policy opinion about a "reasonable" value.
export const MAX_SAFE_RETENTION_DAYS = 100_000_000;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  dryRun: true,
  artworkEnabled: false,
  viewerActivityWindowDays: 30,
  historyRetentionDays: 7,
  sessionPollIntervalMinutes: 15,
  historyImportIntervalHours: 24,
  fullHistoryReconcileIntervalDays: 30,
  rollingReconcileIntervalHours: 6,
  sonarrLibraryRefreshIntervalHours: 6,
  recommendationRefreshIntervalHours: 6,
  progressiveCleanupEnabled: true,
  progressiveCleanupDelayDays: 7,
  cleanupDeletesFiles: true,
  recommendationMinimumSavingsGb: 50,
  trustProxy: false,
  onboardingComplete: false,
  earlyPrefetchEnabled: false,
  earlyPrefetchTriggerEpisodesRemaining: 3,
  earlyPrefetchEpisodeCount: 2,
  newShowTriageEnabled: false,
  newShowTriageIntervalMinutes: 5,
  newShowTriageEpisodeThreshold: 80,
  newShowTriageEnabledAt: null,
};

export interface NormalizedWatchEventInput {
  source: EventSourceKind;
  sourceEventId: string;
  userId: number | null;
  plexAccountId: string | null;
  username: string | null;
  sonarrSeriesId: number | null;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  watchedAt: string;
  rawPayload: unknown;
}

function plexArtworkFromRow(row: any): PlexArtworkRecord {
  return {
    id: row.id,
    rollingShowId: row.rolling_show_id,
    plexShowRatingKey: row.plex_show_rating_key,
    plexItemRatingKey: row.plex_season_rating_key,
    itemType: row.item_type,
    seasonNumber: row.season_number,
    originalPosterPath: row.original_poster_path,
    overlayPosterPath: row.overlay_poster_path,
    overlayApplied: bool(row.overlay_applied),
    renderVersion: row.render_version,
    overlaySha256: row.overlay_sha256,
    overlayThumb: row.overlay_thumb,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface HistorySyncState {
  plex: { backfillComplete: boolean; cursor: string | null };
  tautulli: { backfillComplete: boolean; cursor: string | null };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function bool(value: number | boolean) {
  return value === true || value === 1;
}

function isCurrentShapeShowUserProgress(candidate: unknown): candidate is ShowUserProgress {
  const value = candidate as Partial<ShowUserProgress> | null;
  return Boolean(value)
    && typeof value?.userId === "number"
    && typeof value?.displayName === "string"
    && (value?.avatarUrl === null || typeof value?.avatarUrl === "string")
    && typeof value?.enabled === "boolean"
    && typeof value?.seasonNumber === "number"
    && typeof value?.episodeNumber === "number"
    && typeof value?.watchedAt === "string";
}

// Checks every field, not just the ones a past rename happened to touch (viewers/
// viewerCount, when watchers/watcherCount were renamed) — a guard that only re-validates
// the one field that broke last time doesn't catch the next rename, and a partial match
// still crashes the client on whichever field it missed (e.g. formatBytes(undefined)).
function isCurrentShapeRecommendation(candidate: unknown): candidate is ShowRecommendation {
  const value = candidate as Partial<ShowRecommendation> | null;
  return Boolean(value)
    && typeof value?.sonarrSeriesId === "number"
    && typeof value?.title === "string"
    && (value?.year === null || typeof value?.year === "number")
    && (value?.posterUrl === null || typeof value?.posterUrl === "string")
    && (value?.status === null || typeof value?.status === "string")
    && typeof value?.seasonCount === "number"
    && typeof value?.episodeCount === "number"
    && typeof value?.sizeOnDiskBytes === "number"
    && Array.isArray(value?.retainedSeasons) && value.retainedSeasons.every((season) => typeof season === "number")
    && Array.isArray(value?.droppedSeasons) && value.droppedSeasons.every((season) => typeof season === "number")
    && typeof value?.viewerCount === "number"
    && Array.isArray(value?.viewers) && value.viewers.every(isCurrentShapeShowUserProgress)
    && typeof value?.projectedSavingsBytes === "number"
    && typeof value?.ignored === "boolean";
}

function isCurrentShapeSonarrLibraryItem(item: unknown): item is SonarrLibraryCacheItem {
  const value = item as Partial<SonarrLibraryCacheItem> | null;
  return Boolean(value)
    && typeof value?.series?.id === "number"
    && typeof value.series.title === "string"
    && (value.posterUrl === null || typeof value.posterUrl === "string");
}

function userFromRow(row: any): UserRecord {
  return {
    id: row.id,
    plexUserId: row.plex_user_id,
    plexAccountId: row.plex_account_id,
    tautulliUserId: row.tautulli_user_id,
    tautulliUsername: row.tautulli_username,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    enabled: bool(row.enabled),
    lastSeenAt: row.last_seen_at,
  };
}

function normaliseName(name?: string | null): string {
  // SQLite's built-in lower() only folds ASCII unless an ICU extension is loaded. Keep
  // the in-memory resolver byte-for-byte aligned with the SQL matching it replaces.
  return name?.replace(/[A-Z]/g, (character) => character.toLowerCase()) ?? "";
}

function usersByNormalisedName(users: UserRecord[], getName: (user: UserRecord) => string | null | undefined): Map<string, UserRecord[]> {
  const grouped = new Map<string, UserRecord[]>();
  for (const user of users) {
    const name = normaliseName(getName(user));
    if (!name) continue;
    const matches = grouped.get(name);
    if (matches) matches.push(user);
    else grouped.set(name, [user]);
  }
  return grouped;
}

function rollingShowFromRow(row: any): RollingShowRecord {
  return {
    id: row.id,
    sonarrSeriesId: row.sonarr_series_id,
    title: row.title,
    tvdbId: row.tvdb_id,
    imdbId: row.imdb_id,
    year: row.year,
    expandedSeasons: parseJson<number[]>(row.expanded_seasons, []),
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function historyFromRow(row: any): HistoryEvent {
  return {
    id: row.id,
    level: row.level,
    action: row.action,
    title: row.title,
    details: row.details,
    createdAt: row.created_at,
  };
}

export class PacearrDatabase {
  private readonly db: Database.Database;
  private readonly logger?: Logger;

  constructor(config: RuntimeConfig, logger?: Logger) {
    this.db = new Database(path.join(config.dataDir, "pacearr.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.logger = logger;
    runMigrations(this.db, logger);
    this.seedDefaults();
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  private seedDefaults() {
    this.getSessionSecret();
    if (!this.getSetting("app")) this.setSetting("app", DEFAULT_APP_SETTINGS);
    // The former combined recommendation-refresh job also refreshed the library. Carry
    // its last known state forward so an upgrade does not briefly present the new library
    // job as never having run when its cache is already populated.
    this.db.prepare(`
      INSERT OR IGNORE INTO job_run_state (job_id, last_run_at, last_run_status, updated_at)
      SELECT 'sonarr-library-refresh', last_run_at, last_run_status, updated_at
      FROM job_run_state
      WHERE job_id = 'recommendation-refresh'
    `).run();
    for (const id of ["session-check", "history-import", "full-history-reconcile", "rolling-reconcile", "sonarr-library-refresh", "recommendation-refresh", "new-show-triage"]) {
      this.db.prepare(`
        INSERT OR IGNORE INTO job_run_state (job_id, last_run_at, last_run_status, updated_at)
        VALUES (?, NULL, NULL, ?)
      `).run(id, now());
    }
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? parseJson<T>(row.value, null as T) : null;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), now());
  }

  getSessionSecret(): string {
    let secret = this.getSetting<string>("sessionSecret");
    if (!secret) {
      secret = createSecret();
      this.setSetting("sessionSecret", secret);
    }
    return secret;
  }

  getAppSettings(): AppSettings {
    // Pacearr's purpose is to reclaim media that no enabled viewer needs.
    // Dry run is the safety boundary; live cleanup always includes file deletion.
    return { ...DEFAULT_APP_SETTINGS, ...(this.getSetting<Partial<AppSettings>>("app") ?? {}), cleanupDeletesFiles: true };
  }

  updateAppSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.getAppSettings(), ...patch, cleanupDeletesFiles: true };
    this.setSetting("app", next);
    return next;
  }

  listIgnoredRecommendationIds(): number[] {
    return (this.db.prepare("SELECT sonarr_series_id FROM ignored_recommendations").all() as Array<{ sonarr_series_id: number }>)
      .map((row) => row.sonarr_series_id);
  }

  ignoreRecommendation(seriesId: number, title: string): void {
    this.db.prepare(`
      INSERT INTO ignored_recommendations (sonarr_series_id, title, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sonarr_series_id) DO UPDATE SET title = excluded.title
    `).run(seriesId, title, now());
  }

  unignoreRecommendation(seriesId: number): void {
    this.db.prepare("DELETE FROM ignored_recommendations WHERE sonarr_series_id = ?").run(seriesId);
  }

  /**
   * This cache stores whole ShowRecommendation objects as JSON, so a release that renames
   * a field leaves every existing install holding rows in the old shape — which the client
   * then reads as `undefined` and crashes on. Treat a cache whose entries don't match the
   * current shape as absent: the callers of this method already kick off a
   * recommendation-refresh when it returns null, so the stale rows heal themselves.
   */
  getRecommendationCache(): { candidates: ShowRecommendation[]; generatedAt: string } | null {
    const row = this.db.prepare("SELECT candidates, generated_at FROM recommendation_cache WHERE id = 1").get() as
      { candidates: string; generated_at: string } | undefined;
    if (!row) return null;
    // Parsed directly rather than through parseJson: that helper's fallback-on-error
    // would turn corrupted JSON into an empty array, which passes the shape check below
    // and gets treated as a real "0 candidates" cache instead of triggering a refresh.
    let candidates: unknown;
    try {
      candidates = JSON.parse(row.candidates);
    } catch {
      return null;
    }
    // Not against invalid JSON syntax (handled above), but against valid JSON that isn't
    // an array (e.g. a legacy shape that stored an object) — .every() would throw on that
    // rather than falling through to the shape check below.
    if (!Array.isArray(candidates) || !candidates.every(isCurrentShapeRecommendation)) return null;
    return { candidates, generatedAt: row.generated_at };
  }

  saveRecommendationCache(candidates: ShowRecommendation[]): string {
    const generatedAt = now();
    this.db.prepare(`
      INSERT INTO recommendation_cache (id, candidates, generated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET candidates = excluded.candidates, generated_at = excluded.generated_at
    `).run(JSON.stringify(candidates), generatedAt);
    return generatedAt;
  }

  removeRecommendationFromCache(seriesId: number): void {
    const cache = this.getRecommendationCache();
    if (!cache) return;
    this.saveRecommendationCache(cache.candidates.filter((candidate) => candidate.sonarrSeriesId !== seriesId));
  }

  getSonarrLibraryCache(): { items: SonarrLibraryCacheItem[]; generatedAt: string } | null {
    const row = this.db.prepare("SELECT series, generated_at FROM sonarr_library_cache WHERE id = 1").get() as
      { series: string; generated_at: string } | undefined;
    if (!row) return null;
    let items: unknown;
    try {
      items = JSON.parse(row.series);
    } catch {
      return null;
    }
    if (!Array.isArray(items) || !items.every(isCurrentShapeSonarrLibraryItem)) return null;
    return { items, generatedAt: row.generated_at };
  }

  saveSonarrLibraryCache(items: SonarrLibraryCacheItem[]): string {
    const generatedAt = now();
    this.db.prepare(`
      INSERT INTO sonarr_library_cache (id, series, generated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET series = excluded.series, generated_at = excluded.generated_at
    `).run(JSON.stringify(items), generatedAt);
    return generatedAt;
  }

  listKnownNewShowTriageIds(): Set<number> {
    return new Set((this.db.prepare("SELECT sonarr_series_id FROM new_show_triage").all() as Array<{ sonarr_series_id: number }>)
      .map((row) => row.sonarr_series_id));
  }

  recordNewShowTriage(input: { seriesId: number; title: string; addedAt: string | null; decision: "baseline" | "enroll" | "search" }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO new_show_triage (sonarr_series_id, title, added_at, decision, completed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.seriesId, input.title, input.addedAt, input.decision, now());
  }

  hasPendingNewShowTriageEnrollment(seriesId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM new_show_triage_pending_enrollments WHERE sonarr_series_id = ?").get(seriesId));
  }

  startNewShowTriageEnrollment(input: { seriesId: number; title: string; addedAt: string | null }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO new_show_triage_pending_enrollments (sonarr_series_id, title, added_at, started_at)
      VALUES (?, ?, ?, ?)
    `).run(input.seriesId, input.title, input.addedAt, now());
  }

  completeNewShowTriageEnrollment(seriesId: number): void {
    this.db.prepare("DELETE FROM new_show_triage_pending_enrollments WHERE sonarr_series_id = ?").run(seriesId);
  }

  getNewShowTriageFallbackBaselineAt(): string | null {
    return this.getSetting<string>("newShowTriageFallbackBaselineAt");
  }

  setNewShowTriageFallbackBaselineAt(value: string | null): void {
    this.setSetting("newShowTriageFallbackBaselineAt", value);
  }

  getHistorySyncState(): HistorySyncState {
    const fallback: HistorySyncState = {
      plex: { backfillComplete: false, cursor: null },
      tautulli: { backfillComplete: false, cursor: null },
    };
    const stored = this.getSetting<Partial<HistorySyncState>>("historySync") ?? {};
    return {
      plex: { ...fallback.plex, ...stored.plex },
      tautulli: { ...fallback.tautulli, ...stored.tautulli },
    };
  }

  saveHistorySyncState(state: HistorySyncState): void {
    this.setSetting("historySync", state);
  }

  getPlexOwner(): PlexOwnerRecord | null {
    return this.getSetting<PlexOwnerRecord>("plexOwner");
  }

  savePlexOwner(owner: PlexOwnerRecord): void {
    this.setSetting("plexOwner", owner);
  }

  getPlexSettings(): PlexSettingsInput | null {
    return this.getSetting<PlexSettingsInput>("plex");
  }

  getPlexSettingsView(): PlexSettingsView | null {
    const settings = this.getPlexSettings();
    if (!settings) return null;
    return {
      serverUrl: settings.serverUrl,
      machineIdentifier: settings.machineIdentifier,
      tokenConfigured: Boolean(settings.token),
    };
  }

  savePlexSettings(settings: PlexSettingsInput): void {
    this.setSetting("plex", settings);
  }

  getSonarrSettings(): SonarrSettings | null {
    return this.getSetting<SonarrSettings>("sonarr");
  }

  getSonarrSettingsView(): SonarrSettingsView | null {
    const settings = this.getSonarrSettings();
    if (!settings) return null;
    return { baseUrl: settings.baseUrl, apiKeyConfigured: Boolean(settings.apiKey) };
  }

  saveSonarrSettings(settings: SonarrSettings): void {
    this.setSetting("sonarr", settings);
  }

  getTautulliSettings(): TautulliSettings {
    return {
      enabled: false,
      baseUrl: "",
      apiKey: "",
      ...(this.getSetting<Partial<TautulliSettings>>("tautulli") ?? {}),
    };
  }

  getTautulliSettingsView(): TautulliSettingsView {
    const settings = this.getTautulliSettings();
    return { enabled: settings.enabled, baseUrl: settings.baseUrl, apiKeyConfigured: Boolean(settings.apiKey) };
  }

  saveTautulliSettings(settings: TautulliSettings): void {
    this.setSetting("tautulli", settings);
  }

  createSession(id: string, plexId: string, expiresAt: string): void {
    this.db.prepare("INSERT INTO sessions (id, plex_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(hashSessionId(id), plexId, expiresAt, now());
  }

  getSession(id: string): SessionUser | null {
    const row = this.db.prepare("SELECT plex_id FROM sessions WHERE id = ? AND expires_at > ?").get(hashSessionId(id), now()) as { plex_id: string } | undefined;
    if (!row) return null;
    const owner = this.getPlexOwner();
    if (!owner || owner.plexId !== row.plex_id) return null;
    // User discovery also caches the owner's avatar. Prefer that value so
    // sessions created before this cache behavior still render an avatar.
    const cachedOwner = this.db.prepare("SELECT avatar_url FROM users WHERE plex_user_id = ?").get(owner.plexId) as { avatar_url: string | null } | undefined;
    return {
      plexId: owner.plexId,
      username: owner.username,
      displayName: owner.displayName,
      email: owner.email,
      avatarUrl: cachedOwner?.avatar_url?.startsWith("/images/") ? cachedOwner.avatar_url : owner.avatarUrl?.startsWith("/images/") ? owner.avatarUrl : null,
    };
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(hashSessionId(id));
  }

  getBootstrapStatus(hasActiveSession: boolean) {
    const app = this.getAppSettings();
    return {
      hasOwner: Boolean(this.getPlexOwner()),
      configurationValid: Boolean(this.getPlexSettings() && this.getSonarrSettings()),
      onboardingComplete: app.onboardingComplete,
      hasActiveSession,
    };
  }

  upsertUsers(users: Array<Omit<UserRecord, "id" | "enabled" | "lastSeenAt" | "tautulliUsername"> & { enabled?: boolean }>): UserRecord[] {
    const stamp = now();
    const stmt = this.db.prepare(`
      INSERT INTO users (plex_user_id, plex_account_id, tautulli_user_id, username, display_name, avatar_url, enabled, last_seen_at, created_at, updated_at)
      VALUES (@plexUserId, @plexAccountId, @tautulliUserId, @username, @displayName, @avatarUrl, @enabled, @lastSeenAt, @createdAt, @updatedAt)
      ON CONFLICT(plex_user_id) DO UPDATE SET
        plex_account_id = COALESCE(excluded.plex_account_id, users.plex_account_id),
        username = excluded.username,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);
    const tx = this.db.transaction(() => {
      for (const user of users) {
        stmt.run({
          ...user,
          enabled: user.enabled === false ? 0 : 1,
          lastSeenAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
    });
    tx();
    return this.listUsers();
  }

  listUsers(): UserRecord[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY display_name").all() as any[]).map(userFromRow);
  }

  updateUserAvatarUrl(id: number, avatarUrl: string | null): UserRecord {
    this.db.prepare("UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?").run(avatarUrl, now(), id);
    return this.getUser(id)!;
  }

  listEnabledUsers(): UserRecord[] {
    return (this.db.prepare("SELECT * FROM users WHERE enabled = 1 ORDER BY display_name").all() as any[]).map(userFromRow);
  }

  updateUser(id: number, patch: Partial<Pick<UserRecord, "enabled" | "tautulliUsername">>): UserRecord {
    const current = this.getUser(id);
    if (!current) throw new Error("User not found");
    this.db.prepare("UPDATE users SET enabled = ?, tautulli_username = ?, updated_at = ? WHERE id = ?")
      .run((patch.enabled ?? current.enabled) ? 1 : 0, patch.tautulliUsername === undefined ? current.tautulliUsername ?? null : patch.tautulliUsername, now(), id);
    return this.getUser(id)!;
  }

  getUser(id: number): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row ? userFromRow(row) : null;
  }

  findUserByAccount(plexAccountId?: string | null, username?: string | null): UserRecord | null {
    let row: any;
    if (plexAccountId) row = this.db.prepare("SELECT * FROM users WHERE plex_account_id = ?").get(plexAccountId);
    if (!row && username) row = this.db.prepare("SELECT * FROM users WHERE lower(username) = lower(?) OR lower(display_name) = lower(?)").get(username, username);
    return row ? userFromRow(row) : null;
  }

  linkUnassignedWatchEventsByPlexAccount(userId: number, plexAccountId: string): number {
    return this.db.prepare(`
      UPDATE watch_events
      SET user_id = ?
      WHERE user_id IS NULL AND plex_account_id = ?
    `).run(userId, plexAccountId).changes;
  }

  /**
   * Repairs one previously-imported Tautulli watch event whose user_id is still NULL.
   * insertWatchEvent(Batch) uses INSERT OR IGNORE keyed on (source, source_event_id), so a
   * duplicate — including an event first imported before the #75 matching fix, when the
   * resolved name didn't match anything yet — is silently skipped on every later import and
   * never revisited on its own. Scoped to a single event by its unique key rather than a
   * broader relink like linkUnassignedWatchEventsByPlexAccount, since Tautulli events carry
   * no stable account identifier to relink by.
   */
  repairUnmatchedTautulliWatchEvent(sourceEventId: string, userId: number): boolean {
    return this.db.prepare(`
      UPDATE watch_events
      SET user_id = ?
      WHERE source = 'tautulli' AND source_event_id = ? AND user_id IS NULL
    `).run(userId, sourceEventId).changes > 0;
  }

  listLatestWatchProgressForUser(userId: number): Array<{ sonarrSeriesId: number; seasonNumber: number; episodeNumber: number; watchedAt: string }> {
    return this.db.prepare(`
      SELECT sonarr_series_id AS sonarrSeriesId, season_number AS seasonNumber, episode_number AS episodeNumber, watched_at AS watchedAt
      FROM (
        SELECT sonarr_series_id, season_number, episode_number, watched_at,
          ROW_NUMBER() OVER (PARTITION BY sonarr_series_id ORDER BY watched_at DESC, id DESC) AS row_number
        FROM watch_events
        WHERE user_id = ? AND sonarr_series_id IS NOT NULL
      )
      WHERE row_number = 1
    `).all(userId) as Array<{ sonarrSeriesId: number; seasonNumber: number; episodeNumber: number; watchedAt: string }>;
  }

  /**
   * Tautulli reports two independent names for the same event: `username`, the real Plex
   * username (absent for Plex Home/managed users), and `friendlyName`, the Tautulli
   * admin's editable display name for that user. Either can be renamed without touching
   * the other, and discovery only ever stores what Plex reports (username, falling back to
   * Plex's own title for accounts without one) — so a match has to try both independently
   * rather than trusting whichever one Tautulli happened to report. An ambiguous match on
   * the real username field specifically still has to stop the lookup outright rather than
   * falling through to the friendly name: the friendly name is a weaker, Tautulli-admin-
   * editable signal, and a coincidental match there could attribute the event to a third
   * user unrelated to the ones the username was ambiguous between. An ambiguous match on
   * display_name during the username candidate's own fallback step doesn't get the same
   * treatment — that's a failed primary lookup, not a genuine conflict on the strong
   * signal, so the friendly name (an independent identifier that may resolve cleanly) is
   * still worth trying. Discovery inserts no Tautulli identity; administrators add stable
   * mappings explicitly. A stable mapped ID and a manually saved Tautulli username take
   * priority when present; ambiguous saved or Plex usernames still stop matching rather
   * than falling through to a weaker name.
   */
  createTautulliUserResolver(): (tautulliUserId: string | null, username?: string | null, friendlyName?: string | null) => UserRecord | null {
    const users = this.listUsers();
    const byTautulliId = new Map(users.filter((user) => user.tautulliUserId).map((user) => [user.tautulliUserId!, user]));
    const bySavedName = usersByNormalisedName(users, (user) => user.tautulliUsername);
    const byUsername = usersByNormalisedName(users, (user) => user.username);
    const byDisplayName = usersByNormalisedName(users, (user) => user.displayName);
    const matchByName = (normalisedName: string) => {
      const usernameMatches = byUsername.get(normalisedName) ?? [];
      if (usernameMatches.length === 1) return { user: usernameMatches[0]!, usernameAmbiguous: false };
      if (usernameMatches.length > 1) return { user: null, usernameAmbiguous: true };
      const displayNameMatches = byDisplayName.get(normalisedName) ?? [];
      return { user: displayNameMatches.length === 1 ? displayNameMatches[0]! : null, usernameAmbiguous: false };
    };
    return (tautulliUserId, username, friendlyName) => {
      if (tautulliUserId && byTautulliId.has(tautulliUserId)) return byTautulliId.get(tautulliUserId)!;
      const normalisedUsername = normaliseName(username);
      const normalisedFriendlyName = normaliseName(friendlyName);
      for (const normalisedName of [normalisedUsername, normalisedFriendlyName]) {
        if (!normalisedName) continue;
        const savedNameMatches = bySavedName.get(normalisedName) ?? [];
        if (savedNameMatches.length === 1) return savedNameMatches[0]!;
        if (savedNameMatches.length > 1) return null;
      }
      const byUsernameMatch = matchByName(normalisedUsername);
      if (byUsernameMatch.user || byUsernameMatch.usernameAmbiguous) return byUsernameMatch.user;
      return matchByName(normalisedFriendlyName).user;
    };
  }

  listUnmappedTautulliUsers(): UnmappedTautulliUser[] {
    return this.db.prepare(`
      WITH unmapped AS (
        SELECT id, CAST(json_extract(raw_payload, '$.user_id') AS TEXT) AS tautulliUserId,
          username, json_extract(raw_payload, '$.user') AS friendlyName, watched_at
        FROM watch_events
        WHERE source = 'tautulli' AND user_id IS NULL
          AND json_extract(raw_payload, '$.user_id') IS NOT NULL
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY tautulliUserId ORDER BY watched_at DESC, id DESC) AS row_number,
          count(*) OVER (PARTITION BY tautulliUserId) AS eventCount
        FROM unmapped
      )
      SELECT tautulliUserId, username, friendlyName, eventCount, watched_at AS lastWatchedAt
      FROM ranked
      WHERE row_number = 1
      ORDER BY lastWatchedAt DESC
    `).all() as UnmappedTautulliUser[];
  }

  mapTautulliUser(userId: number, tautulliUserId: string, tautulliUsername: string | null): UserRecord {
    const current = this.getUser(userId);
    if (!current) throw new Error("User not found");
    if (current.tautulliUserId && current.tautulliUserId !== tautulliUserId) {
      throw new Error("Tautulli user mapping conflict");
    }
    const mappedUser = this.db.prepare("SELECT id FROM users WHERE tautulli_user_id = ?").get(tautulliUserId) as { id: number } | undefined;
    if (mappedUser && mappedUser.id !== userId) throw new Error("Tautulli identity already mapped");
    this.db.prepare("UPDATE users SET tautulli_user_id = ?, tautulli_username = ?, updated_at = ? WHERE id = ?").run(tautulliUserId, tautulliUsername, now(), userId);
    return this.getUser(userId)!;
  }

  fillMissingTautulliUsernames(matches: Array<{ userId: number; username: string | null }>): void {
    const update = this.db.prepare(`
      UPDATE users SET tautulli_username = ?, updated_at = ?
      WHERE id = ? AND (tautulli_username IS NULL OR trim(tautulli_username) = '')
    `);
    const stamp = now();
    this.db.transaction((items: Array<{ userId: number; username: string | null }>) => {
      for (const item of items) if (item.username?.trim()) update.run(item.username.trim(), stamp, item.userId);
    })(matches);
  }

  linkUnassignedTautulliWatchEvents(userId: number, tautulliUserId: string): number {
    return this.db.prepare(`
      UPDATE watch_events SET user_id = ?
      WHERE source = 'tautulli' AND user_id IS NULL
        AND CAST(json_extract(raw_payload, '$.user_id') AS TEXT) = ?
    `).run(userId, tautulliUserId).changes;
  }

  upsertRollingShow(series: SonarrSeries): RollingShowRecord {
    const stamp = now();
    this.db.prepare(`
      INSERT INTO rolling_shows (sonarr_series_id, title, tvdb_id, imdb_id, year, expanded_seasons, last_activity_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, ?)
      ON CONFLICT(sonarr_series_id) DO UPDATE SET
        title = excluded.title,
        tvdb_id = excluded.tvdb_id,
        imdb_id = excluded.imdb_id,
        year = excluded.year,
        updated_at = excluded.updated_at
    `).run(series.id, series.title, series.tvdbId ?? null, series.imdbId ?? null, series.year ?? null, stamp, stamp);
    return this.getRollingShowBySeriesId(series.id)!;
  }

  deleteRollingShow(id: number): void {
    this.db.prepare("DELETE FROM rolling_shows WHERE id = ?").run(id);
  }

  listPlexArtwork(rollingShowId: number): PlexArtworkRecord[] {
    return (this.db.prepare("SELECT * FROM plex_artwork WHERE rolling_show_id = ? ORDER BY season_number").all(rollingShowId) as any[])
      .map(plexArtworkFromRow);
  }

  getPlexArtwork(rollingShowId: number, plexItemRatingKey: string, itemType: PlexArtworkRecord["itemType"]): PlexArtworkRecord | null {
    const row = this.db.prepare("SELECT * FROM plex_artwork WHERE rolling_show_id = ? AND plex_season_rating_key = ? AND item_type = ?")
      .get(rollingShowId, plexItemRatingKey, itemType) as any | undefined;
    return row ? plexArtworkFromRow(row) : null;
  }

  createPlexArtwork(input: Omit<PlexArtworkRecord, "id" | "overlayApplied" | "renderVersion" | "overlayThumb" | "createdAt" | "updatedAt">): PlexArtworkRecord {
    const stamp = now();
    this.db.prepare(`
      INSERT INTO plex_artwork (
        rolling_show_id, plex_show_rating_key, plex_season_rating_key, season_number,
        original_poster_path, overlay_poster_path, item_type, overlay_sha256, render_version, overlay_applied, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3, 0, ?, ?)
    `).run(input.rollingShowId, input.plexShowRatingKey, input.plexItemRatingKey, input.seasonNumber,
      input.originalPosterPath, input.overlayPosterPath, input.itemType, input.overlaySha256, stamp, stamp);
    return this.getPlexArtwork(input.rollingShowId, input.plexItemRatingKey, input.itemType)!;
  }

  setPlexArtworkOverlayApplied(id: number, overlayApplied: boolean, renderVersion?: number, overlayThumb?: string): void {
    this.db.prepare("UPDATE plex_artwork SET overlay_applied = ?, render_version = COALESCE(?, render_version), overlay_thumb = COALESCE(?, overlay_thumb), updated_at = ? WHERE id = ?")
      .run(overlayApplied ? 1 : 0, renderVersion ?? null, overlayThumb ?? null, now(), id);
  }

  updatePlexArtworkSource(id: number, overlaySha256: string, renderVersion: number): void {
    this.db.prepare("UPDATE plex_artwork SET overlay_sha256 = ?, render_version = ?, updated_at = ? WHERE id = ?")
      .run(overlaySha256, renderVersion, now(), id);
  }

  updatePlexArtworkPaths(id: number, originalPosterPath: string, overlayPosterPath: string): void {
    this.db.prepare("UPDATE plex_artwork SET original_poster_path = ?, overlay_poster_path = ?, updated_at = ? WHERE id = ?")
      .run(originalPosterPath, overlayPosterPath, now(), id);
  }

  listRollingShows(): RollingShowRecord[] {
    return (this.db.prepare("SELECT * FROM rolling_shows ORDER BY title").all() as any[]).map(rollingShowFromRow);
  }

  getRollingShow(id: number): RollingShowRecord | null {
    const row = this.db.prepare("SELECT * FROM rolling_shows WHERE id = ?").get(id);
    return row ? rollingShowFromRow(row) : null;
  }

  getRollingShowBySeriesId(seriesId: number): RollingShowRecord | null {
    const row = this.db.prepare("SELECT * FROM rolling_shows WHERE sonarr_series_id = ?").get(seriesId);
    return row ? rollingShowFromRow(row) : null;
  }

  markSeasonExpanded(rollingShowId: number, seasonNumber: number, watchedAt: string): boolean {
    const show = this.getRollingShow(rollingShowId);
    if (!show) return false;
    if (show.expandedSeasons.includes(seasonNumber)) return false;
    const expanded = [...show.expandedSeasons, seasonNumber].sort((a, b) => a - b);
    this.db.prepare("UPDATE rolling_shows SET expanded_seasons = ?, last_activity_at = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(expanded), watchedAt, now(), rollingShowId);
    this.clearPrefetchedEpisodesForSeason(rollingShowId, seasonNumber);
    return true;
  }

  resetExpandedSeasons(rollingShowId: number): void {
    this.db.prepare("UPDATE rolling_shows SET expanded_seasons = '[]', updated_at = ? WHERE id = ?").run(now(), rollingShowId);
    this.db.prepare("DELETE FROM rolling_season_inactivity WHERE rolling_show_id = ?").run(rollingShowId);
    this.clearPrefetchedEpisodes(rollingShowId);
  }

  clearPrefetchedEpisodes(rollingShowId: number): void {
    this.db.prepare("DELETE FROM rolling_prefetched_episodes WHERE rolling_show_id = ?").run(rollingShowId);
  }

  listPrefetchedEpisodes(rollingShowId: number): PrefetchedEpisodeRecord[] {
    return (this.db.prepare(`
      SELECT id, rolling_show_id AS rollingShowId, user_id AS userId,
        season_number AS seasonNumber, episode_number AS episodeNumber, triggered_at AS triggeredAt
      FROM rolling_prefetched_episodes
      WHERE rolling_show_id = ?
      ORDER BY season_number, episode_number
    `).all(rollingShowId) as PrefetchedEpisodeRecord[]);
  }

  listPrefetchedEpisodesWithUsers(rollingShowId: number): Array<PrefetchedEpisodeRecord & { displayName: string; avatarUrl: string | null }> {
    return this.db.prepare(`
      SELECT rpe.id, rpe.rolling_show_id AS rollingShowId, rpe.user_id AS userId,
        rpe.season_number AS seasonNumber, rpe.episode_number AS episodeNumber,
        rpe.triggered_at AS triggeredAt, u.display_name AS displayName, u.avatar_url AS avatarUrl
      FROM rolling_prefetched_episodes rpe
      JOIN users u ON u.id = rpe.user_id
      WHERE rpe.rolling_show_id = ?
      ORDER BY rpe.season_number, rpe.episode_number
    `).all(rollingShowId) as Array<PrefetchedEpisodeRecord & { displayName: string; avatarUrl: string | null }>;
  }

  recordPrefetchedEpisodes(rollingShowId: number, userId: number, seasonNumber: number, episodeNumbers: number[], triggeredAt: string): number {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO rolling_prefetched_episodes
        (rolling_show_id, user_id, season_number, episode_number, triggered_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction(() => {
      let inserted = 0;
      for (const episodeNumber of episodeNumbers) {
        inserted += Number(insert.run(rollingShowId, userId, seasonNumber, episodeNumber, triggeredAt, now()).changes > 0);
      }
      return inserted;
    });
    return transaction();
  }

  clearPrefetchedEpisodesForSeason(rollingShowId: number, seasonNumber: number): void {
    this.db.prepare("DELETE FROM rolling_prefetched_episodes WHERE rolling_show_id = ? AND season_number = ?")
      .run(rollingShowId, seasonNumber);
  }

  replaceExpandedSeasons(rollingShowId: number, seasonNumbers: number[]): void {
    const expanded = [...new Set(seasonNumbers)].filter((season) => season > 0).sort((a, b) => a - b);
    this.db.prepare("UPDATE rolling_shows SET expanded_seasons = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(expanded), now(), rollingShowId);
    if (expanded.length === 0) {
      this.db.prepare("DELETE FROM rolling_season_inactivity WHERE rolling_show_id = ?").run(rollingShowId);
    } else {
      this.db.prepare(`DELETE FROM rolling_season_inactivity
        WHERE rolling_show_id = ? AND season_number NOT IN (${expanded.map(() => "?").join(", ")})`)
        .run(rollingShowId, ...expanded);
    }
  }

  removeExpandedSeason(rollingShowId: number, seasonNumber: number): void {
    const show = this.getRollingShow(rollingShowId);
    if (!show) return;
    const expanded = show.expandedSeasons.filter((season) => season !== seasonNumber);
    this.db.prepare("UPDATE rolling_shows SET expanded_seasons = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(expanded), now(), rollingShowId);
    this.clearSeasonInactivity(rollingShowId, seasonNumber);
  }

  getSeasonInactiveSince(rollingShowId: number, seasonNumber: number): string | null {
    const row = this.db.prepare(`
      SELECT inactive_since AS inactiveSince FROM rolling_season_inactivity
      WHERE rolling_show_id = ? AND season_number = ?
    `).get(rollingShowId, seasonNumber) as { inactiveSince: string } | undefined;
    return row?.inactiveSince ?? null;
  }

  markSeasonInactive(rollingShowId: number, seasonNumber: number, inactiveSince: string): void {
    this.db.prepare(`
      INSERT INTO rolling_season_inactivity (rolling_show_id, season_number, inactive_since)
      VALUES (?, ?, ?)
      ON CONFLICT(rolling_show_id, season_number) DO NOTHING
    `).run(rollingShowId, seasonNumber, inactiveSince);
  }

  clearSeasonInactivity(rollingShowId: number, seasonNumber: number): void {
    this.db.prepare("DELETE FROM rolling_season_inactivity WHERE rolling_show_id = ? AND season_number = ?")
      .run(rollingShowId, seasonNumber);
  }

  upsertRollingUserProgress(rollingShowId: number, userId: number, season: number, episode: number, watchedAt: string): boolean {
    const stamp = now();
    return this.db.prepare(`
      INSERT INTO rolling_show_users (rolling_show_id, user_id, last_watched_season, last_watched_episode, last_watched_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rolling_show_id, user_id) DO UPDATE SET
        last_watched_season = excluded.last_watched_season,
        last_watched_episode = excluded.last_watched_episode,
        last_watched_at = excluded.last_watched_at,
        updated_at = excluded.updated_at
      -- A viewer can restart a show after reaching a later season. Their
      -- current rolling position is their most recent watch, not their
      -- numerically furthest historical episode.
      WHERE excluded.last_watched_at >= rolling_show_users.last_watched_at
    `).run(rollingShowId, userId, season, episode, watchedAt, stamp, stamp).changes > 0;
  }

  listProgressForShow(rollingShowId: number): RollingShowUserRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        rolling_show_id AS rollingShowId,
        user_id AS userId,
        last_watched_season AS lastWatchedSeason,
        last_watched_episode AS lastWatchedEpisode,
        last_watched_at AS lastWatchedAt
      FROM rolling_show_users
      WHERE rolling_show_id = ?
    `).all(rollingShowId) as RollingShowUserRecord[];
  }

  private getRollingUserProgress(rollingShowId: number, userId: number): RollingShowUserRecord | null {
    return this.db.prepare(`
      SELECT
        id,
        rolling_show_id AS rollingShowId,
        user_id AS userId,
        last_watched_season AS lastWatchedSeason,
        last_watched_episode AS lastWatchedEpisode,
        last_watched_at AS lastWatchedAt
      FROM rolling_show_users
      WHERE rolling_show_id = ? AND user_id = ?
    `).get(rollingShowId, userId) as RollingShowUserRecord | null;
  }

  /**
   * Per-user answer to "what is this person keeping expanded?" — the count of enrolled
   * shows where they are still an active viewer, plus when they last watched anything.
   * Every enabled viewer inside the activity window is a reason some season stays on
   * disk, which is what makes the enable/disable switch on the Users page meaningful.
   */
  countActiveShowsByUser(activeSince: string): Map<number, { activeShowCount: number; lastWatchedAt: string | null }> {
    // The count is windowed but the timestamp deliberately is not: a viewer who has gone
    // quiet should still show when they were last seen, not "never". The count is also
    // conditioned on the user still being enabled — a disabled viewer's watches don't
    // keep anything expanded (see the `.enabled` filters throughout the retention
    // calculation in services.ts), so counting them here would show "N shows active" for
    // someone whose switch has no effect on any of them.
    const rows = this.db.prepare(`
      SELECT rsu.user_id AS userId,
        SUM(CASE WHEN rsu.last_watched_at >= ? AND rsu.last_watched_season > 0 AND users.enabled = 1 THEN 1 ELSE 0 END) AS activeShowCount,
        MAX(rsu.last_watched_at) AS lastWatchedAt
      FROM rolling_show_users rsu
      JOIN users ON users.id = rsu.user_id
      GROUP BY rsu.user_id
    `).all(activeSince) as Array<{ userId: number; activeShowCount: number; lastWatchedAt: string | null }>;
    return new Map(rows.map((row) => [row.userId, { activeShowCount: row.activeShowCount, lastWatchedAt: row.lastWatchedAt }]));
  }

  listShowsDrivenByUser(userId: number): Array<{ sonarrSeriesId: number; title: string; seasonNumber: number; episodeNumber: number; watchedAt: string }> {
    return this.db.prepare(`
      SELECT rs.sonarr_series_id AS sonarrSeriesId,
        rs.title,
        rsu.last_watched_season AS seasonNumber,
        rsu.last_watched_episode AS episodeNumber,
        rsu.last_watched_at AS watchedAt
      FROM rolling_show_users rsu
      JOIN rolling_shows rs ON rs.id = rsu.rolling_show_id
      WHERE rsu.user_id = ?
      ORDER BY rsu.last_watched_at DESC
    `).all(userId) as Array<{ sonarrSeriesId: number; title: string; seasonNumber: number; episodeNumber: number; watchedAt: string }>;
  }

  listLatestUserProgressForSeries(sonarrSeriesId: number, since?: string) {
    const filter = since ? "AND we.watched_at >= ?" : "";
    const values = since ? [sonarrSeriesId, since] : [sonarrSeriesId];
    return this.db.prepare(`
      WITH ranked_events AS (
        SELECT we.user_id, we.season_number, we.episode_number, we.watched_at, we.id,
          ROW_NUMBER() OVER (
            PARTITION BY we.user_id
            ORDER BY we.watched_at DESC, we.id DESC
          ) AS row_number
        FROM watch_events we
        WHERE we.sonarr_series_id = ? AND we.user_id IS NOT NULL ${filter}
      )
      SELECT users.id AS userId, users.display_name AS displayName, users.avatar_url AS avatarUrl,
        users.enabled AS enabled, ranked_events.season_number AS seasonNumber,
        ranked_events.episode_number AS episodeNumber, ranked_events.watched_at AS watchedAt
      FROM ranked_events
      JOIN users ON users.id = ranked_events.user_id
      WHERE ranked_events.row_number = 1
      ORDER BY ranked_events.watched_at DESC, users.display_name
    `).all(...values).map((row: any) => ({ ...row, enabled: bool(row.enabled) }));
  }

  /** Batched form of listLatestUserProgressForSeries — avoids one query per series when listing an entire library. */
  listLatestUserProgressForSeriesBatch(sonarrSeriesIds: number[], since?: string): Map<number, ShowUserProgress[]> {
    if (sonarrSeriesIds.length === 0) return new Map();
    const placeholders = sonarrSeriesIds.map(() => "?").join(", ");
    const filter = since ? "AND we.watched_at >= ?" : "";
    const values = since ? [...sonarrSeriesIds, since] : [...sonarrSeriesIds];
    const rows = this.db.prepare(`
      WITH ranked_events AS (
        SELECT we.sonarr_series_id AS sonarr_series_id, we.user_id, we.season_number, we.episode_number, we.watched_at, we.id,
          ROW_NUMBER() OVER (
            PARTITION BY we.sonarr_series_id, we.user_id
            ORDER BY we.watched_at DESC, we.id DESC
          ) AS row_number
        FROM watch_events we
        WHERE we.sonarr_series_id IN (${placeholders}) AND we.user_id IS NOT NULL ${filter}
      )
      SELECT ranked_events.sonarr_series_id AS sonarrSeriesId, users.id AS userId, users.display_name AS displayName,
        users.avatar_url AS avatarUrl, users.enabled AS enabled, ranked_events.season_number AS seasonNumber,
        ranked_events.episode_number AS episodeNumber, ranked_events.watched_at AS watchedAt
      FROM ranked_events
      JOIN users ON users.id = ranked_events.user_id
      WHERE ranked_events.row_number = 1
      ORDER BY ranked_events.watched_at DESC, users.display_name
    `).all(...values) as Array<ShowUserProgress & { sonarrSeriesId: number; enabled: number | boolean }>;

    const grouped = new Map<number, ShowUserProgress[]>();
    for (const { sonarrSeriesId, ...row } of rows) {
      const progress: ShowUserProgress = { ...row, enabled: bool(row.enabled) };
      grouped.set(sonarrSeriesId, [...(grouped.get(sonarrSeriesId) ?? []), progress]);
    }
    return grouped;
  }

  listWatchStatsForSeries(sonarrSeriesId: number) {
    return this.db.prepare(`
      SELECT
        season_number AS seasonNumber,
        episode_number AS episodeNumber,
        COUNT(DISTINCT user_id) AS watchedUsers,
        MAX(watched_at) AS latestWatchedAt
      FROM watch_events
      WHERE sonarr_series_id = ? AND user_id IS NOT NULL
      GROUP BY season_number, episode_number
    `).all(sonarrSeriesId) as Array<{
      seasonNumber: number;
      episodeNumber: number;
      watchedUsers: number;
      latestWatchedAt: string | null;
    }>;
  }

  listSeasonWatchStatsForSeries(sonarrSeriesId: number) {
    return this.db.prepare(`
      SELECT
        season_number AS seasonNumber,
        COUNT(DISTINCT user_id) AS watchedUsers,
        MAX(watched_at) AS latestWatchedAt
      FROM watch_events
      WHERE sonarr_series_id = ? AND user_id IS NOT NULL
      GROUP BY season_number
    `).all(sonarrSeriesId) as Array<{
      seasonNumber: number;
      watchedUsers: number;
      latestWatchedAt: string | null;
    }>;
  }

  insertWatchEvent(input: NormalizedWatchEventInput): { inserted: boolean; id: number | null } {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO watch_events
        (source, source_event_id, user_id, plex_account_id, username, sonarr_series_id, show_title, season_number, episode_number, watched_at, raw_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.source,
      input.sourceEventId,
      input.userId,
      input.plexAccountId,
      input.username,
      input.sonarrSeriesId,
      input.showTitle,
      input.seasonNumber,
      input.episodeNumber,
      input.watchedAt,
      JSON.stringify(input.rawPayload),
      now()
    );
    // SQLite's last_insert_rowid() is not reset by an ignored INSERT OR IGNORE - it keeps
    // whatever a previous successful insert on this connection left it as. Gate on
    // result.changes, not the truthiness of lastInsertRowid, or an ignored (duplicate)
    // event would incorrectly report some unrelated earlier row's id as its own.
    return { inserted: result.changes > 0, id: result.changes > 0 ? Number(result.lastInsertRowid) : null };
  }

  /**
   * Batched form of insertWatchEvent — wraps every insert in a single transaction instead
   * of one auto-committed transaction per row. A history import or full reconciliation can
   * process thousands of rows in one run; measured on this exact pattern, 2000 unwrapped
   * inserts took ~212ms versus ~3ms wrapped in one transaction.
   */
  insertWatchEventsBatch(inputs: NormalizedWatchEventInput[]): Array<{ inserted: boolean; id: number | null }> {
    if (inputs.length === 0) return [];
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO watch_events
        (source, source_event_id, user_id, plex_account_id, username, sonarr_series_id, show_title, season_number, episode_number, watched_at, raw_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const stamp = now();
    const insertAll = this.db.transaction((items: NormalizedWatchEventInput[]) => items.map((item) => {
      const result = insert.run(
        item.source,
        item.sourceEventId,
        item.userId,
        item.plexAccountId,
        item.username,
        item.sonarrSeriesId,
        item.showTitle,
        item.seasonNumber,
        item.episodeNumber,
        item.watchedAt,
        JSON.stringify(item.rawPayload),
        stamp
      );
      return { inserted: result.changes > 0, id: result.changes > 0 ? Number(result.lastInsertRowid) : null };
    }));
    return insertAll(inputs);
  }

  listUnmatchedWatchEvents(): WatchEvent[] {
    return (this.db.prepare(`
      SELECT id, source, source_event_id AS sourceEventId, user_id AS userId,
        plex_account_id AS plexAccountId, username, sonarr_series_id AS sonarrSeriesId,
        show_title AS showTitle, season_number AS seasonNumber, episode_number AS episodeNumber,
        watched_at AS watchedAt, raw_payload AS rawPayload
      FROM watch_events
      WHERE sonarr_series_id IS NULL
    `).all() as any[]);
  }

  assignWatchEventToSeries(id: number, seriesId: number): void {
    this.db.prepare("UPDATE watch_events SET sonarr_series_id = ? WHERE id = ? AND sonarr_series_id IS NULL").run(seriesId, id);
  }

  countWatchEvents(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM watch_events").get() as { count: number }).count;
  }

  listDashboardShowActivity(activeSince: string): Omit<DashboardShowActivity, "posterUrl">[] {
    // Restricting latest_watch to currently-enrolled series avoids ranking every watch
    // event ever recorded (including for shows that were later unenrolled) just to find
    // the newest one per enrolled show — on a large history table this was the dominant
    // cost of loading the dashboard (see issue #59).
    return (this.db.prepare(`
      WITH latest_watch AS (
        SELECT we.sonarr_series_id, we.season_number, we.episode_number, we.watched_at, we.user_id,
          ROW_NUMBER() OVER (PARTITION BY we.sonarr_series_id ORDER BY we.watched_at DESC, we.id DESC) AS row_number
        FROM watch_events we
        WHERE we.sonarr_series_id IS NOT NULL
          AND we.sonarr_series_id IN (SELECT sonarr_series_id FROM rolling_shows)
      ), active_viewers AS (
        SELECT rsu.rolling_show_id, COUNT(DISTINCT rsu.user_id) AS active_viewer_count
        FROM rolling_show_users rsu JOIN users ON users.id = rsu.user_id
        WHERE users.enabled = 1 AND rsu.last_watched_at >= ?
        GROUP BY rsu.rolling_show_id
      )
      SELECT rs.id, rs.sonarr_series_id AS sonarrSeriesId, rs.title, rs.expanded_seasons AS expandedSeasons,
        COALESCE(av.active_viewer_count, 0) AS activeViewerCount,
        lw.watched_at AS lastWatchedAt, lw.season_number AS lastWatchedSeason,
        lw.episode_number AS lastWatchedEpisode, users.display_name AS lastWatcherName
      FROM rolling_shows rs
      LEFT JOIN active_viewers av ON av.rolling_show_id = rs.id
      LEFT JOIN latest_watch lw ON lw.sonarr_series_id = rs.sonarr_series_id AND lw.row_number = 1
      LEFT JOIN users ON users.id = lw.user_id
      ORDER BY lw.watched_at DESC NULLS LAST, rs.title COLLATE NOCASE
    `).all(activeSince) as any[]).map((row) => ({ ...row, expandedSeasons: parseJson<number[]>(row.expandedSeasons, []) }));
  }

  countActiveViewers(activeSince: string): number {
    return (this.db.prepare(`
      SELECT COUNT(DISTINCT rsu.user_id) AS count FROM rolling_show_users rsu
      JOIN users ON users.id = rsu.user_id
      WHERE users.enabled = 1 AND rsu.last_watched_at >= ?
    `).get(activeSince) as { count: number }).count;
  }

  recordStorageReclaim(input: { rollingShowId: number | null; sonarrSeriesId: number; showTitle: string; action: string; seasonNumber: number | null; fileCount: number; bytesReclaimed: number }): void {
    if (input.fileCount <= 0) return;
    this.db.prepare(`
      INSERT INTO reclaimed_storage_events
        (rolling_show_id, sonarr_series_id, show_title, action, season_number, file_count, bytes_reclaimed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.rollingShowId, input.sonarrSeriesId, input.showTitle, input.action, input.seasonNumber, input.fileCount, input.bytesReclaimed, now());
  }

  getReclaimedStorageTotals(): { bytesReclaimed: number; fileCount: number } {
    return this.db.prepare(`SELECT COALESCE(SUM(bytes_reclaimed), 0) AS bytesReclaimed, COALESCE(SUM(file_count), 0) AS fileCount FROM reclaimed_storage_events`).get() as { bytesReclaimed: number; fileCount: number };
  }

  getLatestWatchEventAt(source: EventSourceKind): string | null {
    return (this.db.prepare("SELECT MAX(watched_at) AS watchedAt FROM watch_events WHERE source = ?").get(source) as { watchedAt: string | null }).watchedAt;
  }

  addHistory(level: HistoryEvent["level"], action: string, title: string, details: unknown): void {
    this.db.prepare("INSERT INTO history_events (level, action, title, details, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(level, action, title, typeof details === "string" ? details : JSON.stringify(details), now());
  }

  listHistory(limit = 100): HistoryEvent[] {
    return (this.db.prepare("SELECT * FROM history_events ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(historyFromRow);
  }

  /**
   * Deletes history_events older than retentionDays, using the existing created_at
   * index. Scoped to history_events only, deliberately - watch_events (core
   * viewer-progress state) and reclaimed_storage_events (the Dashboard's lifetime
   * "Space reclaimed" total) must never be pruned; doing so would corrupt state other
   * features depend on, not just shrink an audit trail.
   */
  pruneHistoryEvents(retentionDays: number): number {
    // Defensive clamp for any internal/persisted caller, not just the settings API - see
    // MAX_SAFE_RETENTION_DAYS above for why the upper bound exists. The lower bound
    // matters just as much: 0 or a negative value pushes the cutoff to now-or-future,
    // which would silently delete every history_events row rather than throw - worse
    // than the overflow this was written to guard against. Math.min/Math.max both
    // propagate NaN if either operand is NaN, so that check has to happen first, not as
    // part of the same clamp expression.
    const safeDays = Number.isFinite(retentionDays)
      ? Math.max(1, Math.min(retentionDays, MAX_SAFE_RETENTION_DAYS))
      : DEFAULT_APP_SETTINGS.historyRetentionDays;
    const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare("DELETE FROM history_events WHERE created_at < ?").run(cutoff).changes;
  }

  listHistoryPaginated(options: {
    page: number;
    pageSize: number;
    level?: HistoryEvent["level"];
    category?: HistoryCategory;
  }): { results: HistoryEvent[]; total: number } {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];

    if (options.level) {
      conditions.push("level = ?");
      parameters.push(options.level);
    }
    if (options.category) {
      // A category is a fixed set of action names (live plus their dry-run twins), so it
      // filters as an IN list rather than needing a column on the table.
      const actions = actionsInCategory(options.category);
      conditions.push(`action IN (${actions.map(() => "?").join(", ")})`);
      parameters.push(...actions);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM history_events ${where}`).get(...parameters) as { count: number }).count;
    const offset = (options.page - 1) * options.pageSize;
    const results = (this.db.prepare(`
      SELECT * FROM history_events
      ${where}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, options.pageSize, offset) as any[]).map(historyFromRow);

    return { results, total };
  }

  getJobRunState(id: string) {
    return this.db.prepare("SELECT last_run_at AS lastRunAt, last_run_status AS lastRunStatus FROM job_run_state WHERE job_id = ?").get(id) as {
      lastRunAt: string | null;
      lastRunStatus: "success" | "error" | null;
    } | undefined;
  }

  saveJobRunState(id: string, state: { lastRunAt: string | null; lastRunStatus: "success" | "error" | null }): void {
    this.db.prepare(`
      INSERT INTO job_run_state (job_id, last_run_at, last_run_status, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        last_run_at = excluded.last_run_at,
        last_run_status = excluded.last_run_status,
        updated_at = excluded.updated_at
    `).run(id, state.lastRunAt, state.lastRunStatus, now());
  }
}
