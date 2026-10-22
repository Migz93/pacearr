import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { runMigrations } from "../../src/server/db/migrations.js";
import { ImageCacheService } from "../../src/server/image-cache.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import type { Logger } from "../../src/server/logger.js";
import { PacearrServices, selectRequestedSeasons } from "../../src/server/services.js";
import type { AppSettings, SonarrEpisode, SonarrSeries } from "../../src/shared/types.js";

/**
 * Why a season is expanded (#235), the Expand button (#237), and keeping the seasons
 * requested when a show was added through triage enrolment (#236). A season expanded
 * with no viewer behind it must still be explained on the show page and trimmed back
 * to its pilot after the cleanup delay, like any other expanded season.
 */

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

const SERIES_ID = 91;
const DAY_MS = 24 * 60 * 60 * 1000;

// Three seasons of three episodes, none downloaded. An episode starts monitored when its
// season is, as Sonarr adds a series with only the requested seasons monitored.
function showEpisodes(monitoredSeasons: number[]): SonarrEpisode[] {
  return [1, 2, 3].flatMap((seasonNumber) => [1, 2, 3].map((episodeNumber) => ({
    id: 9000 + seasonNumber * 10 + episodeNumber,
    seriesId: SERIES_ID,
    seasonNumber,
    episodeNumber,
    monitored: monitoredSeasons.includes(seasonNumber),
    hasFile: false,
  })));
}

type Request = { method: string; pathname: string; body?: string };

