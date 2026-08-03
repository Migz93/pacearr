import type {
  DashboardResponse,
  RecommendationsResponse,
  RunResult,
  ShowDetailResponse,
  ShowEpisodeSummary,
  ShowListItem,
  ShowRecommendation,
  ShowSeasonSummary,
  ShowUserProgress,
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrLibraryCacheItem,
  RollingShowRecord,
  SonarrSeries,
} from "../shared/types.js";
import pLimit from "p-limit";
import type { PacearrDatabase, NormalizedWatchEventInput } from "./db/index.js";
import { PlexIntegration, type PlexEpisodeActivity } from "./integrations/plex.js";
import { SonarrIntegration } from "./integrations/sonarr.js";
import { TautulliIntegration, type TautulliHistoryRecord } from "./integrations/tautulli.js";
import type { ImageCacheService } from "./image-cache.js";
import type { Logger } from "./logger.js";
import { PlexArtworkService } from "./plex-artwork.js";

function normalizeTitle(title: string) {
  return title.toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function isRealSeasonEpisode(episode: SonarrEpisode) {
  return episode.seasonNumber > 0 && episode.episodeNumber > 0;
}

function realEpisodeId(episodes: SonarrEpisode[], seasonNumber: number, episodeNumber: number): number | undefined {
  return episodes.find((episode) => episode.seasonNumber === seasonNumber && episode.episodeNumber === episodeNumber)?.id;
}

function prefetchedEpisodeIdsForEpisodes(episodes: SonarrEpisode[], records: Array<{ seasonNumber: number; episodeNumber: number }>): number[] {
  return records.map((record) => realEpisodeId(episodes, record.seasonNumber, record.episodeNumber)).filter((id): id is number => id !== undefined);
}

export function selectEarlyPrefetchEpisodes(
  episodes: SonarrEpisode[],
  currentSeasonNumber: number,
  currentEpisodeNumber: number,
  triggerEpisodesRemaining: number,
  episodeCount: number,
): { episodesRemaining: number; nextSeasonNumber: number | null; episodes: SonarrEpisode[] } {
  const realEpisodes = episodes.filter(isRealSeasonEpisode);
  const currentSeasonEpisodes = realEpisodes.filter((episode) => episode.seasonNumber === currentSeasonNumber);
  const episodesRemaining = currentSeasonEpisodes.filter((episode) => episode.episodeNumber > currentEpisodeNumber).length;
  if (episodesRemaining > triggerEpisodesRemaining) return { episodesRemaining, nextSeasonNumber: null, episodes: [] };
  const nextSeasonNumber = [...new Set(realEpisodes.map((episode) => episode.seasonNumber))]
    .filter((seasonNumber) => seasonNumber > currentSeasonNumber)
    .sort((a, b) => a - b)[0] ?? null;
  if (nextSeasonNumber === null) return { episodesRemaining, nextSeasonNumber: null, episodes: [] };
  return {
    episodesRemaining,
    nextSeasonNumber,
    // Episode 1 (the pilot) is excluded, so the upper bound includes its offset.
    episodes: realEpisodes
      .filter((episode) => episode.seasonNumber === nextSeasonNumber && episode.episodeNumber > 1 && episode.episodeNumber <= episodeCount + 1)
      .sort((a, b) => a.episodeNumber - b.episodeNumber),
  };
}

export function calculateRollingPlan(series: SonarrSeries, episodes: SonarrEpisode[], retainedSeasons: number[], deleteFiles: boolean, prefetchedEpisodeIds: number[] = []) {
  const retained = new Set(retainedSeasons);
  const prefetched = new Set(prefetchedEpisodeIds);
  const realEpisodes = episodes.filter(isRealSeasonEpisode);
  const targetMonitored = (episode: SonarrEpisode) => episode.episodeNumber === 1 || retained.has(episode.seasonNumber) || prefetched.has(episode.id);
  const episodesToMonitor = realEpisodes.filter((episode) => targetMonitored(episode) && !episode.monitored);
  const episodesToUnmonitor = realEpisodes.filter((episode) => !targetMonitored(episode) && episode.monitored);
  // Sonarr search commands are only for files that are actually missing. A
  // monitored episode with a file needs no search, including during initial
  // enrolment of an already-complete series.
  const pilotSearches = realEpisodes.filter((episode) =>
    episode.episodeNumber === 1 && !retained.has(episode.seasonNumber) && !episode.hasFile
  );
  const seasonSearches = [...retained]
    .filter((seasonNumber) => realEpisodes.some((episode) => episode.seasonNumber === seasonNumber && !episode.hasFile))
    .sort((a, b) => a - b);

  return {
    retainedSeasons: [...retained].sort((a, b) => a - b),
    seriesMonitoringUpdate: series.monitored !== true || series.monitorNewItems !== "none",
    seasonMonitoringToDisable: (series.seasons ?? []).filter((season) =>
      season.seasonNumber > 0 && !retained.has(season.seasonNumber) && season.monitored
    ),
    seasonMonitoringToEnable: (series.seasons ?? []).filter((season) =>
      season.seasonNumber > 0 && retained.has(season.seasonNumber) && !season.monitored
    ),
    episodesToMonitor,
    episodesToUnmonitor,
    pilotSearches,
    seasonSearches,
    filesToDelete: deleteFiles
      ? realEpisodes.filter((episode) =>
          !targetMonitored(episode) && episode.hasFile && episode.episodeFileId && episode.episodeFileId > 0
        ).map((episode) => episode.episodeFileId!)
      : [],
  };
}

export function getDroppedSeasons(series: SonarrSeries, retainedSeasons: number[]): number[] {
  const retained = new Set(retainedSeasons);
  return (series.seasons ?? [])
    .map((season) => season.seasonNumber)
    .filter((seasonNumber) => seasonNumber > 0 && !retained.has(seasonNumber));
}

export function calculateProjectedSavings(
  series: SonarrSeries,
  episodes: SonarrEpisode[],
  episodeFiles: SonarrEpisodeFile[],
  droppedSeasons: number[]
): number {
  const sizeByFileId = new Map(episodeFiles.map((file) => [file.id, file.size]));
  const episodesBySeason = new Map<number, SonarrEpisode[]>();
  for (const episode of episodes) {
    episodesBySeason.set(episode.seasonNumber, [...(episodesBySeason.get(episode.seasonNumber) ?? []), episode]);
  }

  return droppedSeasons.reduce((sum, seasonNumber) => {
    const seasonSize = series.seasons?.find((season) => season.seasonNumber === seasonNumber)?.statistics?.sizeOnDisk ?? 0;
    // A dropped season still keeps its pilot (episode 1) monitored, so that file's
    // size isn't actually reclaimed — subtract it out of the season's total.
    const pilot = episodesBySeason.get(seasonNumber)?.find((episode) => episode.episodeNumber === 1);
    const pilotSize = pilot?.episodeFileId ? sizeByFileId.get(pilot.episodeFileId) ?? 0 : 0;
    return sum + Math.max(0, seasonSize - pilotSize);
  }, 0);
}

export class PacearrServices {
  private readonly plexArtwork: PlexArtworkService;
  /** Serializes all Sonarr and rolling-state mutations for an individual series. */
  private readonly activeSeriesOperations = new Map<number, number>();
  private nextEnrollmentOperation = 0;

  constructor(private readonly db: PacearrDatabase, private readonly logger: Logger, private readonly imageCache: ImageCacheService, dataDir: string) {
    this.plexArtwork = new PlexArtworkService(db, logger, dataDir);
  }

  private getSonarr() {
    const settings = this.db.getSonarrSettings();
    if (!settings) throw new Error("Sonarr is not configured.");
    return new SonarrIntegration(settings, this.logger, this.db.getAppSettings().dryRun);
  }

  private isDryRun() {
    return this.db.getAppSettings().dryRun;
  }

  private acquireSeriesOperation(seriesId: number): number | null {
    if (this.activeSeriesOperations.has(seriesId)) return null;
    const operation = ++this.nextEnrollmentOperation;
    this.activeSeriesOperations.set(seriesId, operation);
    return operation;
  }

  private releaseSeriesOperation(seriesId: number, operation: number): void {
    if (this.activeSeriesOperations.get(seriesId) === operation) this.activeSeriesOperations.delete(seriesId);
  }

  /** Records only confirmed Sonarr deletions, keeping dry-run projections out of savings totals. */
  private async deleteEpisodeFilesAndRecord(input: {
    sonarr: SonarrIntegration;
    seriesId: number;
    title: string;
    rollingShowId: number | null;
    action: string;
    seasonNumber: number | null;
    fileIds: number[];
  }): Promise<number> {
    if (input.fileIds.length === 0) return 0;
    if (this.isDryRun()) {
      await input.sonarr.deleteEpisodeFiles(input.fileIds);
      return 0;
    }

    const filesById = new Map<number, SonarrEpisodeFile>(
      (await input.sonarr.getEpisodeFiles(input.seriesId)).map((file) => [file.id, file])
    );
    await input.sonarr.deleteEpisodeFiles(input.fileIds);
    const reclaimedBytes = input.fileIds.reduce((total, id) => total + (filesById.get(id)?.size ?? 0), 0);
    this.db.recordStorageReclaim({
      rollingShowId: input.rollingShowId,
      sonarrSeriesId: input.seriesId,
      showTitle: input.title,
      action: input.action,
      seasonNumber: input.seasonNumber,
      fileCount: input.fileIds.length,
      bytesReclaimed: reclaimedBytes,
    });
    this.logger.info("Storage reclaim recorded", { seriesId: input.seriesId, title: input.title, action: input.action, seasonNumber: input.seasonNumber, fileCount: input.fileIds.length, reclaimedBytes });
    return reclaimedBytes;
  }

  private getPlex() {
    const settings = this.db.getPlexSettings();
    if (!settings) throw new Error("Plex is not configured.");
    return new PlexIntegration(settings, this.logger);
  }

  async discoverPlexUsers() {
    const owner = this.db.getPlexOwner();
    if (!owner) throw new Error("Plex owner is not configured.");
    const users = await this.getPlex().getFriendsAndOwner(owner);
    const cachedUsers = await Promise.all(users.map(async (user) => ({
      ...user,
      avatarUrl: await this.imageCache.ensureAvatarCached(user.plexUserId, user.avatarUrl),
    })));
    const storedUsers = this.db.upsertUsers(cachedUsers);
    this.logger.info("Plex users discovered", { users: storedUsers.length });
    const ownerUser = storedUsers.find((user) => user.plexUserId === owner.plexId);
    if (ownerUser) {
      // Plex's server-history endpoint reports the server owner as its local
      // account ID (normally "1"), not the Plex.tv account ID used elsewhere.
      const linkedEvents = this.db.linkUnassignedWatchEventsByPlexAccount(ownerUser.id, "1");
      if (linkedEvents > 0) {
        for (const progress of this.db.listLatestWatchProgressForUser(ownerUser.id)) {
          const rolling = this.db.getRollingShowBySeriesId(progress.sonarrSeriesId);
          if (rolling) this.db.upsertRollingUserProgress(rolling.id, ownerUser.id, progress.seasonNumber, progress.episodeNumber, progress.watchedAt);
        }
        this.logger.info("Linked Plex owner history using server-local account ID", { userId: ownerUser.id, linkedEvents });
      }
    }
    return storedUsers;
  }

  async listUsers() {
    const users = this.db.listUsers();
    await Promise.all(users.map(async (user) => {
      if (!user.avatarUrl || user.avatarUrl.startsWith("/images/")) return;
      const cached = await this.imageCache.ensureAvatarCached(user.plexUserId, user.avatarUrl);
      if (cached) this.db.updateUserAvatarUrl(user.id, cached);
    }));
    return this.db.listUsers();
  }

  listShows(options: { enrolledOnly?: boolean; query?: string } = {}): ShowListItem[] {
    const items = this.db.getSonarrLibraryCache()?.items ?? [];
    const enrolled = new Map(this.db.listRollingShows().map((show) => [show.sonarrSeriesId, show]));
    const query = options.query?.trim().toLowerCase();
    const appSettings = this.db.getAppSettings();
    const cutoff = new Date(Date.now() - appSettings.viewerActivityWindowDays * 24 * 60 * 60 * 1000).toISOString();
    const matched = items.filter(({ series }) =>
      (!options.enrolledOnly || enrolled.has(series.id)) &&
      (!query || series.title.toLowerCase().includes(query))
    ).sort((a, b) => a.series.title.localeCompare(b.series.title));
    const progressBySeries = this.db.listLatestUserProgressForSeriesBatch(matched.map(({ series }) => series.id), cutoff);
    return matched.map(({ series, posterUrl }) => {
      const progress = (progressBySeries.get(series.id) ?? []).filter((item) => item.enabled);
      return this.buildCachedShowListItem(series, enrolled.get(series.id) ?? null, posterUrl, progress);
    });
  }

  async refreshSonarrLibrary(): Promise<void> {
    const sonarr = this.getSonarr();
    const series = await sonarr.getSeries();
    const limit = pLimit(5);
    const items: SonarrLibraryCacheItem[] = await Promise.all(series.map((item) => limit(async () => ({
      series: item,
      posterUrl: await this.imageCache.ensureSonarrPosterCached(
        item.id,
        sonarr.getPosterUrl(item),
        sonarr.getPosterRequestHeaders(item)
      ),
    }))));
    const generatedAt = this.db.saveSonarrLibraryCache(items);
    this.logger.info("Sonarr library cache refreshed", { shows: items.length, generatedAt });
  }

  private buildCachedShowListItem(
    series: SonarrSeries,
    rolling: ReturnType<PacearrDatabase["getRollingShowBySeriesId"]>,
    posterUrl: string | null,
    watchers: ShowUserProgress[] = []
  ): ShowListItem {
    return {
      sonarrSeriesId: series.id,
      title: series.title,
      year: series.year ?? null,
      tvdbId: series.tvdbId ?? null,
      imdbId: series.imdbId ?? null,
      enrolled: Boolean(rolling),
      rollingShowId: rolling?.id ?? null,
      expandedSeasons: rolling?.expandedSeasons ?? [],
      lastActivityAt: rolling?.lastActivityAt ?? null,
      posterUrl,
      status: series.status ?? null,
      seasonCount: series.seasons?.filter((season) => season.seasonNumber > 0).length ?? 0,
      episodeCount: series.seasons?.reduce((sum, season) => sum + (season.statistics?.episodeCount ?? 0), 0) ?? 0,
      sizeOnDiskBytes: series.statistics?.sizeOnDisk ?? 0,
      watcherCount: new Set(watchers.map((item) => item.userId)).size,
      watchers,
    };
  }

  async getShowDetail(seriesId: number): Promise<ShowDetailResponse> {
    const sonarr = this.getSonarr();
    const rolling = this.db.getRollingShowBySeriesId(seriesId);
    const [series, episodes] = await Promise.all([
      sonarr.getSeriesById(seriesId),
      sonarr.getEpisodes(seriesId),
    ]);
    const watchStats = this.db.listWatchStatsForSeries(series.id);
    const seasonWatchStats = this.db.listSeasonWatchStatsForSeries(series.id);
    const statsByEpisode = new Map(watchStats.map((stat) => [`${stat.seasonNumber}:${stat.episodeNumber}`, stat]));
    const statsBySeason = new Map(seasonWatchStats.map((stat) => [stat.seasonNumber, stat]));
    const appSettings = this.db.getAppSettings();
    const cutoff = new Date(Date.now() - appSettings.viewerActivityWindowDays * 24 * 60 * 60 * 1000).toISOString();
    const progress = this.db.listLatestUserProgressForSeries(series.id, cutoff);
    const currentUserIds = new Set(progress.map((item) => item.userId));
    const historyProgress = this.db.listLatestUserProgressForSeries(series.id).filter((item) => !currentUserIds.has(item.userId));

    const realEpisodes = episodes.filter(isRealSeasonEpisode);
    const episodesBySeason = new Map<number, SonarrEpisode[]>();
    for (const episode of realEpisodes) {
      episodesBySeason.set(episode.seasonNumber, [...(episodesBySeason.get(episode.seasonNumber) ?? []), episode]);
    }

    const retainedSeasons = [...new Set(progress.filter((item) => item.enabled).map((item) => item.seasonNumber))]
      .filter((seasonNumber) => seasonNumber > 0);
    const episodeKeys = new Set(realEpisodes.map((episode) => `${episode.seasonNumber}:${episode.episodeNumber}`));
    const prefetchedWithUsers = rolling ? this.db.listPrefetchedEpisodesWithUsers(rolling.id)
      .filter((item) => episodeKeys.has(`${item.seasonNumber}:${item.episodeNumber}`)) : [];
    const prefetchedEpisodeIds = prefetchedEpisodeIdsForEpisodes(episodes, prefetchedWithUsers);
    const prefetchedIds = new Set(prefetchedEpisodeIds);
    const plan = calculateRollingPlan(series, episodes, retainedSeasons, appSettings.cleanupDeletesFiles, prefetchedEpisodeIds);
    const retained = new Set(plan.retainedSeasons);

    const seasons: ShowSeasonSummary[] = (series.seasons ?? [])
      .filter((season) => season.seasonNumber > 0)
      .sort((a, b) => a.seasonNumber - b.seasonNumber)
      .map((season) => {
        const seasonStats = statsBySeason.get(season.seasonNumber);
        const seasonEpisodes = episodesBySeason.get(season.seasonNumber) ?? [];
        return {
          seasonNumber: season.seasonNumber,
          monitored: season.monitored,
          targetMonitored: retained.has(season.seasonNumber),
          episodeCount: season.statistics?.episodeCount ?? seasonEpisodes.length,
          totalEpisodeCount: season.statistics?.totalEpisodeCount ?? seasonEpisodes.length,
          watchedUsers: seasonStats?.watchedUsers ?? 0,
          latestWatchedAt: seasonStats?.latestWatchedAt ?? null,
          isExpanded: rolling?.expandedSeasons.includes(season.seasonNumber) ?? false,
          prefetchedEpisodes: rolling ? prefetchedWithUsers
            .filter((item) => item.seasonNumber === season.seasonNumber)
            .map((item) => ({ seasonNumber: item.seasonNumber, episodeNumber: item.episodeNumber, userId: item.userId, displayName: item.displayName, avatarUrl: item.avatarUrl, triggeredAt: item.triggeredAt })) : [],
        };
      });

    const episodeSummaries: ShowEpisodeSummary[] = realEpisodes
      .slice()
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
      .map((episode) => {
        const stats = statsByEpisode.get(`${episode.seasonNumber}:${episode.episodeNumber}`);
        return {
          id: episode.id,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          title: episode.title ?? null,
          airDate: episode.airDate ?? episode.airDateUtc ?? null,
          monitored: episode.monitored,
          targetMonitored: episode.episodeNumber === 1 || retained.has(episode.seasonNumber) || prefetchedIds.has(episode.id),
          hasFile: Boolean(episode.hasFile),
          watchedUsers: stats?.watchedUsers ?? 0,
          latestWatchedAt: stats?.latestWatchedAt ?? null,
        };
      });

    const enabledProgress = progress.filter((item) => item.enabled);
    const recommendation = rolling ? null : await (async () => {
      const droppedSeasons = getDroppedSeasons(series, plan.retainedSeasons);
      const ignored = this.db.listIgnoredRecommendationIds().includes(series.id);
      const sizeOnDiskBytes = series.statistics?.sizeOnDisk ?? 0;
      // Mirrors refreshRecommendations: only pay for the episode-files fetch when there's
      // actually something that could be dropped, instead of on every detail-page load.
      if (droppedSeasons.length === 0) {
        return { sizeOnDiskBytes, projectedSavingsBytes: 0, ignored, eligible: false };
      }
      const episodeFiles = await sonarr.getEpisodeFiles(seriesId);
      const projectedSavingsBytes = calculateProjectedSavings(series, episodes, episodeFiles, droppedSeasons);
      // Mirrors listRecommendations' eligibility rule — a show only appears (and can be
      // ignored/restored) on the Recommendations/Ignored tabs if it has seasons to drop
      // and clears the configured minimum savings threshold. Gates the Ignore control so
      // it can't persist an ignore record for a show that could never appear there.
      const minimumSavingsBytes = appSettings.recommendationMinimumSavingsGb * 1024 ** 3;
      const eligible = projectedSavingsBytes >= minimumSavingsBytes;
      return { sizeOnDiskBytes, projectedSavingsBytes, ignored, eligible };
    })();

    return {
      show: await this.buildShowListItem(series, rolling, sonarr, enabledProgress),
      seasons,
      episodes: episodeSummaries,
      progress,
      historyProgress,
      dryRunPreview: {
        enabled: appSettings.dryRun,
      },
      recommendation,
    };
  }

  listRecommendations(includeIgnored = false, refreshing = false): RecommendationsResponse {
    const appSettings = this.db.getAppSettings();
    const ignoredIds = new Set(this.db.listIgnoredRecommendationIds());
    const cache = this.db.getRecommendationCache();
    const minimumSavingsBytes = appSettings.recommendationMinimumSavingsGb * 1024 ** 3;
    const recommendations = (cache?.candidates ?? [])
      .filter((candidate) => candidate.projectedSavingsBytes >= minimumSavingsBytes)
      .filter((candidate) => includeIgnored || !ignoredIds.has(candidate.sonarrSeriesId))
      .map((candidate) => ({ ...candidate, ignored: ignoredIds.has(candidate.sonarrSeriesId) }));

    return {
      candidates: recommendations,
      ignoredCount: ignoredIds.size,
      generatedAt: cache?.generatedAt ?? null,
      refreshing,
      cleanupDeletesFilesEnabled: appSettings.cleanupDeletesFiles,
      viewerActivityWindowDays: appSettings.viewerActivityWindowDays,
    };
  }

  async refreshRecommendations(): Promise<void> {
    this.logger.info("Recommendation refresh started");
    const sonarr = this.getSonarr();
    const appSettings = this.db.getAppSettings();
    const cutoff = new Date(Date.now() - appSettings.viewerActivityWindowDays * 24 * 60 * 60 * 1000).toISOString();

    const allSeries = this.db.getSonarrLibraryCache()?.items.map((item) => item.series) ?? await sonarr.getSeries();
    const enrolledIds = new Set(this.db.listRollingShows().map((show) => show.sonarrSeriesId));
    const ignoredIds = new Set(this.db.listIgnoredRecommendationIds());
    const candidates = allSeries.filter((series) => !enrolledIds.has(series.id));

    // Each candidate needs 2 extra Sonarr requests (episodes + episode files);
    // bound concurrency so a large un-enrolled library doesn't fire hundreds of
    // simultaneous requests at Sonarr on one page load.
    const limit = pLimit(5);
    const built = await Promise.all(candidates.map((series) => limit(async () => {
      try {
        const progress = this.db.listLatestUserProgressForSeries(series.id, cutoff);
        const enabledProgress = progress.filter((item) => item.enabled);
        const retainedSeasons = [...new Set(enabledProgress.map((item) => item.seasonNumber))].filter((seasonNumber) => seasonNumber > 0);

        const episodes = await sonarr.getEpisodes(series.id);
        const plan = calculateRollingPlan(series, episodes, retainedSeasons, true);
        const droppedSeasons = getDroppedSeasons(series, plan.retainedSeasons);
        if (droppedSeasons.length === 0) return { recommendation: null, skipped: false };

        const episodeFiles = await sonarr.getEpisodeFiles(series.id);
        const projectedSavingsBytes = calculateProjectedSavings(series, episodes, episodeFiles, droppedSeasons);

        const show = await this.buildShowListItem(series, null, sonarr);
        const recommendation: ShowRecommendation = {
          sonarrSeriesId: series.id,
          title: show.title,
          year: show.year,
          posterUrl: show.posterUrl,
          status: show.status,
          seasonCount: show.seasonCount,
          episodeCount: show.episodeCount,
          sizeOnDiskBytes: series.statistics?.sizeOnDisk ?? 0,
          retainedSeasons: plan.retainedSeasons,
          droppedSeasons,
          watcherCount: new Set(enabledProgress.map((item) => item.userId)).size,
          watchers: enabledProgress,
          projectedSavingsBytes,
          ignored: ignoredIds.has(series.id),
        };
        return { recommendation, skipped: false };
      } catch (error) {
        // One stale or unavailable Sonarr record must not hide recommendations for
        // every other show in a large library.
        this.logger.warn("Skipped show during recommendation refresh", {
          seriesId: series.id,
          title: series.title,
          error: error instanceof Error ? error.message : String(error),
        });
        return { recommendation: null, skipped: true };
      }
    })));

    const skippedCount = built.filter((item) => item.skipped).length;
    if (candidates.length > 0 && skippedCount === candidates.length) {
      this.logger.error("Recommendation refresh failed for every candidate; keeping previous cache", {
        attempted: candidates.length,
        skipped: skippedCount,
      });
      return;
    }

    const recommendations = built
      .map((item) => item.recommendation)
      .filter((item): item is ShowRecommendation => item !== null)
      .sort((a, b) => b.projectedSavingsBytes - a.projectedSavingsBytes);

    const generatedAt = this.db.saveRecommendationCache(recommendations);
    this.logger.info("Recommendation cache refreshed", {
      attempted: candidates.length,
      saved: recommendations.length,
      skipped: skippedCount,
      generatedAt,
    });
  }

  ignoreRecommendation(seriesId: number, title: string): void {
    this.db.ignoreRecommendation(seriesId, title);
    this.db.addHistory("info", "recommendation.ignored", title, { seriesId });
    this.logger.info("Recommendation ignored", { seriesId, title });
  }

  unignoreRecommendation(seriesId: number): void {
    this.db.unignoreRecommendation(seriesId);
    this.logger.info("Recommendation restored", { seriesId });
  }

  async beginEnrollment(seriesId: number, options: { applyBaseline: boolean; importHistory: boolean }) {
    const operation = this.acquireSeriesOperation(seriesId);
    if (operation === null) throw new Error("Another operation is already running for this show.");
    try {
      const sonarr = this.getSonarr();
      const series = await sonarr.getSeriesById(seriesId);
      const rolling = this.db.upsertRollingShow(series);
      this.logger.info("Show enrolled in Pacearr control", { seriesId, title: rolling.title, applyBaseline: options.applyBaseline, importHistory: options.importHistory });
      this.db.removeRecommendationFromCache(seriesId);
      this.db.addHistory("info", "show.enrolled", series.title, { seriesId });

      return { series, rolling, operation };
    } catch (error) {
      this.releaseSeriesOperation(seriesId, operation);
      throw error;
    }
  }

  async completeEnrollment(series: SonarrSeries, rolling: RollingShowRecord, operation: number, options: { applyBaseline: boolean; importHistory: boolean }): Promise<RunResult> {
    try {
      let changed = this.reconcileStoredWatchEvents(series, rolling.id);
      this.seedRollingProgressFromWatchHistory(series.id, rolling.id);
      if (options.importHistory) {
        const result = await this.importHistory();
        changed += result.changed ?? 0;
      }
      if (options.applyBaseline) {
        changed += await this.applyActiveViewerPlan(series.id, "enroll");
      }
      await this.syncPlexArtwork(series, rolling, this.getActiveRetainedSeasons(rolling.id));
      return { ok: true, message: `Enrolled ${rolling.title}.`, changed };
    } finally {
      this.releaseSeriesOperation(series.id, operation);
    }
  }

  async enrollShow(seriesId: number, options: { applyBaseline: boolean; importHistory: boolean }): Promise<RunResult> {
    const { series, rolling, operation } = await this.beginEnrollment(seriesId, options);
    return this.completeEnrollment(series, rolling, operation, options);
  }

  private reconcileStoredWatchEvents(series: SonarrSeries, rollingShowId: number): number {
    const matched = this.db.listUnmatchedWatchEvents().filter((event) => normalizeTitle(event.showTitle) === normalizeTitle(series.title));
    for (const event of matched) {
      this.db.assignWatchEventToSeries(event.id, series.id);
      if (event.userId && this.db.getUser(event.userId)?.enabled) {
        this.db.upsertRollingUserProgress(rollingShowId, event.userId, event.seasonNumber, event.episodeNumber, event.watchedAt);
      }
    }
    if (matched.length > 0) {
      this.db.addHistory("info", "watch_events.reconciled", series.title, { seriesId: series.id, matchedEvents: matched.length });
      this.logger.info("Reconciled previously unmatched watch events for enrolled show", { seriesId: series.id, matchedEvents: matched.length });
    }
    return matched.length;
  }

  private reconcileAllUnmatchedWatchEvents(series: SonarrSeries[]): number {
    const unmatched = this.db.listUnmatchedWatchEvents();
    if (unmatched.length === 0) return 0;
    const byTitle = new Map(series.map((candidate) => [normalizeTitle(candidate.title), candidate]));
    let matchedCount = 0;
    for (const event of unmatched) {
      const match = byTitle.get(normalizeTitle(event.showTitle));
      if (!match) continue;
      this.db.assignWatchEventToSeries(event.id, match.id);
      matchedCount++;
      const rolling = this.db.getRollingShowBySeriesId(match.id);
      if (rolling && event.userId && this.db.getUser(event.userId)?.enabled) {
        this.db.upsertRollingUserProgress(rolling.id, event.userId, event.seasonNumber, event.episodeNumber, event.watchedAt);
      }
    }
    if (matchedCount > 0) {
      this.db.addHistory("info", "watch_events.reconciled", "Watch event reconciliation", { matchedEvents: matchedCount });
      this.logger.info("Reconciled previously unmatched watch events against full Sonarr series list", { matchedEvents: matchedCount });
    }
    return matchedCount;
  }

  // With watch-event matching now universal (see matchSeries), a show's history
  // is often already matched to its sonarr_series_id before it's ever enrolled,
  // so reconcileStoredWatchEvents finds nothing left to match. Seed rolling
  // progress directly from existing history so active-viewer expansion has data
  // to work with immediately, regardless of when the matching happened.
  private seedRollingProgressFromWatchHistory(seriesId: number, rollingShowId: number): number {
    let seeded = 0;
    for (const item of this.db.listLatestUserProgressForSeries(seriesId)) {
      if (!item.enabled) continue;
      this.db.upsertRollingUserProgress(rollingShowId, item.userId, item.seasonNumber, item.episodeNumber, item.watchedAt);
      seeded++;
    }
    return seeded;
  }

  async removeShow(rollingShowId: number): Promise<RunResult> {
    const show = this.db.getRollingShow(rollingShowId);
    if (!show) return { ok: false, message: "Show is not enrolled." };
    const operation = this.acquireSeriesOperation(show.sonarrSeriesId);
    if (operation === null) return { ok: false, message: `Another operation for ${show.title} is still running. Try again once it finishes.` };
    try {
      if (this.isDryRun()) {
        this.logger.warn("Dry run: skipped rolling-show unenrolment because Plex artwork and Sonarr monitoring would need restoring", { rollingShowId, seriesId: show.sonarrSeriesId, title: show.title });
        return { ok: true, message: `Dry run: would restore artwork and re-monitor ${show.title} before unenrolling.`, changed: 0 };
      }
      const artwork = this.db.listPlexArtwork(rollingShowId);
      if (artwork.length > 0) await this.plexArtwork.restoreAll(this.getPlex(), rollingShowId);
      const changed = await this.restoreSonarrMonitoring(show.sonarrSeriesId);
      this.db.deleteRollingShow(rollingShowId);
      this.plexArtwork.removeBackups(artwork);
      this.db.addHistory("info", "show.unenrolled", show.title, { rollingShowId });
      this.logger.info("Show unenrolled from Pacearr control", { rollingShowId, seriesId: show.sonarrSeriesId, title: show.title, remonitored: changed, artworkRestored: artwork.length });
      return { ok: true, message: `Unenrolled ${show.title}; all episodes and seasons are monitored again.`, changed };
    } finally { this.releaseSeriesOperation(show.sonarrSeriesId, operation); }
  }

  private async restoreSonarrMonitoring(seriesId: number): Promise<number> {
    const sonarr = this.getSonarr();
    const series = await sonarr.getSeriesById(seriesId);
    const realSeasons = (series.seasons ?? []).filter((season) => season.seasonNumber > 0);
    await sonarr.updateSeriesMonitoring(seriesId, { monitored: true, monitorNewItems: "all", seasons: (series.seasons ?? []).map((season) => season.seasonNumber > 0 ? { ...season, monitored: true } : season) });
    const episodes = await sonarr.getEpisodes(seriesId);
    const updates = episodes.filter(isRealSeasonEpisode).filter((episode) => !episode.monitored).map((episode) => ({ id: episode.id, monitored: true }));
    await sonarr.updateEpisodesMonitoring(updates);
    this.logger.info("Sonarr monitoring restored after Pacearr unenrolment", { seriesId, title: series.title, seasons: realSeasons.length, episodesUpdated: updates.length });
    return realSeasons.length + updates.length + 1;
  }

  private async syncPlexArtwork(series: SonarrSeries, rolling: RollingShowRecord, retainedSeasons: number[]): Promise<void> {
    const settings = this.db.getAppSettings();
    if (settings.dryRun || !settings.artworkEnabled) return;
    try {
      await this.plexArtwork.syncShow(this.getPlex(), rolling, series, retainedSeasons);
    } catch (error) {
      this.logger.warn("Plex artwork synchronization failed", { seriesId: series.id, title: series.title, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async resetShow(rollingShowId: number): Promise<RunResult> {
    const show = this.db.getRollingShow(rollingShowId);
    if (!show) return { ok: false, message: "Show is not enrolled." };
    const operation = this.acquireSeriesOperation(show.sonarrSeriesId);
    if (operation === null) return { ok: false, message: `Another operation for ${show.title} is still running. Try again once it finishes.` };
    try {
      const dryRun = this.isDryRun();
      const excludedPrefetchedSeasons = dryRun
        ? [...new Set(this.db.listPrefetchedEpisodes(rollingShowId).map((episode) => episode.seasonNumber))]
        : [];
      // Remove partial prefetch targets before calculating the pilot-only reset
      // plan, otherwise reconciliation deliberately protects them as desired state.
      if (!dryRun) this.db.clearPrefetchedEpisodes(rollingShowId);
      const changed = await this.applyAllSeasonPilotBaseline(show.sonarrSeriesId, "reset", excludedPrefetchedSeasons);
      if (!dryRun) this.db.resetExpandedSeasons(rollingShowId);
      this.db.addHistory("info", dryRun ? "dry_run.show.reset" : "show.reset", show.title, { changed, dryRun });
      this.logger.info("Show reset to pilot baseline", { rollingShowId, seriesId: show.sonarrSeriesId, title: show.title, changed, dryRun });
      return { ok: true, message: dryRun ? `Dry run: would reset ${show.title} to all-season pilots.` : `Reset ${show.title} to all-season pilots.`, changed };
    } finally { this.releaseSeriesOperation(show.sonarrSeriesId, operation); }
  }

  async applyAllSeasonPilotBaseline(seriesId: number, reason: string, excludedPrefetchedSeasons: number[] = []): Promise<number> {
    return this.applyMonitoringPlan(seriesId, reason, [], true, excludedPrefetchedSeasons);
  }

  private getActiveRetainedSeasons(rollingShowId: number): number[] {
    const settings = this.db.getAppSettings();
    const cutoff = Date.now() - settings.viewerActivityWindowDays * 24 * 60 * 60 * 1000;
    return [...new Set(this.db.listProgressForShow(rollingShowId)
      .filter((progress) =>
        progress.lastWatchedSeason > 0 &&
        this.db.getUser(progress.userId)?.enabled &&
        new Date(progress.lastWatchedAt).getTime() >= cutoff
      )
      .map((progress) => progress.lastWatchedSeason))]
      .sort((a, b) => a - b);
  }

  /**
   * Returns the seasons that must remain expanded while recording when older
   * seasons first became inactive. A season with no recorded active viewer is
   * deliberately timed from this first evaluation; we cannot safely infer a
   * prior transition for legacy enrolments that predate this tracking.
   */
  private getCleanupRetention(rolling: RollingShowRecord, inactiveSince = new Date()): { retainedSeasons: number[]; eligibleForCleanup: number[] } {
    const settings = this.db.getAppSettings();
    const cutoff = Date.now() - settings.viewerActivityWindowDays * 24 * 60 * 60 * 1000;
    const activeProgress = this.db.listProgressForShow(rolling.id).filter((progress) =>
      progress.lastWatchedSeason > 0 &&
      this.db.getUser(progress.userId)?.enabled &&
      new Date(progress.lastWatchedAt).getTime() >= cutoff
    );
    const retained = new Set(this.getActiveRetainedSeasons(rolling.id));
    const eligibleForCleanup: number[] = [];
    const delayMs = settings.progressiveCleanupDelayDays * 24 * 60 * 60 * 1000;

    for (const seasonNumber of rolling.expandedSeasons) {
      // A viewer who has not yet progressed beyond this season still needs it,
      // even when their current season is earlier than the candidate season.
      const hasActiveViewer = activeProgress.some((progress) => progress.lastWatchedSeason <= seasonNumber);
      if (hasActiveViewer) {
        if (this.db.getSeasonInactiveSince(rolling.id, seasonNumber)) {
          this.db.clearSeasonInactivity(rolling.id, seasonNumber);
          this.logger.info("Expanded season inactivity timer cleared by returning viewer", {
            rollingShowId: rolling.id,
            seriesId: rolling.sonarrSeriesId,
            title: rolling.title,
            seasonNumber,
          });
        }
        retained.add(seasonNumber);
        continue;
      }

      const recordedInactiveSince = this.db.getSeasonInactiveSince(rolling.id, seasonNumber);
      const startedAt = recordedInactiveSince ?? inactiveSince.toISOString();
      if (!recordedInactiveSince) {
        this.db.markSeasonInactive(rolling.id, seasonNumber, startedAt);
        this.logger.info("Expanded season became inactive", { rollingShowId: rolling.id, seriesId: rolling.sonarrSeriesId, title: rolling.title, seasonNumber, inactiveSince: startedAt, cleanupDelayDays: settings.progressiveCleanupDelayDays });
      }
      if (!settings.progressiveCleanupEnabled || inactiveSince.getTime() - new Date(startedAt).getTime() < delayMs) {
        retained.add(seasonNumber);
      } else {
        eligibleForCleanup.push(seasonNumber);
      }
    }
    return { retainedSeasons: [...retained].sort((a, b) => a - b), eligibleForCleanup };
  }

  private async applyActiveViewerPlan(seriesId: number, reason: string): Promise<number> {
    const rolling = this.db.getRollingShowBySeriesId(seriesId);
    return this.applyMonitoringPlan(seriesId, reason, rolling ? this.getActiveRetainedSeasons(rolling.id) : []);
  }

  private async applyMonitoringPlan(seriesId: number, reason: string, retainedSeasons: number[], searchAllPilots = true, excludedPrefetchedSeasons: number[] = []): Promise<number> {
    const sonarr = this.getSonarr();
    const series = await sonarr.getSeriesById(seriesId);
    const episodes = await sonarr.getEpisodes(seriesId);
    const settings = this.db.getAppSettings();
    const rolling = this.db.getRollingShowBySeriesId(seriesId);
    const excludedPrefetched = new Set(excludedPrefetchedSeasons);
    const prefetchedEpisodeIds = rolling ? prefetchedEpisodeIdsForEpisodes(episodes, this.db.listPrefetchedEpisodes(rolling.id)
      .filter((prefetched) => !excludedPrefetched.has(prefetched.seasonNumber))) : [];
    const prefetchedIds = new Set(prefetchedEpisodeIds);
    const plan = calculateRollingPlan(series, episodes, retainedSeasons, settings.cleanupDeletesFiles, prefetchedEpisodeIds);
    this.logger.info("Applying Sonarr monitoring plan", { seriesId, title: series.title, reason, retainedSeasons: plan.retainedSeasons, dryRun: settings.dryRun, episodeUpdates: plan.episodesToMonitor.length + plan.episodesToUnmonitor.length, filesToDelete: plan.filesToDelete.length });

    if (plan.seriesMonitoringUpdate) {
      await sonarr.updateSeriesMonitoring(seriesId, { monitored: true, monitorNewItems: "none" });
    }
    for (const season of plan.seasonMonitoringToDisable) {
      await sonarr.updateSeasonMonitoring(seriesId, season.seasonNumber, false);
    }
    for (const season of plan.seasonMonitoringToEnable) {
      await sonarr.updateSeasonMonitoring(seriesId, season.seasonNumber, true);
    }

    const seasonsWithMonitoringChanges = new Set([
      ...plan.seasonMonitoringToDisable.map((season) => season.seasonNumber),
      ...plan.seasonMonitoringToEnable.map((season) => season.seasonNumber),
    ]);
    const updates = [
      ...plan.episodesToMonitor.map((episode) => ({ id: episode.id, monitored: true })),
      ...plan.episodesToUnmonitor.map((episode) => ({ id: episode.id, monitored: false })),
      // Sonarr changes a season's child episode flags when that season-level
      // flag changes. Reassert the target state afterwards so E01 is kept.
      ...episodes
        .filter((episode) => isRealSeasonEpisode(episode) && seasonsWithMonitoringChanges.has(episode.seasonNumber))
        .map((episode) => ({ id: episode.id, monitored: episode.episodeNumber === 1 || plan.retainedSeasons.includes(episode.seasonNumber) || prefetchedIds.has(episode.id) })),
    ].reduce<Array<{ id: number; monitored: boolean }>>((deduplicated, update) => {
      const index = deduplicated.findIndex((item) => item.id === update.id);
      if (index === -1) deduplicated.push(update);
      else deduplicated[index] = update;
      return deduplicated;
    }, []);
    if (updates.length > 0) await sonarr.updateEpisodesMonitoring(updates);

    const reclaimedBytes = await this.deleteEpisodeFilesAndRecord({
      sonarr,
      seriesId,
      title: series.title,
      rollingShowId: rolling?.id ?? null,
      action: "sonarr.baseline",
      seasonNumber: null,
      fileIds: plan.filesToDelete,
    });

    const cleanupEpisodes = plan.filesToDelete.map((fileId) => {
      const episode = episodes.find((item) => item.episodeFileId === fileId);
      return episode ? { seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber } : null;
    }).filter((episode): episode is { seasonNumber: number; episodeNumber: number } => episode !== null);
    if (reason === "scheduled-reconcile" && cleanupEpisodes.length > 0) {
      this.logger.info("Scheduled reconciliation repairing inactive season episodes", { seriesId, title: series.title, cleanupEpisodes, dryRun: settings.dryRun });
    }

    if (searchAllPilots) await sonarr.searchEpisodes(plan.pilotSearches.map((episode) => episode.id));
    // Reconciliation does not repeatedly search healthy pilots. It only starts
    // a season search when new viewer progress made that season required.
    const seasonSearches = searchAllPilots
      ? plan.seasonSearches
      : plan.seasonSearches.filter((seasonNumber) =>
        plan.seasonMonitoringToEnable.some((season) => season.seasonNumber === seasonNumber) ||
        plan.episodesToMonitor.some((episode) => episode.seasonNumber === seasonNumber)
      );
    for (const seasonNumber of seasonSearches) {
      await sonarr.searchSeason(seriesId, seasonNumber);
    }
    const dryRun = this.isDryRun();
    this.db.addHistory("info", dryRun ? "dry_run.sonarr.baseline" : "sonarr.baseline", series.title, {
      reason,
      dryRun,
      retainedSeasons: plan.retainedSeasons,
      pilotSearches: searchAllPilots ? plan.pilotSearches.length : 0,
      seasonSearches: seasonSearches.length,
      monitored: plan.episodesToMonitor.length,
      unmonitored: plan.episodesToUnmonitor.length,
      deletedFiles: plan.filesToDelete.length,
      reclaimedBytes,
      cleanupEpisodes,
    });
    if (!dryRun && rolling) this.db.replaceExpandedSeasons(rolling.id, plan.retainedSeasons);
    if (rolling) await this.syncPlexArtwork(series, rolling, plan.retainedSeasons);
    this.logger.info("Sonarr monitoring plan complete", { seriesId, title: series.title, reason, dryRun, changed: updates.length + plan.filesToDelete.length });
    return updates.length + plan.filesToDelete.length;
  }

  async expandSeason(seriesId: number, seasonNumber: number, watchedAt: string, source: string): Promise<boolean> {
    const rolling = this.db.getRollingShowBySeriesId(seriesId);
    if (!rolling) return false;
    if (rolling.expandedSeasons.includes(seasonNumber)) {
      this.db.clearPrefetchedEpisodesForSeason(rolling.id, seasonNumber);
      return false;
    }
    const sonarr = this.getSonarr();
    const episodes = (await sonarr.getEpisodes(seriesId)).filter((episode) => episode.seasonNumber === seasonNumber);
    const updates = episodes.filter((episode) => !episode.monitored).map((episode) => ({ id: episode.id, monitored: true }));
    await sonarr.updateSeasonMonitoring(seriesId, seasonNumber, true);
    await sonarr.updateEpisodesMonitoring(updates);
    if (episodes.some((episode) => isRealSeasonEpisode(episode) && !episode.hasFile)) {
      await sonarr.searchSeason(seriesId, seasonNumber);
    }
    const dryRun = this.isDryRun();
    if (!dryRun) this.db.markSeasonExpanded(rolling.id, seasonNumber, watchedAt);
    await this.syncPlexArtwork(await sonarr.getSeriesById(seriesId), rolling, [...rolling.expandedSeasons, seasonNumber]);
    this.db.addHistory("info", dryRun ? "dry_run.sonarr.expand_season" : "sonarr.expand_season", rolling.title, { seasonNumber, source, monitoredEpisodes: updates.length, dryRun });
    this.logger.info("Season expanded from watch activity", { seriesId, title: rolling.title, seasonNumber, source, monitoredEpisodes: updates.length, dryRun });
    return true;
  }

  private async matchSeries(
    event: Pick<PlexEpisodeActivity, "showTitle" | "grandparentRatingKey"> & { tvdbId?: number | null; imdbId?: string | null },
    series: SonarrSeries[],
    plex?: PlexIntegration
  ): Promise<SonarrSeries | null> {
    const candidates = series;
    const normalized = normalizeTitle(event.showTitle);
    // Most history rows can be matched from the show title. Do this before a
    // Plex metadata lookup: a full history import otherwise makes one network
    // request per episode for shows Pacearr does not control.
    const titleMatch = candidates.find((candidate) => normalizeTitle(candidate.title) === normalized);
    if (titleMatch) return titleMatch;
    if (candidates.length === 0) return null;
    let ids = { tvdbId: event.tvdbId ?? null, imdbId: event.imdbId ?? null };
    if (!ids.tvdbId && !ids.imdbId && event.grandparentRatingKey && plex) {
      try {
        ids = await plex.getShowGuids(event.grandparentRatingKey);
      } catch (error) {
        this.logger.debug("Could not fetch Plex show GUIDs for matching", { showTitle: event.showTitle, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (ids.tvdbId) {
      const match = candidates.find((candidate) => candidate.tvdbId === ids.tvdbId);
      if (match) return match;
    }
    if (ids.imdbId) {
      const match = candidates.find((candidate) => candidate.imdbId === ids.imdbId);
      if (match) return match;
    }
    return null;
  }

  private async prefetchNextSeason(input: NormalizedWatchEventInput, rollingShowId: number): Promise<boolean> {
    const settings = this.db.getAppSettings();
    if (!settings.earlyPrefetchEnabled || input.seasonNumber <= 0 || input.episodeNumber <= 0) return false;

    const sonarr = this.getSonarr();
    const episodes = (await sonarr.getEpisodes(input.sonarrSeriesId!)).filter(isRealSeasonEpisode);
    const selection = selectEarlyPrefetchEpisodes(episodes, input.seasonNumber, input.episodeNumber, settings.earlyPrefetchTriggerEpisodesRemaining, settings.earlyPrefetchEpisodeCount);
    const { episodesRemaining, nextSeasonNumber } = selection;
    if (nextSeasonNumber === null) return false;
    const rolling = this.db.getRollingShow(rollingShowId);
    if (!rolling || rolling.expandedSeasons.includes(nextSeasonNumber)) return false;

    const alreadyPrefetched = new Set(this.db.listPrefetchedEpisodes(rollingShowId)
      .filter((episode) => episode.seasonNumber === nextSeasonNumber)
      .map((episode) => episode.episodeNumber));
    const candidates = selection.episodes
      .filter((episode) => !alreadyPrefetched.has(episode.episodeNumber))
      .sort((a, b) => a.episodeNumber - b.episodeNumber);
    if (candidates.length === 0) return false;

    const updates = candidates.filter((episode) => !episode.monitored).map((episode) => ({ id: episode.id, monitored: true }));
    if (updates.length > 0) await sonarr.updateEpisodesMonitoring(updates);
    await sonarr.searchEpisodes(candidates.filter((episode) => !episode.hasFile).map((episode) => episode.id));

    const dryRun = this.isDryRun();
    if (!dryRun) this.db.recordPrefetchedEpisodes(rollingShowId, input.userId!, nextSeasonNumber, candidates.map((episode) => episode.episodeNumber), input.watchedAt);
    this.db.addHistory("info", dryRun ? "dry_run.sonarr.early_prefetch" : "sonarr.early_prefetch", rolling.title, {
      source: input.source,
      userId: input.userId,
      triggerSeasonNumber: input.seasonNumber,
      triggerEpisodeNumber: input.episodeNumber,
      episodesRemaining,
      nextSeasonNumber,
      prefetchedEpisodes: candidates.map((episode) => episode.episodeNumber),
      dryRun,
    });
    this.logger.info("Next season episodes prefetched from watch activity", {
      seriesId: input.sonarrSeriesId,
      title: rolling.title,
      userId: input.userId,
      triggerSeasonNumber: input.seasonNumber,
      triggerEpisodeNumber: input.episodeNumber,
      nextSeasonNumber,
      prefetchedEpisodes: candidates.map((episode) => episode.episodeNumber),
      dryRun,
    });
    return true;
  }

  private async processWatchEvent(input: NormalizedWatchEventInput, sourceLabel: string, applyRolling = true): Promise<{ inserted: boolean; changed: boolean }> {
    const stored = this.db.insertWatchEvent(input);
    if (!stored.inserted) return { inserted: false, changed: false };
    // Complete history is retained for audit and the History tab, but replaying
    // old pilot watches must not expand seasons or retrigger Sonarr actions.
    if (!applyRolling) return { inserted: true, changed: false };
    if (!input.userId || !input.sonarrSeriesId) return { inserted: true, changed: false };
    const user = this.db.getUser(input.userId);
    const rolling = this.db.getRollingShowBySeriesId(input.sonarrSeriesId);
    if (!user?.enabled || !rolling) return { inserted: true, changed: false };

    const progressUpdated = this.db.upsertRollingUserProgress(rolling.id, user.id, input.seasonNumber, input.episodeNumber, input.watchedAt);
    if (!progressUpdated) return { inserted: true, changed: false };
    // Keep progress current, but let the operation already controlling this
    // series finish its Sonarr mutations before event-side work resumes.
    const operation = this.acquireSeriesOperation(input.sonarrSeriesId);
    if (operation === null) return { inserted: true, changed: false };
    try {
      await this.performProgressiveCleanup(rolling.id, input.seasonNumber, new Date(input.watchedAt));
      if (input.episodeNumber === 1 && input.seasonNumber > 0) {
        return { inserted: true, changed: await this.expandSeason(input.sonarrSeriesId, input.seasonNumber, input.watchedAt, sourceLabel) };
      }
      return { inserted: true, changed: await this.prefetchNextSeason(input, rolling.id) };
    } finally { this.releaseSeriesOperation(input.sonarrSeriesId, operation); }
  }

  private async cleanupSeasonToPilot(seriesId: number, rollingShowId: number, seasonNumber: number): Promise<{ changed: number; reclaimedBytes: number }> {
    const sonarr = this.getSonarr();
    const rolling = this.db.getRollingShow(rollingShowId);
    if (!rolling) return { changed: 0, reclaimedBytes: 0 };
    const settings = this.db.getAppSettings();
    const episodes = (await sonarr.getEpisodes(seriesId)).filter((episode) => episode.seasonNumber === seasonNumber);
    const pilot = episodes.find((episode) => episode.episodeNumber === 1);
    const nonPilots = episodes.filter((episode) => episode.episodeNumber > 1);
    const updates = [
      ...(pilot ? [{ id: pilot.id, monitored: true }] : []),
      ...nonPilots.filter((episode) => episode.monitored).map((episode) => ({ id: episode.id, monitored: false })),
    ];
    await sonarr.updateSeasonMonitoring(seriesId, seasonNumber, false);
    // Disabling the season unmonitors all child episodes in Sonarr. Restore
    // the pilot only after that season-level update.
    await sonarr.updateEpisodesMonitoring(updates);
    const filesToDelete = settings.cleanupDeletesFiles
      ? nonPilots.filter((episode) => episode.hasFile && episode.episodeFileId && episode.episodeFileId > 0).map((episode) => episode.episodeFileId!)
      : [];
    const reclaimedBytes = await this.deleteEpisodeFilesAndRecord({
      sonarr,
      seriesId,
      title: rolling.title,
      rollingShowId,
      action: "cleanup.progressive",
      seasonNumber,
      fileIds: filesToDelete,
    });
    if (reclaimedBytes > 0) this.logger.info("Progressive cleanup reclaimed storage", { seriesId, title: rolling.title, seasonNumber, reclaimedBytes });
    if (!this.isDryRun()) this.db.removeExpandedSeason(rollingShowId, seasonNumber);
    await this.syncPlexArtwork(await sonarr.getSeriesById(seriesId), rolling, rolling.expandedSeasons.filter((season) => season !== seasonNumber));
    return { changed: updates.length + filesToDelete.length, reclaimedBytes };
  }

  private async performProgressiveCleanup(rollingShowId: number, currentSeason: number, observedAt = new Date()): Promise<void> {
    const settings = this.db.getAppSettings();
    const rolling = this.db.getRollingShow(rollingShowId);
    if (!rolling) return;
    const { eligibleForCleanup } = this.getCleanupRetention(rolling, observedAt);
    if (!settings.progressiveCleanupEnabled) return;
    for (const season of eligibleForCleanup.filter((season) => season < currentSeason)) {
      const result = await this.cleanupSeasonToPilot(rolling.sonarrSeriesId, rolling.id, season);
      this.db.addHistory("info", "cleanup.progressive", rolling.title, { seasonNumber: season, reason: "inactive-delay-elapsed", ...result });
    }
  }

  private getStalePrefetchedSeasons(rolling: RollingShowRecord, observedAt = new Date()): number[] {
    const settings = this.db.getAppSettings();
    if (!settings.progressiveCleanupEnabled) return [];
    const activeCutoff = Date.now() - settings.viewerActivityWindowDays * 24 * 60 * 60 * 1000;
    const activeProgress = this.db.listProgressForShow(rolling.id).filter((progress) =>
      progress.lastWatchedSeason > 0 &&
      this.db.getUser(progress.userId)?.enabled &&
      new Date(progress.lastWatchedAt).getTime() >= activeCutoff
    );
    const records = this.db.listPrefetchedEpisodes(rolling.id);
    const bySeason = new Map<number, typeof records>();
    for (const record of records) bySeason.set(record.seasonNumber, [...(bySeason.get(record.seasonNumber) ?? []), record]);
    const delayMs = settings.progressiveCleanupDelayDays * 24 * 60 * 60 * 1000;

    return [...bySeason.entries()]
      .filter(([seasonNumber, seasonRecords]) =>
        !rolling.expandedSeasons.includes(seasonNumber) &&
        !activeProgress.some((progress) => progress.lastWatchedSeason <= seasonNumber) &&
        Math.max(...seasonRecords.map((record) => new Date(record.triggeredAt).getTime())) + delayMs <= observedAt.getTime()
      )
      .map(([seasonNumber]) => seasonNumber)
      .sort((a, b) => a - b);
  }

  async importHistory(options: { full?: boolean } = {}): Promise<RunResult> {
    const full = options.full === true;
    this.logger.info(full ? "Full history reconciliation started" : "History import started");
    const errors: string[] = [];
    let processed = 0;
    let changed = 0;
    let imported = 0;
    let matched = 0;
    let unmatched = 0;
    const sonarrSeries = await this.getSonarr().getSeries();
    changed += this.reconcileAllUnmatchedWatchEvents(sonarrSeries);
    const plex = this.getPlex();
    const overlap = 5 * 60 * 1000;
    const syncState = this.db.getHistorySyncState();
    const withOverlap = (cursor: string | null) => cursor ? new Date(new Date(cursor).getTime() - overlap).toISOString() : undefined;
    const activityCutoff = Date.now() - this.db.getAppSettings().viewerActivityWindowDays * 24 * 60 * 60 * 1000;

    try {
      const plexEvents = await plex.getPlaybackHistory(full ? undefined : syncState.plex.backfillComplete ? withOverlap(syncState.plex.cursor) : undefined);
      for (const event of plexEvents) {
        const user = this.db.findUserByAccount(event.plexAccountId, event.username);
        const series = await this.matchSeries(event, sonarrSeries, plex);
        processed++;
        const result = await this.processWatchEvent({
          source: "plex-history",
          sourceEventId: event.sourceEventId,
          userId: user?.id ?? null,
          plexAccountId: event.plexAccountId,
          username: event.username,
          sonarrSeriesId: series?.id ?? null,
          showTitle: event.showTitle,
          seasonNumber: event.seasonNumber,
          episodeNumber: event.episodeNumber,
          watchedAt: event.watchedAt,
          rawPayload: event.raw,
        }, "plex-history", !full && new Date(event.watchedAt).getTime() >= activityCutoff);
        if (result.inserted) {
          imported++;
          if (series) matched++; else unmatched++;
        }
        if (result.changed) changed++;
      }
      if (!full) {
        syncState.plex = { backfillComplete: true, cursor: this.db.getLatestWatchEventAt("plex-history") };
        this.db.saveHistorySyncState(syncState);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      this.logger.warn("Plex history import failed", { error: message });
    }

    const tautulliSettings = this.db.getTautulliSettings();
    if (tautulliSettings.enabled && tautulliSettings.baseUrl && tautulliSettings.apiKey) {
      try {
        const tautulliEvents = await new TautulliIntegration(tautulliSettings, this.logger).getHistory(full ? undefined : syncState.tautulli.backfillComplete ? withOverlap(syncState.tautulli.cursor) : undefined);
        for (const event of tautulliEvents) {
          const user = this.db.findUserByTautulliId(event.userId, event.username);
          const series = await this.matchSeries(event, sonarrSeries);
          processed++;
          const result = await this.processWatchEvent({
            source: "tautulli",
            sourceEventId: event.referenceId,
            userId: user?.id ?? null,
            plexAccountId: null,
            username: event.username,
            sonarrSeriesId: series?.id ?? null,
            showTitle: event.showTitle,
            seasonNumber: event.seasonNumber,
            episodeNumber: event.episodeNumber,
            watchedAt: event.watchedAt,
            rawPayload: event.raw,
          }, "tautulli", !full && new Date(event.watchedAt).getTime() >= activityCutoff);
          if (result.inserted) {
            imported++;
            if (series) matched++; else unmatched++;
          }
          if (result.changed) changed++;
        }
        if (!full) {
          syncState.tautulli = { backfillComplete: true, cursor: this.db.getLatestWatchEventAt("tautulli") };
          this.db.saveHistorySyncState(syncState);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        this.logger.warn("Tautulli history import failed", { error: message });
      }
    }

    // Dry-run records watch events but intentionally does not persist Sonarr
    // expansion state. Reconcile from active progress so enabling live mode
    // later still expands seasons whose original events are now duplicates.
    if (!full) for (const rolling of this.db.listRollingShows()) {
      const operation = this.acquireSeriesOperation(rolling.sonarrSeriesId);
      if (operation === null) continue;
      try {
        const retainedSeasons = this.getActiveRetainedSeasons(rolling.id);
        for (const seasonNumber of retainedSeasons.filter((season) => !rolling.expandedSeasons.includes(season))) {
          const progress = this.db.listProgressForShow(rolling.id)
            .filter((item) => item.lastWatchedSeason === seasonNumber)
            .sort((a, b) => b.lastWatchedAt.localeCompare(a.lastWatchedAt))[0];
          if (await this.expandSeason(rolling.sonarrSeriesId, seasonNumber, progress?.lastWatchedAt ?? new Date().toISOString(), "active-progress-reconcile")) changed++;
        }
      } finally { this.releaseSeriesOperation(rolling.sonarrSeriesId, operation); }
    }

    const action = full ? "history.full_reconcile" : "history.import";
    const title = full ? "Full history reconciliation" : "History import";
    this.db.addHistory(errors.length ? "warn" : "info", action, title, { fetched: processed, imported, matched, unmatched, changed, errors });
    this.logger[errors.length ? "warn" : "info"](full ? "Full history reconciliation complete" : "History import complete", { fetched: processed, imported, matched, unmatched, changed, errors: errors.length });
    return { ok: errors.length === 0, message: full ? `Reconciled ${processed} history events.` : `Imported ${processed} history events.`, processed, fetched: processed, imported, matched, unmatched, changed, errors };
  }

  async reconcileFullHistory(): Promise<RunResult> {
    return this.importHistory({ full: true });
  }

  async checkSessions(): Promise<RunResult> {
    this.logger.info("Plex session check started");
    const sonarrSeries = await this.getSonarr().getSeries();
    const plex = this.getPlex();
    const events = await plex.getActiveSessions();
    let changed = 0;
    for (const event of events) {
      const user = this.db.findUserByAccount(event.plexAccountId, event.username);
      const series = await this.matchSeries(event, sonarrSeries, plex);
      const result = await this.processWatchEvent({
        source: "plex-session",
        sourceEventId: `${event.sourceEventId}:${event.seasonNumber}:${event.episodeNumber}`,
        userId: user?.id ?? null,
        plexAccountId: event.plexAccountId,
        username: event.username,
        sonarrSeriesId: series?.id ?? null,
        showTitle: event.showTitle,
        seasonNumber: event.seasonNumber,
        episodeNumber: event.episodeNumber,
        watchedAt: event.watchedAt,
        rawPayload: event.raw,
      }, "plex-session");
      if (result.changed) changed++;
    }
    this.db.addHistory("info", "sessions.check", "Plex sessions", { processed: events.length, changed });
    this.logger.info("Plex session check complete", { processed: events.length, changed });
    return { ok: true, message: `Checked ${events.length} active Plex sessions.`, processed: events.length, changed };
  }

  async reconcileRollingShows(): Promise<RunResult> {
    const settings = this.db.getAppSettings();
    this.logger.info("Rolling monitoring reconciliation started", { viewerActivityWindowDays: settings.viewerActivityWindowDays });
    let changed = 0;
    const errors: string[] = [];
    for (const show of this.db.listRollingShows()) {
      const operation = this.acquireSeriesOperation(show.sonarrSeriesId);
      if (operation === null) {
        this.logger.info("Skipped reconciliation while another show operation is running", {
          rollingShowId: show.id,
          seriesId: show.sonarrSeriesId,
          title: show.title,
        });
        continue;
      }
      try {
        // Refresh persisted progress before planning so historical data fixes
        // are applied to already-enrolled shows as well as new enrolments.
        this.seedRollingProgressFromWatchHistory(show.sonarrSeriesId, show.id);
        const { retainedSeasons, eligibleForCleanup } = this.getCleanupRetention(show);
        const stalePrefetchedSeasons = this.getStalePrefetchedSeasons(show);
        if (stalePrefetchedSeasons.length > 0) {
          if (!settings.dryRun) {
            for (const seasonNumber of stalePrefetchedSeasons) this.db.clearPrefetchedEpisodesForSeason(show.id, seasonNumber);
          }
          this.db.addHistory("info", settings.dryRun ? "dry_run.cleanup.prefetch" : "cleanup.prefetch", show.title, {
            seasonNumbers: stalePrefetchedSeasons,
            dryRun: settings.dryRun,
            reason: "inactive-or-skipped-season",
          });
          this.logger.info("Stale prefetched seasons scheduled for pilot cleanup", {
            rollingShowId: show.id,
            seriesId: show.sonarrSeriesId,
            title: show.title,
            seasonNumbers: stalePrefetchedSeasons,
            dryRun: settings.dryRun,
          });
        }
        changed += await this.applyMonitoringPlan(show.sonarrSeriesId, "scheduled-reconcile", retainedSeasons, false, stalePrefetchedSeasons);
        if (eligibleForCleanup.length > 0) {
          this.logger.info("Scheduled reconciliation applied inactive-season cleanup", { rollingShowId: show.id, seriesId: show.sonarrSeriesId, title: show.title, eligibleForCleanup });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${show.title}: ${message}`);
        this.logger.error("Rolling monitoring reconciliation failed for show", { rollingShowId: show.id, seriesId: show.sonarrSeriesId, title: show.title, error: message });
      } finally { this.releaseSeriesOperation(show.sonarrSeriesId, operation); }
    }
    this.db.addHistory(errors.length ? "warn" : "info", "rolling.reconcile", "Rolling monitoring reconciliation", { changed, enrolledShows: this.db.listRollingShows().length, errors });
    this.logger[errors.length ? "warn" : "info"]("Rolling monitoring reconciliation complete", { changed, errors: errors.length });
    return { ok: errors.length === 0, message: `Reconciled rolling monitoring for enrolled shows.`, changed, errors };
  }

  async buildDashboard(jobs: DashboardResponse["jobs"]): Promise<DashboardResponse> {
    const rollingShows = this.db.listRollingShows();
    const settings = this.db.getAppSettings();
    const activeSince = new Date(Date.now() - settings.viewerActivityWindowDays * 24 * 60 * 60 * 1000).toISOString();
    const postersBySeriesId = new Map((this.db.getSonarrLibraryCache()?.items ?? []).map((item) => [item.series.id, item.posterUrl]));
    const reclaimed = this.db.getReclaimedStorageTotals();
    const recentChanges = this.db.listHistory(50).filter((event) =>
      event.level !== "info" || ["sonarr.expand_season", "cleanup.progressive", "show.enrolled", "show.unenrolled", "show.reset", "dry_run.show.reset"].includes(event.action)
    ).slice(0, 6);
    return {
      stats: {
        enrolledShows: rollingShows.length,
        enabledUsers: this.db.listEnabledUsers().length,
        activeViewers: this.db.countActiveViewers(activeSince),
        expandedSeasons: rollingShows.reduce((sum, show) => sum + show.expandedSeasons.length, 0),
        reclaimedBytes: reclaimed.bytesReclaimed,
        reclaimedFiles: reclaimed.fileCount,
      },
      activeShows: this.db.listDashboardShowActivity(activeSince).map((show) => ({ ...show, posterUrl: postersBySeriesId.get(show.sonarrSeriesId) ?? null })),
      recentChanges,
      jobs,
      dryRun: settings.dryRun,
    };
  }

  private async buildShowListItem(
    series: SonarrSeries,
    rolling: ReturnType<PacearrDatabase["getRollingShowBySeriesId"]>,
    sonarr: SonarrIntegration,
    watchers: ShowUserProgress[] = []
  ): Promise<ShowListItem> {
    const posterUrl = await this.imageCache.ensureSonarrPosterCached(series.id, sonarr.getPosterUrl(series), sonarr.getPosterRequestHeaders(series));
    return {
      sonarrSeriesId: series.id,
      title: series.title,
      year: series.year ?? null,
      tvdbId: series.tvdbId ?? null,
      imdbId: series.imdbId ?? null,
      enrolled: Boolean(rolling),
      rollingShowId: rolling?.id ?? null,
      expandedSeasons: rolling?.expandedSeasons ?? [],
      lastActivityAt: rolling?.lastActivityAt ?? null,
      posterUrl,
      status: series.status ?? null,
      seasonCount: series.seasons?.filter((season) => season.seasonNumber > 0).length ?? 0,
      episodeCount: series.seasons?.reduce((sum, season) => sum + (season.statistics?.episodeCount ?? 0), 0) ?? 0,
      sizeOnDiskBytes: series.statistics?.sizeOnDisk ?? 0,
      watcherCount: new Set(watchers.map((item) => item.userId)).size,
      watchers,
    };
  }
}
