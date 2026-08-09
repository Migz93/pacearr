export type SyncStatus = "idle" | "running" | "success" | "error";
export type EventSourceKind = "plex-history" | "plex-session" | "tautulli";

export interface SessionUser {
  plexId: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface BootstrapStatus {
  hasOwner: boolean;
  configurationValid: boolean;
  onboardingComplete: boolean;
  hasActiveSession: boolean;
}

export interface PlexOwnerRecord extends SessionUser {
  plexToken: string;
}

export interface PlexSettingsInput {
  serverUrl: string;
  token: string;
  machineIdentifier: string;
}

export interface PlexConfigPayload {
  mode: "preset" | "manual";
  serverUrl?: string;
  machineIdentifier?: string;
  hostname?: string;
  port?: number;
  useSsl?: boolean;
}

export interface PlexConnectionOption {
  name: string;
  uri: string;
  machineIdentifier: string;
  address: string;
  port: number;
  protocol: "http" | "https";
  local: boolean;
}

export interface PlexSettingsView {
  serverUrl: string;
  machineIdentifier: string;
  tokenConfigured: boolean;
  hostname?: string;
  port?: number;
  useSsl?: boolean;
}

export interface SonarrSettings {
  baseUrl: string;
  apiKey: string;
}

export interface SonarrSettingsView {
  baseUrl: string;
  apiKeyConfigured: boolean;
}

export interface TautulliSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
}

export interface TautulliSettingsView {
  enabled: boolean;
  baseUrl: string;
  apiKeyConfigured: boolean;
}

export interface AppSettings {
  dryRun: boolean;
  artworkEnabled: boolean;
  viewerActivityWindowDays: number;
  historyRetentionDays: number;
  sessionPollIntervalMinutes: number;
  historyImportIntervalHours: number;
  progressiveCleanupEnabled: boolean;
  progressiveCleanupDelayDays: number;
  cleanupDeletesFiles: boolean;
  recommendationMinimumSavingsGb: number;
  trustProxy: boolean;
  onboardingComplete: boolean;
  earlyPrefetchEnabled: boolean;
  earlyPrefetchTriggerEpisodesRemaining: number;
  earlyPrefetchEpisodeCount: number;
}

export interface PlexArtworkRecord {
  id: number;
  rollingShowId: number;
  plexShowRatingKey: string;
  plexItemRatingKey: string;
  itemType: "show" | "season" | "episode";
  seasonNumber: number;
  originalPosterPath: string;
  overlayPosterPath: string;
  overlayApplied: boolean;
  renderVersion: number;
  overlaySha256: string;
  overlayThumb: string;
  createdAt: string;
  updatedAt: string;
}

export interface SettingsResponse {
  app: AppSettings;
  plex: PlexSettingsView | null;
  sonarr: SonarrSettingsView | null;
  tautulli: TautulliSettingsView;
  jobs: JobInfo[];
}

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: unknown;
}

export interface LogsPageResponse {
  results: LogEntry[];
  pageInfo: {
    page: number;
    pageSize: number;
    pages: number;
    total: number;
  };
}

export interface UserRecord {
  id: number;
  plexUserId: string;
  plexAccountId: string | null;
  tautulliUserId: string | null;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  enabled: boolean;
  lastSeenAt: string | null;
}

/** A user plus the activity the Users page shows. UserRecord stays the raw row shape. */
export interface UserListItem extends UserRecord {
  /** Enrolled shows this viewer is currently keeping expanded. */
  activeShowCount: number;
  /** Most recent watch on any enrolled show, regardless of the activity window. */
  lastWatchedAt: string | null;
}

export interface UserShowActivity {
  sonarrSeriesId: number;
  title: string;
  seasonNumber: number;
  episodeNumber: number;
  watchedAt: string;
  /** False once the watch falls outside the viewer activity window. */
  active: boolean;
}

export interface SonarrSeries {
  id: number;
  title: string;
  sortTitle?: string;
  tvdbId?: number;
  imdbId?: string | null;
  year?: number;
  status?: string;
  monitored?: boolean;
  monitorNewItems?: "all" | "none";
  images?: Array<{
    coverType?: string;
    url?: string;
    remoteUrl?: string;
  }>;
  statistics?: {
    seasonCount?: number;
    episodeCount?: number;
    episodeFileCount?: number;
    totalEpisodeCount?: number;
    sizeOnDisk?: number;
    percentOfEpisodes?: number;
  };
  seasons?: Array<{
    seasonNumber: number;
    monitored: boolean;
    statistics?: {
      episodeCount?: number;
      totalEpisodeCount?: number;
      percentOfEpisodes?: number;
      sizeOnDisk?: number;
    };
  }>;
}

export interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  airDate?: string;
  airDateUtc?: string;
  monitored: boolean;
  hasFile?: boolean;
  episodeFileId?: number;
}

export interface SonarrEpisodeFile {
  id: number;
  seriesId: number;
  seasonNumber: number;
  size: number;
}