function createHarness(options: { monitoredSeasons?: number[]; settings?: Partial<AppSettings>; enroll?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-expansion-reasons-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1000, logLevel: "error" };
  const logger = silentLogger();
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, logger, new ImageCacheService(dir, logger), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.updateAppSettings({ dryRun: false, earlyPrefetchEnabled: false, expandNextSeasonOnFinaleEnabled: false, progressiveCleanupEnabled: true, progressiveCleanupDelayDays: 7, ...options.settings });

  const monitoredSeasons = options.monitoredSeasons ?? [];
  let series: SonarrSeries = {
    id: SERIES_ID,
    title: "Requested Show",
    tvdbId: 919191,
    added: new Date().toISOString(),
    monitored: true,
    monitorNewItems: "all",
    seasons: [1, 2, 3].map((seasonNumber) => ({ seasonNumber, monitored: monitoredSeasons.includes(seasonNumber) })),
    statistics: { totalEpisodeCount: 123 },
  };
  const episodes = showEpisodes(monitoredSeasons);
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, pathname: url.pathname, body });
    if (url.pathname === "/api/v3/series") return Response.json([series]);
    if (url.pathname === `/api/v3/series/${SERIES_ID}`) {
      if (method === "PUT") series = { ...series, ...JSON.parse(body!) as Partial<SonarrSeries> };
      return Response.json(series);
    }
    if (url.pathname === "/api/v3/episode") return Response.json(episodes);
    if (url.pathname === "/api/v3/episode/monitor") {
      const update = JSON.parse(body!) as { episodeIds: number[]; monitored: boolean };
      for (const episode of episodes) if (update.episodeIds.includes(episode.id)) episode.monitored = update.monitored;
      return Response.json({});
    }
    if (url.pathname === "/api/v3/episodefile") return Response.json([]);
    if (method !== "GET") return Response.json({});
    throw new Error(`Unhandled fetch in test: ${url.toString()}`);
  }) as typeof fetch;

  const rollingShowId = options.enroll ? db.upsertRollingShow(series).id : 0;
  const writes = () => requests.filter((request) => request.method !== "GET");
  const rolling = () => db.getRollingShowBySeriesId(SERIES_ID);
  return {
    db,
    services,
    rollingShowId,
    episodes,
    writes,
    rolling,
    expandedSeasons: () => rolling()?.expandedSeasons ?? [],
    reasons: () => rolling() ? db.listSeasonExpansions(rolling()!.id).map((expansion) => [expansion.seasonNumber, expansion.reason]) : [],
    commands: () => writes()
      .filter((request) => request.pathname === "/api/v3/command")
      .map((request) => JSON.parse(request.body!) as Record<string, unknown>),
    unmonitoredEpisodeIds: () => writes()
      .filter((request) => request.pathname === "/api/v3/episode/monitor")
      .map((request) => JSON.parse(request.body!) as { episodeIds: number[]; monitored: boolean })
      .filter((update) => !update.monitored)
      .flatMap((update) => update.episodeIds),
    expandHistory: () => db.listHistory(50)
      .filter((entry) => entry.action.endsWith("sonarr.expand_season"))
      .map((entry): Record<string, unknown> => ({ action: entry.action, ...JSON.parse(String(entry.details)) as Record<string, unknown> })),
    /** Moves a season's inactivity timer back, as if it started that many days ago. */
    ageInactivity: (seasonNumber: number, days: number) => {
      const show = rolling()!;
      db.clearSeasonInactivity(show.id, seasonNumber);
      db.markSeasonInactive(show.id, seasonNumber, new Date(Date.now() - days * DAY_MS).toISOString());
    },
    enableTriage: () => db.updateAppSettings({
      newShowTriageEnabled: true,
      newShowTriageEnabledAt: new Date(Date.now() - 60_000).toISOString(),
      newShowTriageEpisodeThreshold: 80,
    }),
    cleanup: () => {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("requested seasons are only the monitored ones when some, but not all, real seasons are monitored", () => {
  const seasons = (monitored: number[]) => ({
    id: 1, title: "Show", monitored: true,
    seasons: [0, 1, 2, 3].map((seasonNumber) => ({ seasonNumber, monitored: monitored.includes(seasonNumber) })),
  }) satisfies SonarrSeries;
  assert.deepEqual(selectRequestedSeasons(seasons([1])), [1]);
  assert.deepEqual(selectRequestedSeasons(seasons([0, 2, 3])), [2, 3]);
  // Every real season monitored is a whole-show request; specials do not count.
  assert.deepEqual(selectRequestedSeasons(seasons([1, 2, 3])), []);
  assert.deepEqual(selectRequestedSeasons(seasons([0, 1, 2, 3])), []);
  assert.deepEqual(selectRequestedSeasons(seasons([])), []);
});

test("migration 29 records existing expanded seasons as watched and skips malformed state", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-migration-test-"));
  const raw = new Database(path.join(dir, "pacearr.db"));
  try {
    runMigrations(raw, undefined, 28);
    const stamp = "2026-10-01T09:00:00.000Z";
    const insert = raw.prepare("INSERT INTO rolling_shows (sonarr_series_id, title, expanded_seasons, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    insert.run(1, "Expanded", "[2, 1]", stamp, stamp);
    insert.run(2, "Malformed", "{not json", stamp, stamp);
    runMigrations(raw);
    const rows = raw.prepare("SELECT rolling_show_id AS showId, season_number AS seasonNumber, reason, user_id AS userId, expanded_at AS expandedAt FROM rolling_expanded_seasons ORDER BY rolling_show_id, season_number").all();
    assert.deepEqual(rows, [
      { showId: 1, seasonNumber: 1, reason: "watched", userId: null, expandedAt: null },
      { showId: 1, seasonNumber: 2, reason: "watched", userId: null, expandedAt: null },
    ]);
  } finally {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each way expanded-season state is cleared also clears its reason", () => {
  const harness = createHarness({ enroll: true });
  try {
    const { db, rollingShowId } = harness;
    const at = "2026-10-22T09:00:00.000Z";
    db.markSeasonExpanded(rollingShowId, 1, at, { reason: "manual" });
    db.markSeasonExpanded(rollingShowId, 2, at, { reason: "requested" });
    db.markSeasonExpanded(rollingShowId, 3, at, { reason: "finale" });
    // A request or the Expand button is not watch activity.
    assert.equal(harness.rolling()!.lastActivityAt, at);

    // Trim (progressive cleanup, exclusion).
    db.removeExpandedSeason(rollingShowId, 1);
    assert.deepEqual(harness.reasons(), [[2, "requested"], [3, "finale"]]);
    // Reconcile: a kept season keeps its reason, a dropped one loses it, and one promoted
    // from viewer progress counts as watched.
    db.replaceExpandedSeasons(rollingShowId, [2, 1]);
    assert.deepEqual(harness.reasons(), [[1, "watched"], [2, "requested"]]);
    // Reset.
    db.resetExpandedSeasons(rollingShowId);
    assert.deepEqual(harness.reasons(), []);
    // Unenrolment deletes the show, and the reasons with it.
    db.markSeasonExpanded(rollingShowId, 1, at, { reason: "manual" });
    db.deleteRollingShow(rollingShowId);
    assert.deepEqual(db.listSeasonExpansions(rollingShowId), []);
  } finally {
    harness.cleanup();
  }
});

test("a season expanded by watching records the viewer, and excluding it clears the reason", async () => {
  const harness = createHarness({ enroll: true });
  try {
    const [viewer] = harness.db.upsertUsers([
      { plexUserId: "plex-viewer", plexAccountId: "42", tautulliUserId: null, username: "viewer", displayName: "Viewer", avatarUrl: null },
    ]);
    const expanded = await harness.services.expandSeason(SERIES_ID, 2, "2026-10-22T09:00:00.000Z", "plex-session", { reason: "watched", userId: viewer!.id });
    assert.equal(expanded, true);
    const [expansion] = harness.db.listSeasonExpansions(harness.rollingShowId);
    assert.deepEqual(expansion, { seasonNumber: 2, reason: "watched", userId: viewer!.id, displayName: "Viewer", expandedAt: "2026-10-22T09:00:00.000Z" });
    assert.equal(harness.expandHistory()[0]!.reason, "watched");

    await harness.services.setSeasonExcluded(harness.rollingShowId, 2, true);
    assert.deepEqual(harness.reasons(), []);
  } finally {
    harness.cleanup();
  }
});

test("the Expand button monitors and searches the season once and records it as manual", async () => {
  const harness = createHarness({ enroll: true });
  try {
    const result = await harness.services.expandSeasonManually(harness.rollingShowId, 2);

    assert.equal(result.ok, true);
    assert.deepEqual(harness.expandedSeasons(), [2]);
    assert.deepEqual(harness.reasons(), [[2, "manual"]]);
    assert.deepEqual(harness.commands(), [{ name: "SeasonSearch", seriesId: SERIES_ID, seasonNumber: 2 }]);
    assert.equal(harness.episodes.filter((episode) => episode.seasonNumber === 2).every((episode) => episode.monitored), true);
    assert.deepEqual(harness.expandHistory().map(({ action, source, reason }) => ({ action, source, reason })), [
      { action: "sonarr.expand_season", source: "manual", reason: "manual" },
    ]);
    // Not watch activity, so the show's last activity is unchanged.
    assert.equal(harness.rolling()!.lastActivityAt, null);
  } finally {
    harness.cleanup();
  }
});

test("the Expand button refuses an expanded, excluded, missing or busy season", async () => {
  const harness = createHarness({ enroll: true });
  const operations = harness.services as unknown as {
    acquireSeriesOperation(seriesId: number): number | null;
    releaseSeriesOperation(seriesId: number, operation: number): void;
  };
  try {
    const { services, db, rollingShowId } = harness;
    db.markSeasonExpanded(rollingShowId, 1, new Date().toISOString(), { reason: "watched" });
    db.excludeSeason(rollingShowId, 3);

    assert.match((await services.expandSeasonManually(rollingShowId, 1)).message, /already expanded/);
    assert.match((await services.expandSeasonManually(rollingShowId, 3)).message, /excluded\. Include it first/);
    assert.match((await services.expandSeasonManually(rollingShowId, 4)).message, /does not exist in Sonarr/);
    assert.equal((await services.expandSeasonManually(rollingShowId, 0)).ok, false);
    const operation = operations.acquireSeriesOperation(SERIES_ID)!;
    try {
      assert.match((await services.expandSeasonManually(rollingShowId, 2)).message, /Another operation/);
    } finally {
      operations.releaseSeriesOperation(SERIES_ID, operation);
    }

    assert.deepEqual(harness.writes(), []);
    assert.deepEqual(harness.expandedSeasons(), [1]);
  } finally {
    harness.cleanup();
  }
});

test("a dry-run Expand records the planned expansion without changing Sonarr or expanded seasons", async () => {
  const harness = createHarness({ enroll: true, settings: { dryRun: true } });
  try {
    const result = await harness.services.expandSeasonManually(harness.rollingShowId, 2);

    assert.equal(result.ok, true);
    assert.match(result.message, /Dry run/);
    assert.deepEqual(harness.writes(), []);
    assert.deepEqual(harness.expandedSeasons(), []);
    assert.deepEqual(harness.reasons(), []);
    assert.deepEqual(harness.expandHistory().map(({ action, reason }) => ({ action, reason })), [{ action: "dry_run.sonarr.expand_season", reason: "manual" }]);
  } finally {
    harness.cleanup();
  }
});

test("a manually expanded season nobody watches shows its trim date and is trimmed after the cleanup delay", async () => {
  const harness = createHarness({ enroll: true });
  try {
    await harness.services.expandSeasonManually(harness.rollingShowId, 2);
    let season = (await harness.services.getShowDetail(SERIES_ID)).seasons.find((item) => item.seasonNumber === 2)!;
    // No timer until the reconcile notices the season has no viewer.
    assert.equal(season.expansion?.reason, "manual");
    assert.equal(season.expansion?.trimsAt, null);

    await harness.services.reconcileRollingShows();
    assert.deepEqual(harness.expandedSeasons(), [2]);
    const inactiveSince = harness.db.getSeasonInactiveSince(harness.rollingShowId, 2)!;
    season = (await harness.services.getShowDetail(SERIES_ID)).seasons.find((item) => item.seasonNumber === 2)!;
    assert.equal(season.expansion?.trimsAt, new Date(Date.parse(inactiveSince) + 7 * DAY_MS).toISOString());

    harness.ageInactivity(2, 8);
    await harness.services.reconcileRollingShows();
    assert.deepEqual(harness.expandedSeasons(), []);
    assert.deepEqual(harness.reasons(), []);
    assert.equal(harness.episodes.filter((episode) => episode.seasonNumber === 2 && episode.episodeNumber > 1).some((episode) => episode.monitored), false);
  } finally {
    harness.cleanup();
  }
});

test("triage enrolment keeps the requested season expanded, searches it once and records it as requested", async () => {
  const harness = createHarness({ monitoredSeasons: [1] });
  try {
    harness.enableTriage();
    await harness.services.triageNewSonarrSeries();

    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.deepEqual(harness.reasons(), [[1, "requested"]]);
    const season1 = harness.episodes.filter((episode) => episode.seasonNumber === 1);
    // Never unmonitored and monitored again: the baseline retains it from the start.
    assert.equal(harness.unmonitoredEpisodeIds().some((id) => season1.some((episode) => episode.id === id)), false);
    assert.equal(season1.every((episode) => episode.monitored), true);
    // One SeasonSearch for the requested season; the other seasons get the pilot baseline.
    assert.deepEqual(harness.commands(), [
      { name: "EpisodeSearch", episodeIds: [9021, 9031] },
      { name: "SeasonSearch", seriesId: SERIES_ID, seasonNumber: 1 },
    ]);
    assert.deepEqual(harness.episodes.filter((episode) => episode.monitored && episode.seasonNumber > 1).map((episode) => episode.id), [9021, 9031]);
    assert.deepEqual(harness.expandHistory().map(({ action, source, reason }) => ({ action, source, reason })), [
      { action: "sonarr.expand_season", source: "auto-triage", reason: "requested" },
    ]);
  } finally {
    harness.cleanup();
  }
});

test("a requested season nobody watches is trimmed to its pilot after the cleanup delay, and a viewer keeps it", async () => {
  const harness = createHarness({ monitoredSeasons: [1, 2] });
  try {
    harness.enableTriage();
    await harness.services.triageNewSonarrSeries();
    assert.deepEqual(harness.reasons(), [[1, "requested"], [2, "requested"]]);

    const [viewer] = harness.db.upsertUsers([
      { plexUserId: "plex-viewer", plexAccountId: "42", tautulliUserId: null, username: "viewer", displayName: "Viewer", avatarUrl: null },
    ]);
    harness.db.updateUser(viewer!.id, { enabled: true });
    harness.db.upsertRollingUserProgress(harness.rolling()!.id, viewer!.id, 2, 1, new Date().toISOString());

    harness.ageInactivity(1, 8);
    harness.ageInactivity(2, 8);
    await harness.services.reconcileRollingShows();

    // Season 1 timed out; season 2 is held by the viewer who started it.
    assert.deepEqual(harness.expandedSeasons(), [2]);
    assert.deepEqual(harness.reasons(), [[2, "requested"]]);
    assert.equal(harness.episodes.filter((episode) => episode.seasonNumber === 1).map((episode) => episode.monitored).join(), "true,false,false");
  } finally {
    harness.cleanup();
  }
});

test("triage enrolment of a series with every season monitored applies the plain pilot baseline", async () => {
  const harness = createHarness({ monitoredSeasons: [1, 2, 3] });
  try {
    harness.enableTriage();
    await harness.services.triageNewSonarrSeries();

    assert.deepEqual(harness.expandedSeasons(), []);
    assert.deepEqual(harness.commands(), [{ name: "EpisodeSearch", episodeIds: [9011, 9021, 9031] }]);
    assert.deepEqual(harness.episodes.filter((episode) => episode.monitored).map((episode) => episode.id), [9011, 9021, 9031]);
    assert.deepEqual(harness.expandHistory(), []);
  } finally {
    harness.cleanup();
  }
});

test("a manual enrolment keeps today's pilot baseline even when some seasons are monitored", async () => {
  const harness = createHarness({ monitoredSeasons: [1] });
  try {
    await harness.services.enrollShow(SERIES_ID, { applyBaseline: true, importHistory: false });

    assert.deepEqual(harness.expandedSeasons(), []);
    assert.deepEqual(harness.commands(), [{ name: "EpisodeSearch", episodeIds: [9011, 9021, 9031] }]);
    assert.deepEqual(harness.episodes.filter((episode) => episode.monitored).map((episode) => episode.id), [9011, 9021, 9031]);
  } finally {
    harness.cleanup();
  }
});
