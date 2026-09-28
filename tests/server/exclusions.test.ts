import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { ImageCacheService } from "../../src/server/image-cache.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import type { Logger } from "../../src/server/logger.js";
import { calculateRollingPlan, PacearrServices } from "../../src/server/services.js";
import type { AppSettings, SonarrEpisode, SonarrSeries } from "../../src/shared/types.js";

/**
 * Season and episode exclusions (#195). These are server tests because a mistake is
 * invisible in the UI: an excluded episode's file quietly deleted, or Sonarr told to
 * search a season the administrator gave up on.
 */

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function episode(id: number, seasonNumber: number, episodeNumber: number, overrides: Partial<SonarrEpisode> = {}): SonarrEpisode {
  return { id, seriesId: 81, seasonNumber, episodeNumber, monitored: false, hasFile: false, ...overrides };
}

// Three seasons of three episodes. Season 1 is expanded and downloaded; seasons 2 and 3
// are pilot-only with nothing on disk.
function showEpisodes(): SonarrEpisode[] {
  return [
    ...[1, 2, 3].map((number) => episode(8100 + number, 1, number, { monitored: true, hasFile: true, episodeFileId: 8100 + number })),
    ...[1, 2, 3].map((number) => episode(8200 + number, 2, number, { monitored: number === 1 })),
    ...[1, 2, 3].map((number) => episode(8300 + number, 3, number, { monitored: number === 1 })),
  ];
}

const show: SonarrSeries = {
  id: 81,
  title: "Excluded Show",
  tvdbId: 818181,
  monitored: true,
  monitorNewItems: "none",
  seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: false }, { seasonNumber: 3, monitored: false }],
};

type Request = { method: string; pathname: string; body?: string };

