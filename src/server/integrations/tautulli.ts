import type { ConnectionTestResult, TautulliSettings } from "../../shared/types.js";
import type { Logger } from "../logger.js";
import { liveSessionEventId } from "./live-session.js";
import { buildIntegrationUrl, fetchIntegration } from "./request.js";

export interface TautulliEpisodeRecord {
  referenceId: string;
  userId: string | null;
  /** The Plex username (Tautulli's `username` field) — absent for Plex Home/managed users. */
  username: string | null;
  /** Tautulli's admin-editable friendly name (its `user` field) — can be renamed independently of Plex. */
  friendlyName: string | null;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  watchedAt: string;
  ratingKey: string | null;
  grandparentRatingKey: string | null;
  raw: unknown;
}

export type TautulliHistoryRecord = TautulliEpisodeRecord;
export type TautulliActivityRecord = TautulliEpisodeRecord;

export type ExternalIds = { tvdbId: number | null; imdbId: string | null };

/**
 * A non-OK Tautulli response. Deliberately not an IntegrationHttpError: Tautulli answers
 * 404 when its API is disabled, which must never read as a missing Plex item.
 */
class TautulliHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TautulliHttpError";
  }
}

/**
 * Tautulli's "Unable to retrieve metadata" answer. Tautulli gives it both for a rating key
 * Plex no longer has and whenever its own request to Plex fails, so it proves neither.
 */
export class TautulliMetadataUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TautulliMetadataUnavailableError";
  }
}

export class TautulliIntegration {
  constructor(private readonly settings: TautulliSettings, private readonly logger: Logger) {}

