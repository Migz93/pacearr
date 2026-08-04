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
  WatchEvent,
  ShowRecommendation,
  ShowUserProgress,
  SonarrLibraryCacheItem,
  DashboardShowActivity,
  PlexArtworkRecord,
  PrefetchedEpisodeRecord,
} from "../../shared/types.js";
import type { RuntimeConfig } from "../config.js";
import { createSecret } from "../auth.js";
import type { Logger } from "../logger.js";
import { runMigrations } from "./migrations.js";

const now = () => new Date().toISOString();

export const DEFAULT_APP_SETTINGS: AppSettings = {
  dryRun: true,
  artworkEnabled: false,
  viewerActivityWindowDays: 30,
  historyRetentionDays: 90,
  sessionPollIntervalMinutes: 5,
  historyImportIntervalHours: 24,
  inactivityResetDays: 7,
  autoResetEnabled: true,
  progressiveCleanupEnabled: true,
  progressiveCleanupDelayDays: 7,
  cleanupDeletesFiles: true,
  recommendationMinimumSavingsGb: 50,
  trustProxy: false,
  onboardingComplete: false,
  earlyPrefetchEnabled: false,
  earlyPrefetchTriggerEpisodesRemaining: 3,
  earlyPrefetchEpisodeCount: 2,
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

function userFromRow(row: any): UserRecord {
  return {
    id: row.id,
    plexUserId: row.plex_user_id,
    plexAccountId: row.plex_account_id,
    tautulliUserId: row.tautulli_user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    enabled: bool(row.enabled),
    lastSeenAt: row.last_seen_at,
  };
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

  private seedDefaults() {
    this.getSessionSecret();
    if (!this.getSetting("app")) this.setSetting("app", DEFAULT_APP_SETTINGS);
    for (const id of ["session-check", "history-import", "full-history-reconcile", "rolling-reconcile"]) {
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

  getRecommendationCache(): { candidates: ShowRecommendation[]; generatedAt: string } | null {
    const row = this.db.prepare("SELECT candidates, generated_at FROM recommendation_cache WHERE id = 1").get() as
      { candidates: string; generated_at: string } | undefined;
    return row ? { candidates: parseJson<ShowRecommendation[]>(row.candidates, []), generatedAt: row.generated_at } : null;
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
    return row ? { items: parseJson<SonarrLibraryCacheItem[]>(row.series, []), generatedAt: row.generated_at } : null;
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
    this.db.prepare("INSERT INTO sessions (id, plex_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(id, plexId, expiresAt, now());
  }

  getSession(id: string): SessionUser | null {
    const row = this.db.prepare("SELECT plex_id FROM sessions WHERE id = ? AND expires_at > ?").get(id, now()) as { plex_id: string } | undefined;
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
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
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

  upsertUsers(users: Array<Omit<UserRecord, "id" | "enabled" | "lastSeenAt"> & { enabled?: boolean }>): UserRecord[] {
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

  updateUser(id: number, patch: Partial<Pick<UserRecord, "enabled" | "tautulliUserId">>): UserRecord {
    const current = this.getUser(id);
    if (!current) throw new Error("User not found");
    this.db.prepare("UPDATE users SET enabled = ?, tautulli_user_id = ?, updated_at = ? WHERE id = ?")
      .run(patch.enabled ?? current.enabled ? 1 : 0, patch.tautulliUserId ?? current.tautulliUserId, now(), id);
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

  findUserByTautulliId(tautulliUserId?: string | null, username?: string | null): UserRecord | null {
    let row: any;
    if (tautulliUserId) row = this.db.prepare("SELECT * FROM users WHERE tautulli_user_id = ?").get(tautulliUserId);
    if (!row && username) row = this.db.prepare("SELECT * FROM users WHERE lower(username) = lower(?) OR lower(display_name) = lower(?)").get(username, username);
    return row ? userFromRow(row) : null;
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
    return { inserted: result.changes > 0, id: result.lastInsertRowid ? Number(result.lastInsertRowid) : null };
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
      return { inserted: result.changes > 0, id: result.lastInsertRowid ? Number(result.lastInsertRowid) : null };
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

  /** Deletes history_events older than retentionDays, using the existing created_at index. */
  pruneHistoryEvents(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare("DELETE FROM history_events WHERE created_at < ?").run(cutoff).changes;
  }

  listHistoryPaginated(options: {
    page: number;
    pageSize: number;
    level?: HistoryEvent["level"];
    action?: string;
  }): { results: HistoryEvent[]; total: number; actions: string[] } {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];

    if (options.level) {
      conditions.push("level = ?");
      parameters.push(options.level);
    }
    if (options.action) {
      conditions.push("action = ?");
      parameters.push(options.action);
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
    const actions = (this.db.prepare("SELECT DISTINCT action FROM history_events ORDER BY action").all() as Array<{ action: string }>)
      .map((row) => row.action);

    return { results, total, actions };
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