function createHarness(settings: Partial<AppSettings> = {}, options: { episodes?: SonarrEpisode[] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-exclusions-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1000, logLevel: "error" };
  const logger = silentLogger();
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, logger, new ImageCacheService(dir, logger), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.updateAppSettings({ dryRun: false, earlyPrefetchEnabled: false, expandNextSeasonOnFinaleEnabled: false, cleanupDeletesFiles: true, ...settings });
  const [viewer] = db.upsertUsers([
    { plexUserId: "plex-viewer", plexAccountId: "42", tautulliUserId: null, username: "viewer", displayName: "Viewer", avatarUrl: null },
  ]);
  db.updateUser(viewer!.id, { enabled: true });
  const rolling = db.upsertRollingShow(show);
  db.markSeasonExpanded(rolling.id, 1, new Date().toISOString());

  const episodes = options.episodes ?? showEpisodes();
  let sessionsXml = '<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>';
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, pathname: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.hostname === "plex" && url.pathname === "/status/sessions") return new Response(sessionsXml, { status: 200, headers: { "content-type": "application/xml" } });
    if (url.hostname === "plex" && url.pathname.startsWith("/library/metadata/")) {
      return new Response('<?xml version="1.0"?><MediaContainer><Directory><Guid id="tvdb://818181" /></Directory></MediaContainer>', { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.pathname === "/api/v3/series") return Response.json([show]);
    if (url.pathname === "/api/v3/series/81") return Response.json(show);
    if (url.pathname === "/api/v3/episode") return Response.json(episodes);
    if (url.pathname === "/api/v3/episodefile") return Response.json([]);
    if (method !== "GET") return Response.json({});
    throw new Error(`Unhandled fetch in test: ${url.toString()}`);
  }) as typeof fetch;

  const writes = () => requests.filter((request) => request.method !== "GET");
  return {
    db,
    services,
    requests,
    rollingShowId: rolling.id,
    watch: (seasonNumber: number, episodeNumber: number) => {
      sessionsXml = `<?xml version="1.0"?><MediaContainer size="1"><Video type="episode" sessionKey="${seasonNumber}-${episodeNumber}" ratingKey="8${seasonNumber}${episodeNumber}" grandparentRatingKey="810" grandparentTitle="Excluded Show" parentIndex="${seasonNumber}" index="${episodeNumber}"><User id="42" title="viewer" /></Video></MediaContainer>`;
      return services.checkSessions();
    },
    writes,
    expandedSeasons: () => db.getRollingShowBySeriesId(81)!.expandedSeasons,
    episodeMonitorUpdates: () => writes()
      .filter((request) => request.pathname === "/api/v3/episode/monitor")
      .map((request) => JSON.parse(request.body!) as { episodeIds: number[]; monitored: boolean }),
    searches: () => writes()
      .filter((request) => request.pathname === "/api/v3/command")
      .map((request) => JSON.parse(request.body!) as Record<string, unknown>),
    fileDeletes: () => writes().filter((request) => request.method === "DELETE"),
    cleanup: () => {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("rolling plan never monitors, searches or deletes the files of excluded items", () => {
  const episodes = [
    episode(1, 1, 1, { monitored: true, hasFile: true, episodeFileId: 101 }),
    episode(2, 1, 2, { monitored: true, hasFile: true, episodeFileId: 102 }),
    episode(3, 2, 1, { monitored: true }),
    episode(4, 2, 2, { monitored: true, hasFile: true, episodeFileId: 104 }),
    episode(5, 3, 1, { monitored: true, hasFile: true, episodeFileId: 105 }),
    episode(6, 3, 2, { monitored: true }),
    episode(7, 3, 3, { monitored: true, hasFile: true, episodeFileId: 107 }),
  ];
  const series = { ...show, seasons: [1, 2, 3].map((seasonNumber) => ({ seasonNumber, monitored: true })) };

  // Season 2 is excluded outright and S03E02 individually; both seasons 2 and 3 would
  // otherwise be retained by viewers.
  const plan = calculateRollingPlan(series, episodes, [2, 3], true, [], { seasons: [2], episodes: [{ seasonNumber: 3, episodeNumber: 2 }] });

  assert.deepEqual(plan.retainedSeasons, [3]);
  assert.deepEqual(plan.seasonMonitoringToDisable.map((season) => season.seasonNumber), [1, 2]);
  assert.deepEqual(plan.episodesToUnmonitor.map((item) => item.id), [2, 3, 4, 6]);
  // S02E01 is a missing pilot and S03E02 the only missing episode of a retained season,
  // but both are excluded, so nothing is searched.
  assert.deepEqual(plan.pilotSearches, []);
  assert.deepEqual(plan.seasonSearches, []);
  // S01E02 is an ordinary non-pilot; S02E02 is excluded and keeps its file.
  assert.deepEqual(plan.filesToDelete, [102]);
});

test("excluding an expanded season unmonitors all of it without searching or deleting files", async () => {
  const harness = createHarness();
  try {
    const result = await harness.services.setSeasonExcluded(harness.rollingShowId, 1, true);

    assert.equal(result.ok, true);
    assert.deepEqual(harness.episodeMonitorUpdates(), [{ episodeIds: [8101, 8102, 8103], monitored: false }]);
    assert.deepEqual(harness.searches(), []);
    assert.deepEqual(harness.fileDeletes(), []);
    assert.deepEqual(harness.expandedSeasons(), []);
    assert.deepEqual(harness.db.getRollingExclusions(harness.rollingShowId).seasons, [1]);
    assert.equal(harness.db.listHistory(20).some((entry) => entry.action === "show.season_excluded"), true);
  } finally {
    harness.cleanup();
  }
});

test("watching an excluded season does not expand it or trigger any Sonarr work", async () => {
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true, earlyPrefetchEnabled: true });
  try {
    await harness.services.setSeasonExcluded(harness.rollingShowId, 2, true);
    const writesBefore = harness.writes().length;

    // E01 would normally expand season 2; E03 is its finale and inside the prefetch trigger.
    await harness.watch(2, 1);
    await harness.watch(2, 3);
    assert.equal(harness.writes().length, writesBefore);

    // The catch-up sweep applies the stored position again without the watch-event path.
    // It may unmonitor (the static fixture still reports S02E01 as monitored) but must
    // never monitor, search or expand anything because of this viewer.
    await harness.services.reconcileRollingShows();

    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.deepEqual(harness.searches(), []);
    assert.equal(harness.episodeMonitorUpdates().some((update) => update.monitored), false);
    assert.equal(harness.writes().some((request) => request.method === "PUT" && request.pathname === "/api/v3/series/81" && request.body?.includes('"seasonNumber":2,"monitored":true')), false);
  } finally {
    harness.cleanup();
  }
});

