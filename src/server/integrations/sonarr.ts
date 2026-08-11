import type { ConnectionTestResult, SonarrEpisode, SonarrEpisodeFile, SonarrSeries, SonarrSettings } from "../../shared/types.js";
import type { Logger } from "../logger.js";
import { buildIntegrationUrl, fetchIntegration } from "./request.js";

export class SonarrIntegration {
  constructor(private readonly settings: SonarrSettings, private readonly logger: Logger, private readonly dryRun = true) {}

  private skipMutation(action: string, details: Record<string, unknown>): boolean {
    if (!this.dryRun) return false;
    this.logger.warn("Dry run: skipped Sonarr mutation", { action, ...details });
    return true;
  }

  private buildUrl(pathname: string) {
    return buildIntegrationUrl(this.settings.baseUrl, pathname);
  }

  buildImageUrl(imagePath: string): string {
    if (/^https?:\/\//i.test(imagePath)) return imagePath;
    return this.buildUrl(imagePath).toString();
  }

  getImageRequestHeaders(): Record<string, string> {
    return { "X-Api-Key": this.settings.apiKey };
  }

  getPosterRequestHeaders(series: SonarrSeries): Record<string, string> {
    const poster = series.images?.find((image) => image.coverType === "poster" && (image.remoteUrl || image.url));
    return poster?.remoteUrl ? {} : this.getImageRequestHeaders();
  }

  getPosterUrl(series: SonarrSeries): string | null {
    const poster = series.images?.find((image) => image.coverType === "poster" && (image.remoteUrl || image.url));
    const url = poster?.remoteUrl ?? poster?.url;
    return url ? this.buildImageUrl(url) : null;
  }

  private async request<T>(pathname: string, options: RequestInit = {}): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();
    // This is the final safety boundary. Even if a future caller forgets to use
    // skipMutation(), dry-run mode must never send a write request to Sonarr.
    if (this.dryRun && method !== "GET" && method !== "HEAD") {
      this.logger.warn("Dry run: blocked Sonarr write request", { method, pathname });
      return undefined as T;
    }
    const url = this.buildUrl(`api/v3/${pathname}`);
    const response = await fetchIntegration(url, {
      ...options,
      headers: {
        "X-Api-Key": this.settings.apiKey,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.logger.warn("Sonarr request failed", { method, pathname, status: response.status, statusText: response.statusText });
      throw new Error(`Sonarr ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
    }
    if (response.status === 204) return undefined as T;
    // Sonarr commonly returns HTTP 200 with an empty body for a successful
    // episode-file deletion. Treat that as success instead of parsing it as JSON.
    const body = await response.text();
    return body.trim() ? JSON.parse(body) as T : undefined as T;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const status = await this.request<{ version?: string }>("system/status");
      this.logger.info("Sonarr connection test succeeded", { version: status.version ?? null });
      return { ok: true, message: `Connected to Sonarr${status.version ? ` ${status.version}` : ""}.` };
    } catch (error) {
      this.logger.warn("Sonarr connection test failed", { error: error instanceof Error ? error.message : String(error) });
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async getSeries(): Promise<SonarrSeries[]> {
    return this.request<SonarrSeries[]>("series");
  }

  async getSeriesById(seriesId: number): Promise<SonarrSeries> {
    return this.request<SonarrSeries>(`series/${seriesId}`);
  }

  async getEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
    return this.request<SonarrEpisode[]>(`episode?seriesId=${seriesId}`);
  }

  async getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    return this.request<SonarrEpisodeFile[]>(`episodefile?seriesId=${seriesId}`);
  }

  async updateSeriesMonitoring(seriesId: number, updates: { monitored?: boolean; monitorNewItems?: "all" | "none"; seasons?: SonarrSeries["seasons"] }) {
    if (this.skipMutation("update-series-monitoring", { seriesId, updates })) return;
    const series = await this.getSeriesById(seriesId);
    await this.request<SonarrSeries>(`series/${seriesId}`, {
      method: "PUT",
      body: JSON.stringify({ ...series, ...updates }),
    });
  }

  async updateSeasonMonitoring(seriesId: number, seasonNumber: number, monitored: boolean) {
    if (this.skipMutation("update-season-monitoring", { seriesId, seasonNumber, monitored })) return;
    const series = await this.getSeriesById(seriesId);
    if (!series.seasons) return;
    const seasons = series.seasons.map((season) => season.seasonNumber === seasonNumber ? { ...season, monitored } : season);
    await this.updateSeriesMonitoring(seriesId, { seasons });
  }

  async updateEpisodesMonitoring(episodes: Array<{ id: number; monitored: boolean }>) {
    if (episodes.length === 0) return;
    if (this.skipMutation("update-episodes-monitoring", { episodes })) return;
    const groups = [
      { monitored: true, ids: episodes.filter((episode) => episode.monitored).map((episode) => episode.id) },
      { monitored: false, ids: episodes.filter((episode) => !episode.monitored).map((episode) => episode.id) },
    ];
    for (const group of groups) {
      if (group.ids.length === 0) continue;
      await this.request("episode/monitor", {
        method: "PUT",
        body: JSON.stringify({ episodeIds: group.ids, monitored: group.monitored }),
      });
    }
  }

  async searchEpisodes(episodeIds: number[]) {
    if (episodeIds.length === 0) return;
    if (this.skipMutation("search-episodes", { episodeIds })) return;
    await this.request("command", {
      method: "POST",
      body: JSON.stringify({ name: "EpisodeSearch", episodeIds }),
    });
  }

  async searchSeason(seriesId: number, seasonNumber: number) {
    if (this.skipMutation("search-season", { seriesId, seasonNumber })) return;
    await this.request("command", {
      method: "POST",
      body: JSON.stringify({ name: "SeasonSearch", seriesId, seasonNumber }),
    });
  }

  async searchSeries(seriesId: number) {
    if (this.skipMutation("search-series", { seriesId })) return;
    await this.request("command", {
      method: "POST",
      body: JSON.stringify({ name: "SeriesSearch", seriesId }),
    });
  }

  async deleteEpisodeFiles(episodeFileIds: number[]) {
    if (this.skipMutation("delete-episode-files", { episodeFileIds })) return;
    for (const id of episodeFileIds) {
      try {
        await this.request(`episodefile/${id}`, { method: "DELETE" });
      } catch (error) {
        this.logger.error("Failed to delete Sonarr episode file", { episodeFileId: id, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
  }
}