export interface ShowListItem {
  sonarrSeriesId: number;
  title: string;
  year: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  enrolled: boolean;
  rollingShowId: number | null;
  expandedSeasons: number[];
  lastActivityAt: string | null;
  posterUrl: string | null;
  status: string | null;
  seasonCount: number;
  episodeCount: number;
  sizeOnDiskBytes: number;
  viewerCount: number;
  viewers: ShowUserProgress[];
}

export interface ShowSeasonSummary {
  seasonNumber: number;
  monitored: boolean;
  targetMonitored: boolean;
  episodeCount: number;
  totalEpisodeCount: number;
  watchedUsers: number;
  latestWatchedAt: string | null;
  isExpanded: boolean;
  prefetchedEpisodes: PrefetchedEpisodeSummary[];
}

export interface PrefetchedEpisodeSummary {
  seasonNumber: number;
  episodeNumber: number;
  userId: number;
  displayName: string;
  avatarUrl: string | null;
  triggeredAt: string;
}

export interface PrefetchedEpisodeRecord {
  id: number;
  rollingShowId: number;
  userId: number;
  seasonNumber: number;
  episodeNumber: number;
  triggeredAt: string;
}

export interface ShowEpisodeSummary {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: string | null;
  monitored: boolean;
  targetMonitored: boolean;
  hasFile: boolean;
  watchedUsers: number;
  latestWatchedAt: string | null;
}

export interface ShowUserProgress {
  userId: number;
  displayName: string;
  avatarUrl: string | null;
  enabled: boolean;
  seasonNumber: number;
  episodeNumber: number;
  watchedAt: string;
}

export interface ShowDetailResponse {
  show: ShowListItem;
  seasons: ShowSeasonSummary[];
  episodes: ShowEpisodeSummary[];
  progress: ShowUserProgress[];
  historyProgress: ShowUserProgress[];
  dryRunPreview: {
    enabled: boolean;
  };
  recommendation: {
    sizeOnDiskBytes: number;
    projectedSavingsBytes: number;
    ignored: boolean;
    eligible: boolean;
  } | null;
}

export interface SonarrLibraryCacheItem {
  series: SonarrSeries;
  posterUrl: string | null;
}

export interface ShowsResponse {
  shows: ShowListItem[];
  generatedAt: string | null;
  refreshing: boolean;
}

export interface ShowRecommendation {
  sonarrSeriesId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  status: string | null;
  seasonCount: number;
  episodeCount: number;
  sizeOnDiskBytes: number;
  retainedSeasons: number[];
  droppedSeasons: number[];
  viewerCount: number;
  viewers: ShowUserProgress[];
  projectedSavingsBytes: number;
  ignored: boolean;
}

export interface RecommendationsResponse {
  candidates: ShowRecommendation[];
  ignoredCount: number;
  generatedAt: string | null;
  refreshing: boolean;
  cleanupDeletesFilesEnabled: boolean;
  viewerActivityWindowDays: number;
}

export interface RollingShowRecord {
  id: number;
  sonarrSeriesId: number;
  title: string;
  tvdbId: number | null;
  imdbId: string | null;
  year: number | null;
  expandedSeasons: number[];
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RollingShowUserRecord {
  id: number;
  rollingShowId: number;
  userId: number;
  lastWatchedSeason: number;
  lastWatchedEpisode: number;
  lastWatchedAt: string;
}

export interface WatchEvent {
  id: number;
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
  rawPayload: string;
}

export interface HistoryEvent {
  id: number;
  level: "info" | "warn" | "error";
  action: string;
  title: string;
  details: string;
  createdAt: string;
}

export interface HistoryPageResponse {
  results: HistoryEvent[];
  pageInfo: {
    page: number;
    pageSize: number;
    pages: number;
    total: number;
  };
}

export interface DashboardResponse {
  stats: {
    enrolledShows: number;
    enabledUsers: number;
    activeViewers: number;
    expandedSeasons: number;
    reclaimedBytes: number;
    reclaimedFiles: number;
  };
  activeShows: DashboardShowActivity[];
  recentActivity: HistoryEvent[];
  jobs: JobInfo[];
  dryRun: boolean;
}

export interface DashboardShowActivity {
  id: number;
  sonarrSeriesId: number;
  title: string;
  posterUrl: string | null;
  expandedSeasons: number[];
  activeViewerCount: number;
  lastWatchedAt: string | null;
  lastWatchedSeason: number | null;
  lastWatchedEpisode: number | null;
  lastWatcherName: string | null;
}

export interface JobInfo {
  id: string;
  enabled: boolean;
  name?: string;
  intervalDescription?: string;
  nextRunAt: string | null;
  nextRunLabel?: string;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  running: boolean;
  isRunning?: boolean;
}

export interface AboutInfo {
  version: string;
  buildChannel: string;
  commitSha: string;
  nodeVersion?: string;
  platform?: string;
  dataDir?: string;
  tz?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface RunResult {
  ok: boolean;
  message: string;
  rollingShowId?: number;
  processed?: number;
  changed?: number;
  fetched?: number;
  imported?: number;
  matched?: number;
  unmatched?: number;
  errors?: string[];
}
