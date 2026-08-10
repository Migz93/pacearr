import type { ConnectionTestResult, TautulliSettings } from "../../shared/types.js";
import type { Logger } from "../logger.js";

export interface TautulliHistoryRecord {
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

export class TautulliIntegration {
  constructor(private readonly settings: TautulliSettings, private readonly logger: Logger) {}

  private buildUrl(params: Record<string, string | number | undefined>) {
    const base = this.settings.baseUrl.endsWith("/") ? this.settings.baseUrl : `${this.settings.baseUrl}/`;
    const url = new URL("api/v2", base);
    url.searchParams.set("apikey", this.settings.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async command<T>(cmd: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const response = await fetch(this.buildUrl({ cmd, ...params }));
    if (!response.ok) throw new Error(`Tautulli ${response.status} ${response.statusText}`);
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
      });
      const rows = data?.data ?? [];
      const pageRecords: TautulliHistoryRecord[] = [];
      for (const row of rows) {
        const seasonNumber = Number(row.parent_media_index ?? row.season ?? 0);
        const episodeNumber = Number(row.media_index ?? row.episode ?? 0);
        const watchedAtUnix = Number(row.date ?? row.started ?? row.stopped ?? 0);
        if (!seasonNumber || !episodeNumber || !watchedAtUnix) continue;
        pageRecords.push({
          referenceId: String(row.reference_id ?? row.id ?? `${row.user_id}:${row.rating_key}:${watchedAtUnix}`),
          userId: row.user_id ? String(row.user_id) : null,
          username: row.username ?? null,
          friendlyName: row.user ?? null,
          showTitle: String(row.grandparent_title ?? row.full_title ?? row.title ?? ""),
          seasonNumber,
          episodeNumber,
          watchedAt: new Date(watchedAtUnix * 1000).toISOString(),
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
}