  private buildUrl(params: Record<string, string | number | undefined>) {
    const url = buildIntegrationUrl(this.settings.baseUrl, "api/v2");
    url.searchParams.set("apikey", this.settings.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async command<T>(cmd: string, params: Record<string, string | number | undefined> = {}, timeoutMs?: number): Promise<T> {
    const response = await fetchIntegration(this.buildUrl({ cmd, ...params }), {}, timeoutMs);
    if (!response.ok) {
      // Tautulli reports command errors as a 400 whose body carries the reason; keep it
      // so callers can tell those apart.
      const detail = await response.json().then((body: { response?: { message?: string } }) => body?.response?.message, () => undefined);
      throw new TautulliHttpError(`Tautulli ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`, response.status);
    }
    const body = await response.json() as { response?: { result?: string; message?: string; data?: T } };
    if (body.response?.result === "error") throw new Error(body.response.message || "Tautulli API error");
    return body.response?.data as T;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const data = await this.command<{ tautulli_version?: string }>("get_server_info");
      this.logger.info("Tautulli connection test succeeded", { version: data?.tautulli_version ?? null });
      return { ok: true, message: `Connected to Tautulli${data?.tautulli_version ? ` ${data.tautulli_version}` : ""}.` };
    } catch (error) {
      this.logger.warn("Tautulli connection test failed", { error: error instanceof Error ? error.message : String(error) });
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Tautulli's install ID (`pms_uuid`, see tautulliHistoryConnection). Only the PMS
   * settings section is requested, so the notifier credentials elsewhere in Tautulli's
   * settings are never fetched. Null when this Tautulli does not report one.
   */
  async getInstallId(): Promise<string | null> {
    const data = await this.command<{ pms_uuid?: unknown }>("get_settings", { key: "PMS" });
    const installId = typeof data?.pms_uuid === "string" ? data.pms_uuid.trim() : "";
    return installId || null;
  }

  /**
   * The machine identifier of the Plex server this Tautulli reads (`pms_identifier`), from
   * the same PMS settings section as getInstallId. Null when Tautulli does not report one.
   */
  async getPlexServerId(): Promise<string | null> {
    const data = await this.command<{ pms_identifier?: unknown }>("get_settings", { key: "PMS" });
    const serverId = typeof data?.pms_identifier === "string" ? data.pms_identifier.trim() : "";
    return serverId || null;
  }

  /** Throws TautulliMetadataUnavailableError when Tautulli could not read the item from Plex. */
  async getShowGuids(ratingKey: string): Promise<ExternalIds> {
    const metadata = await this.command<any>("get_metadata", { rating_key: ratingKey }).catch((error: unknown) => {
      // Only Tautulli's own command error carries this: a 400, or a 200 with result "error"
      // from older versions. Any other status is a failed request.
      const commandError = !(error instanceof TautulliHttpError) || error.status === 400;
      if (commandError && error instanceof Error && /unable to retrieve metadata/i.test(error.message)) throw new TautulliMetadataUnavailableError(error.message);
      throw error;
    });
    const guids = Array.isArray(metadata?.guids) ? metadata.guids : [];
    let tvdbId: number | null = null;
    let imdbId: string | null = null;
    for (const guid of guids) {
      const value = String(guid ?? "");
      const tvdb = value.match(/(?:tvdb|thetvdb):\/\/(\d+)|tvdb:(\d+)/i);
      if (!tvdbId && tvdb) tvdbId = Number(tvdb[1] ?? tvdb[2]);
      const imdb = value.match(/imdb:\/\/(tt\d+)|imdb:(tt\d+)/i);
      if (!imdbId && imdb) imdbId = imdb[1] ?? imdb[2];
    }
    return { tvdbId, imdbId };
  }

  async getHistory(since?: string): Promise<TautulliHistoryRecord[]> {
    const records: TautulliHistoryRecord[] = [];
    const cutoff = since ? new Date(since).getTime() : null;
    let start = 0;
    const length = 1000;
    for (;;) {
      const data = await this.command<{ data?: any[]; recordsFiltered?: number; total_duration?: string }>("get_history", {
        media_type: "episode",
        start,
        length,
      }, 60_000);
      const rows = data?.data ?? [];
      const pageRecords: TautulliHistoryRecord[] = [];
      for (const row of rows) {
        const seasonNumber = Number(row.parent_media_index ?? row.season ?? 0);
        const episodeNumber = Number(row.media_index ?? row.episode ?? 0);
        const watchedAtUnix = Number(row.date ?? row.started ?? row.stopped ?? 0);
        const watchedAt = new Date(watchedAtUnix * 1000);
        if (
          !Number.isInteger(seasonNumber) || seasonNumber <= 0 ||
          !Number.isInteger(episodeNumber) || episodeNumber <= 0 ||
          !Number.isFinite(watchedAtUnix) || watchedAtUnix <= 0 ||
          !Number.isFinite(watchedAt.getTime())
        ) continue;
        pageRecords.push({
          referenceId: String(row.reference_id ?? row.id ?? `${row.user_id}:${row.rating_key}:${watchedAtUnix}`),
          userId: row.user_id ? String(row.user_id) : null,
          username: row.username === null || row.username === undefined ? null : String(row.username),
          friendlyName: row.user === null || row.user === undefined ? null : String(row.user),
          showTitle: String(row.grandparent_title ?? row.full_title ?? row.title ?? ""),
          seasonNumber,
          episodeNumber,
          watchedAt: watchedAt.toISOString(),
          ratingKey: row.rating_key ? String(row.rating_key) : null,
          grandparentRatingKey: row.grandparent_rating_key ? String(row.grandparent_rating_key) : null,
          raw: row,
        });
      }
      records.push(...pageRecords.filter((record) => cutoff === null || new Date(record.watchedAt).getTime() >= cutoff));
      if (rows.length < length) break;
      if (cutoff !== null && pageRecords.some((record) => new Date(record.watchedAt).getTime() < cutoff)) break;
      start += length;
    }
    this.logger.info("Tautulli history fetched", { records: records.length, since: since ?? null });
    return records;
  }

  async getActiveSessions(): Promise<TautulliActivityRecord[]> {
    const data = await this.command<{ sessions?: any[] }>("get_activity", {}, 60_000);
    const sessions = data?.sessions ?? [];
    const records: TautulliActivityRecord[] = [];
    // get_activity has no playback start time (its updated_at is the media item's
    // metadata timestamp), so the watch is dated when Pacearr observed it, as Plex
    // session polling does.
    const observedAt = new Date();
    for (const row of sessions) {
      if (String(row.media_type ?? row.type ?? "") !== "episode") continue;
      const seasonNumber = Number(row.parent_media_index ?? row.season ?? 0);
      const episodeNumber = Number(row.media_index ?? row.episode ?? 0);
      if (
        !Number.isInteger(seasonNumber) || seasonNumber <= 0 ||
        !Number.isInteger(episodeNumber) || episodeNumber <= 0
      ) continue;
      records.push({
        referenceId: liveSessionEventId({ sessionId: row.session_id, sessionKey: row.session_key, userId: row.user_id, ratingKey: row.rating_key, observedAt }),
        userId: row.user_id ? String(row.user_id) : null,
        username: row.username === null || row.username === undefined ? null : String(row.username),
        friendlyName: row.user === null || row.user === undefined ? null : String(row.user),
        showTitle: String(row.grandparent_title ?? row.full_title ?? row.title ?? ""),
        seasonNumber,
        episodeNumber,
        watchedAt: observedAt.toISOString(),
        ratingKey: row.rating_key ? String(row.rating_key) : null,
        grandparentRatingKey: row.grandparent_rating_key ? String(row.grandparent_rating_key) : null,
        raw: row,
      });
    }
    this.logger.info("Tautulli active sessions fetched", { records: records.length });
    return records;
  }
}