test("a finale does not expand, or prefetch into, an excluded next season", async () => {
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true, earlyPrefetchEnabled: true });
  try {
    await harness.services.setSeasonExcluded(harness.rollingShowId, 2, true);
    const writesBefore = harness.writes().length;

    await harness.watch(1, 3);

    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.deepEqual(harness.db.listPrefetchedEpisodes(harness.rollingShowId), []);
    assert.equal(harness.writes().length, writesBefore);
  } finally {
    harness.cleanup();
  }
});

test("expanding a season keeps its excluded episode unmonitored and unsearched", async () => {
  const harness = createHarness();
  try {
    await harness.services.setEpisodeExcluded(harness.rollingShowId, 3, 2, true);

    await harness.watch(3, 1);

    assert.deepEqual(harness.expandedSeasons(), [1, 3]);
    const updates = harness.episodeMonitorUpdates();
    // Monitoring the season re-monitors every child episode in Sonarr, so the excluded
    // episode must be explicitly unmonitored again in the same expansion.
    assert.deepEqual(updates.find((update) => update.monitored)?.episodeIds, [8303]);
    assert.deepEqual(updates.at(-1), { episodeIds: [8302], monitored: false });
    assert.deepEqual(harness.searches(), [{ name: "SeasonSearch", seriesId: 81, seasonNumber: 3 }]);
  } finally {
    harness.cleanup();
  }
});

// S01E01 and S01E02 are excluded while season 1 is expanded; S02E02 is excluded in the
// pilot-only season 2. S01E01 is unmonitored, as its exclusion left it.
function trimmedSeasonEpisodes(): SonarrEpisode[] {
  return showEpisodes().map((item) => item.id === 8101 ? { ...item, monitored: false } : item);
}

function excludeForTrim(harness: ReturnType<typeof createHarness>) {
  harness.db.excludeEpisode(harness.rollingShowId, 1, 1);
  harness.db.excludeEpisode(harness.rollingShowId, 1, 2);
  harness.db.excludeEpisode(harness.rollingShowId, 2, 2);
}

test("trimming an expanded season back to its pilot resets its episode exclusions", async () => {
  // Nobody is watching season 1 and the cleanup delay is zero, so the scheduled
  // reconciliation trims it. Carrying its exclusions into a later re-expansion would make
  // Sonarr reject every season pack, so they are reset and the season is trimmed as normal.
  const harness = createHarness({ progressiveCleanupDelayDays: 0 }, { episodes: trimmedSeasonEpisodes() });
  try {
    excludeForTrim(harness);

    await harness.services.reconcileRollingShows();

    assert.deepEqual(harness.expandedSeasons(), []);
    // Only the never-expanded season 2 keeps its exclusion.
    assert.deepEqual(harness.db.getRollingExclusions(harness.rollingShowId).episodes, [{ seasonNumber: 2, episodeNumber: 2 }]);
    assert.equal(harness.episodeMonitorUpdates().some((update) => update.monitored && update.episodeIds.includes(8101)), true);
    assert.deepEqual(harness.fileDeletes().map((request) => request.pathname).sort(), ["/api/v3/episodefile/8102", "/api/v3/episodefile/8103"]);
    const baseline = harness.db.listHistory(20).find((entry) => entry.action === "sonarr.baseline");
    assert.equal(JSON.parse(String(baseline!.details)).resetExcludedEpisodes, 2);
  } finally {
    harness.cleanup();
  }
});

test("progressive cleanup from a watch also resets the trimmed season's episode exclusions", async () => {
  const harness = createHarness({ progressiveCleanupDelayDays: 0 }, { episodes: trimmedSeasonEpisodes() });
  try {
    excludeForTrim(harness);

    // Moving on to season 2 leaves season 1 without an active viewer, so this watch trims it.
    await harness.watch(2, 1);

    assert.deepEqual(harness.expandedSeasons(), [2]);
    assert.deepEqual(harness.db.getRollingExclusions(harness.rollingShowId).episodes, [{ seasonNumber: 2, episodeNumber: 2 }]);
    assert.equal(harness.episodeMonitorUpdates().some((update) => update.monitored && update.episodeIds.includes(8101)), true);
    assert.deepEqual(harness.fileDeletes().map((request) => request.pathname).sort(), ["/api/v3/episodefile/8102", "/api/v3/episodefile/8103"]);
    const cleanup = harness.db.listHistory(20).find((entry) => entry.action === "cleanup.progressive");
    assert.equal(JSON.parse(String(cleanup!.details)).resetExcludedEpisodes, 2);
  } finally {
    harness.cleanup();
  }
});

