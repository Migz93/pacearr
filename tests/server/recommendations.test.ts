import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { ImageCacheService } from "../../src/server/image-cache.js";
import { PacearrServices } from "../../src/server/services.js";
import type { Logger } from "../../src/server/logger.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import type { SonarrEpisode, SonarrEpisodeFile, SonarrSeries } from "../../src/shared/types.js";

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function createHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-recommend-test-"));
  const config: RuntimeConfig = {
    port: 9302,
    dataDir: dir,
    sessionCookieName: "pacearr_test",
    sessionTtlMs: 1000,
    logLevel: "error",
  };
  const db = new PacearrDatabase(config);
  const logger = silentLogger();
  const imageCache = new ImageCacheService(dir, logger);
  const services = new PacearrServices(db, logger, imageCache, dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.updateAppSettings({ recommendationMinimumSavingsGb: 0 });
  return { db, services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function emptyPlexHistoryXml() {
  return new Response('<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>', {
    status: 200,
    headers: { "content-type": "application/xml" },
  });
}

function installFetchStub(routes: {
  series?: SonarrSeries[];
  seriesById?: Record<number, SonarrSeries>;
  episodesBySeries?: Record<number, SonarrEpisode[]>;
  episodeFilesBySeries?: Record<number, SonarrEpisodeFile[]>;
}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "plex" && url.pathname === "/status/sessions/history/all") return emptyPlexHistoryXml();
    if (url.pathname === "/api/v3/series") return jsonResponse(routes.series ?? []);
    const byIdMatch = url.pathname.match(/^\/api\/v3\/series\/(\d+)$/);
    if (byIdMatch) {
      const series = routes.seriesById?.[Number(byIdMatch[1])];
      if (series) return jsonResponse(series);
    }
    if (url.pathname === "/api/v3/episode") {
      const seriesId = Number(url.searchParams.get("seriesId"));
      return jsonResponse(routes.episodesBySeries?.[seriesId] ?? []);
    }
    if (url.pathname === "/api/v3/episodefile") {
      const seriesId = Number(url.searchParams.get("seriesId"));
      return jsonResponse(routes.episodeFilesBySeries?.[seriesId] ?? []);
    }
    throw new Error(`Unhandled fetch in test: ${url.toString()}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

test("watch events for non-enrolled shows are matched against the full Sonarr library during history import", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  const theWire: SonarrSeries = { id: 700, title: "The Wire", year: 2002, seasons: [] };
  const restoreFetch = installFetchStub({ series: [theWire] });
  try {
    const stored = db.insertWatchEvent({
      source: "plex-history",
      sourceEventId: "unmatched-1",
      userId: null,
      plexAccountId: "1",
      username: "alice",
      sonarrSeriesId: null,
      showTitle: "the wire",
      seasonNumber: 1,
      episodeNumber: 1,
      watchedAt: "2026-04-01T10:00:00.000Z",
      rawPayload: {},
    });
    assert.equal(stored.inserted, true);
    assert.equal(db.listUnmatchedWatchEvents().length, 1);

    await services.importHistory();

    assert.equal(db.listUnmatchedWatchEvents().length, 0);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("full history reconciliation leaves incremental source cursors unchanged", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.saveHistorySyncState({
    plex: { backfillComplete: true, cursor: "2026-04-01T10:00:00.000Z" },
    tautulli: { backfillComplete: false, cursor: null },
  });
  const restoreFetch = installFetchStub({ series: [] });
  try {
    const result = await services.reconcileFullHistory();
    assert.equal(result.ok, true);
    assert.equal(result.fetched, 0);
    assert.deepEqual(db.getHistorySyncState(), {
      plex: { backfillComplete: true, cursor: "2026-04-01T10:00:00.000Z" },
      tautulli: { backfillComplete: false, cursor: null },
    });
    assert.equal(db.listHistory(1)[0]?.action, "history.full_reconcile");
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("enrolling a show seeds rolling progress from watch history that was already matched before enrollment", async () => {
  const { db, services, cleanup } = createHarness();
  const [user] = db.upsertUsers([{ plexUserId: "plex-1", plexAccountId: "1", tautulliUserId: null, username: "bob", displayName: "Bob", avatarUrl: null }]);
  db.updateUser(user.id, { enabled: true, tautulliUserId: null });

  const fringe: SonarrSeries = { id: 800, title: "Fringe", year: 2008, seasons: [] };
  const restoreFetch = installFetchStub({ seriesById: { 800: fringe } });
  try {
    // Simulate matching having already happened via a routine history-import run,
    // long before the show is enrolled.
    db.insertWatchEvent({
      source: "plex-history",
      sourceEventId: "pre-matched-1",
      userId: user.id,
      plexAccountId: "1",
      username: "bob",
      sonarrSeriesId: 800,
      showTitle: "Fringe",
      seasonNumber: 2,
      episodeNumber: 4,
      watchedAt: "2026-04-05T10:00:00.000Z",
      rawPayload: {},
    });

    const result = await services.enrollShow(800, { applyBaseline: false, importHistory: false });
    assert.equal(result.ok, true);

    const rolling = db.getRollingShowBySeriesId(800);
    assert.ok(rolling);
    const progress = db.listProgressForShow(rolling!.id);
    assert.equal(progress.length, 1);
    assert.equal(progress[0]?.userId, user.id);
    assert.equal(progress[0]?.lastWatchedSeason, 2);
    assert.equal(progress[0]?.lastWatchedEpisode, 4);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("reset and unenrolment are blocked while asynchronous enrollment setup is pending", async () => {
  const { services, cleanup } = createHarness();
  const fringe: SonarrSeries = { id: 801, title: "Fringe", year: 2008, seasons: [] };
  const restoreFetch = installFetchStub({ seriesById: { 801: fringe } });
  try {
    const enrollment = await services.beginEnrollment(801, { applyBaseline: false, importHistory: false });
    const reset = await services.resetShow(enrollment.rolling.id);
    const remove = await services.removeShow(enrollment.rolling.id);

    assert.equal(reset.ok, false);
    assert.equal(remove.ok, false);
    assert.match(reset.message, /still running/);
    assert.match(remove.message, /still running/);

    await services.completeEnrollment(enrollment.series, enrollment.rolling, { applyBaseline: false, importHistory: false });
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("listRecommendations computes precise per-season savings, excludes enrolled/fully-retained shows, and sorts by savings descending", async () => {
  const { db, services, cleanup } = createHarness();

  // Candidate A: no watchers, both seasons drop to pilot-only. Bigger savings.
  const showA: SonarrSeries = {
    id: 500,
    title: "Warehouse 13",
    year: 2009,
    seasons: [
      { seasonNumber: 1, monitored: true, statistics: { episodeCount: 2, totalEpisodeCount: 2, sizeOnDisk: 2_000_000_000 } },
      { seasonNumber: 2, monitored: true, statistics: { episodeCount: 2, totalEpisodeCount: 2, sizeOnDisk: 3_000_000_000 } },
    ],
    statistics: { sizeOnDisk: 5_000_000_000 },
  };
  const episodesA: SonarrEpisode[] = [
    { id: 101, seriesId: 500, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 9001 },
    { id: 102, seriesId: 500, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: 9002 },
    { id: 201, seriesId: 500, seasonNumber: 2, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 9003 },
    { id: 202, seriesId: 500, seasonNumber: 2, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: 9004 },
  ];
  const episodeFilesA: SonarrEpisodeFile[] = [
    { id: 9001, seriesId: 500, seasonNumber: 1, size: 900_000_000 },
    { id: 9002, seriesId: 500, seasonNumber: 1, size: 1_100_000_000 },
    { id: 9003, seriesId: 500, seasonNumber: 2, size: 1_400_000_000 },
    { id: 9004, seriesId: 500, seasonNumber: 2, size: 1_600_000_000 },
  ];

  // Candidate B: an enabled user actively watching season 2, so season 1 drops
  // but season 2 is retained. Smaller savings than A.
  db.upsertUsers([{ plexUserId: "plex-2", plexAccountId: "2", tautulliUserId: null, username: "carol", displayName: "Carol", avatarUrl: null }]);
  const user = db.listUsers().find((candidate) => candidate.username === "carol")!;
  db.updateUser(user.id, { enabled: true, tautulliUserId: null });
  const showB: SonarrSeries = {
    id: 600,
    title: "Continuum",
    year: 2012,
    seasons: [
      { seasonNumber: 1, monitored: true, statistics: { episodeCount: 1, totalEpisodeCount: 1, sizeOnDisk: 500_000_000 } },
      { seasonNumber: 2, monitored: true, statistics: { episodeCount: 1, totalEpisodeCount: 1, sizeOnDisk: 500_000_000 } },
    ],
    statistics: { sizeOnDisk: 1_000_000_000 },
  };
  const episodesB: SonarrEpisode[] = [
    { id: 301, seriesId: 600, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 9101 },
    { id: 401, seriesId: 600, seasonNumber: 2, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 9102 },
  ];
  const episodeFilesB: SonarrEpisodeFile[] = [
    { id: 9101, seriesId: 600, seasonNumber: 1, size: 400_000_000 },
    { id: 9102, seriesId: 600, seasonNumber: 2, size: 400_000_000 },
  ];
  db.insertWatchEvent({
    source: "plex-history", sourceEventId: "continuum-1", userId: user.id, plexAccountId: "2", username: "carol",
    sonarrSeriesId: 600, showTitle: "Continuum", seasonNumber: 2, episodeNumber: 1,
    watchedAt: new Date().toISOString(), rawPayload: {},
  });

  // Candidate C: fully retained already (single season, actively watched) — should be excluded entirely.
  db.upsertUsers([{ plexUserId: "plex-3", plexAccountId: "3", tautulliUserId: null, username: "dave", displayName: "Dave", avatarUrl: null }]);
  const user2 = db.listUsers().find((candidate) => candidate.username === "dave")!;
  db.updateUser(user2.id, { enabled: true, tautulliUserId: null });
  const showC: SonarrSeries = {
    id: 650,
    title: "Firefly",
    year: 2002,
    seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 1, totalEpisodeCount: 1, sizeOnDisk: 300_000_000 } }],
    statistics: { sizeOnDisk: 300_000_000 },
  };
  const episodesC: SonarrEpisode[] = [
    { id: 501, seriesId: 650, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 9201 },
  ];
  db.insertWatchEvent({
    source: "plex-history", sourceEventId: "firefly-1", userId: user2.id, plexAccountId: "3", username: "dave",
    sonarrSeriesId: 650, showTitle: "Firefly", seasonNumber: 1, episodeNumber: 1,
    watchedAt: new Date().toISOString(), rawPayload: {},
  });

  // Candidate D: already enrolled — must be excluded regardless of its data.
  const showD: SonarrSeries = {
    id: 700,
    title: "Enrolled Show",
    year: 2015,
    seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 1, totalEpisodeCount: 1, sizeOnDisk: 10_000_000_000 } }],
    statistics: { sizeOnDisk: 10_000_000_000 },
  };
  db.upsertRollingShow(showD);

  const restoreFetch = installFetchStub({
    series: [showA, showB, showC, showD],
    episodesBySeries: { 500: episodesA, 600: episodesB, 650: episodesC },
    episodeFilesBySeries: { 500: episodeFilesA, 600: episodeFilesB },
  });

  try {
    await services.refreshRecommendations();
    const result = services.listRecommendations();
    assert.ok(result.generatedAt);

    assert.deepEqual(result.candidates.map((candidate) => candidate.sonarrSeriesId), [500, 600]);

    const [candidateA, candidateB] = result.candidates;
    assert.deepEqual(candidateA!.retainedSeasons, []);
    assert.deepEqual(candidateA!.droppedSeasons, [1, 2]);
    assert.equal(candidateA!.projectedSavingsBytes, 1_100_000_000 + 1_600_000_000);
    assert.equal(candidateA!.watcherCount, 0);

    assert.deepEqual(candidateB!.retainedSeasons, [2]);
    assert.deepEqual(candidateB!.droppedSeasons, [1]);
    assert.equal(candidateB!.projectedSavingsBytes, 100_000_000);
    assert.equal(candidateB!.watcherCount, 1);
    assert.equal(candidateA!.ignored, false);
    assert.equal(result.ignoredCount, 0);

    assert.ok(!result.candidates.some((candidate) => candidate.sonarrSeriesId === 650), "fully-retained show should be excluded");
    assert.ok(!result.candidates.some((candidate) => candidate.sonarrSeriesId === 700), "already-enrolled show should be excluded");

    db.updateAppSettings({ recommendationMinimumSavingsGb: 1 });
    const cutoffResult = services.listRecommendations();
    assert.deepEqual(cutoffResult.candidates.map((candidate) => candidate.sonarrSeriesId), [500]);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("ignored recommendations are persistent, hidden by default, and can be restored", async () => {
  const { db, services, cleanup } = createHarness();
  const show: SonarrSeries = {
    id: 900,
    title: "Never Watching",
    seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 2, totalEpisodeCount: 2, sizeOnDisk: 1_000 } }],
  };
  const restoreFetch = installFetchStub({
    series: [show],
    episodesBySeries: {
      900: [
        { id: 1, seriesId: 900, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 1 },
        { id: 2, seriesId: 900, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: 2 },
      ],
    },
    episodeFilesBySeries: { 900: [{ id: 1, seriesId: 900, seasonNumber: 1, size: 400 }] },
  });

  try {
    await services.refreshRecommendations();
    services.ignoreRecommendation(900, show.title);
    const hidden = services.listRecommendations();
    assert.deepEqual(hidden.candidates, []);
    assert.equal(hidden.ignoredCount, 1);

    const included = services.listRecommendations(true);
    assert.equal(included.candidates[0]?.ignored, true);

    services.unignoreRecommendation(900);
    const restored = services.listRecommendations();
    assert.equal(restored.candidates[0]?.ignored, false);
    assert.equal(restored.ignoredCount, 0);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("Sonarr library refresh persists shows for synchronous cached listing", async () => {
  const { services, cleanup } = createHarness();
  const show: SonarrSeries = {
    id: 901,
    title: "Cached Show",
    year: 2020,
    seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 8, totalEpisodeCount: 8, sizeOnDisk: 1_000 } }],
  };
  const restoreFetch = installFetchStub({ series: [show] });
  try {
    await services.refreshSonarrLibrary();
    restoreFetch();

    const cached = services.listShows();
    assert.equal(cached.length, 1);
    assert.equal(cached[0]?.title, "Cached Show");
    assert.equal(cached[0]?.seasonCount, 1);
    assert.equal(cached[0]?.episodeCount, 8);
  } finally {
    // restoreFetch is idempotent enough for cleanup if the assertion above fails
    restoreFetch();
    cleanup();
  }
});