test("a dry-run trim keeps the season's episode exclusions", async () => {
  const harness = createHarness({ dryRun: true, progressiveCleanupDelayDays: 0 }, { episodes: trimmedSeasonEpisodes() });
  try {
    excludeForTrim(harness);

    await harness.services.reconcileRollingShows();

    assert.deepEqual(harness.writes(), []);
    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.equal(harness.db.getRollingExclusions(harness.rollingShowId).episodes.length, 3);
  } finally {
    harness.cleanup();
  }
});

test("including a season restores only its pilot and searches it when missing", async () => {
  const harness = createHarness();
  try {
    harness.db.excludeSeason(harness.rollingShowId, 2);

    const result = await harness.services.setSeasonExcluded(harness.rollingShowId, 2, false);

    assert.equal(result.ok, true);
    // S02E01 is already monitored in the fixture, so only the search is sent.
    assert.deepEqual(harness.episodeMonitorUpdates(), []);
    assert.deepEqual(harness.searches(), [{ name: "EpisodeSearch", episodeIds: [8201] }]);
    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.deepEqual(harness.db.getRollingExclusions(harness.rollingShowId).seasons, []);
  } finally {
    harness.cleanup();
  }
});

test("including an episode restores the monitoring its season implies", async () => {
  const episodes = showEpisodes().map((item) => item.id === 8102 ? { ...item, monitored: false, hasFile: false } : item);
  const harness = createHarness({}, { episodes });
  try {
    harness.db.excludeEpisode(harness.rollingShowId, 1, 2);
    harness.db.excludeEpisode(harness.rollingShowId, 2, 2);

    // Season 1 is expanded, so its episode is monitored again and searched.
    await harness.services.setEpisodeExcluded(harness.rollingShowId, 1, 2, false);
    // Season 2 is pilot-only, so its E02 stays unmonitored and nothing is sent.
    await harness.services.setEpisodeExcluded(harness.rollingShowId, 2, 2, false);

    assert.deepEqual(harness.episodeMonitorUpdates(), [{ episodeIds: [8102], monitored: true }]);
    assert.deepEqual(harness.searches(), [{ name: "EpisodeSearch", episodeIds: [8102] }]);
    assert.deepEqual(harness.db.getRollingExclusions(harness.rollingShowId).episodes, []);
  } finally {
    harness.cleanup();
  }
});

test("including an episode monitors it when an active viewer holds its not-yet-expanded season", async () => {
  // A viewer is in season 3, but its expansion was never persisted (for example it was
  // first seen in dry run). The rolling plan already retains season 3, so including
  // S03E02 must monitor and search it now rather than wait for the next reconcile.
  const harness = createHarness();
  try {
    const viewer = harness.db.listUsers()[0]!;
    harness.db.upsertRollingUserProgress(harness.rollingShowId, viewer.id, 3, 1, new Date().toISOString());
    harness.db.excludeEpisode(harness.rollingShowId, 3, 2);

    await harness.services.setEpisodeExcluded(harness.rollingShowId, 3, 2, false);

    assert.deepEqual(harness.episodeMonitorUpdates(), [{ episodeIds: [8302], monitored: true }]);
    assert.deepEqual(harness.searches(), [{ name: "EpisodeSearch", episodeIds: [8302] }]);
  } finally {
    harness.cleanup();
  }
});

test("dry run stores an exclusion without changing Sonarr or expanded seasons", async () => {
  const harness = createHarness({ dryRun: true });
  try {
    const result = await harness.services.setSeasonExcluded(harness.rollingShowId, 1, true);

    assert.equal(result.ok, true);
    assert.deepEqual(harness.writes(), []);
    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.deepEqual(harness.db.getRollingExclusions(harness.rollingShowId).seasons, [1]);
    assert.equal(harness.db.listHistory(20).some((entry) => entry.action === "dry_run.show.season_excluded"), true);
  } finally {
    harness.cleanup();
  }
});
