import assert from "node:assert/strict";
import crypto from "node:crypto";
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

function createHarness(logger: Logger = silentLogger()) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-recommend-test-"));
  const config: RuntimeConfig = {
    port: 9302,
    dataDir: dir,
    sessionCookieName: "pacearr_test",
    sessionTtlMs: 1000,
    logLevel: "error",
  };
  const db = new PacearrDatabase(config);
  const imageCache = new ImageCacheService(dir, logger);
  const services = new PacearrServices(db, logger, imageCache, dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.updateAppSettings({ recommendationMinimumSavingsGb: 0 });
  return { db, services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function sourceIdentityScope(secret: string, ...connectionValues: string[]) {
  return crypto.scryptSync(JSON.stringify(connectionValues), secret, 16).toString("hex");
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
  episodeFileErrorsBySeries?: Record<number, string>;
  plexHistoryXml?: string;
  plexMetadataXml?: string;
  plexTitleSearchXml?: string;
  tautulliHistory?: unknown[];
  tautulliMetadata?: unknown;
  tautulliMetadataError?: boolean;
  requests?: Array<{ method: string; pathname: string; search?: string; body?: string }>;
}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    routes.requests?.push({ method: (init?.method ?? "GET").toUpperCase(), pathname: url.pathname, search: url.search, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.hostname.startsWith("plex") && url.pathname === "/status/sessions/history/all") {
      return routes.plexHistoryXml
        ? new Response(routes.plexHistoryXml, { status: 200, headers: { "content-type": "application/xml" } })
        : emptyPlexHistoryXml();
    }
    if (url.hostname.startsWith("plex") && url.pathname.startsWith("/library/metadata/")) {
      return new Response(routes.plexMetadataXml ?? '<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>', { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.hostname.startsWith("plex") && url.pathname.startsWith("/library/sections/") && url.pathname.endsWith("/all")) {
      return new Response(routes.plexTitleSearchXml ?? '<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>', { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.hostname.startsWith("tautulli") && url.pathname === "/api/v2" && url.searchParams.get("cmd") === "get_history") {
      return jsonResponse({ response: { result: "success", data: { data: routes.tautulliHistory ?? [] } } });
    }
    if (url.hostname.startsWith("tautulli") && url.pathname === "/api/v2" && url.searchParams.get("cmd") === "get_metadata") {
      if (routes.tautulliMetadataError) return new Response(JSON.stringify({ response: { result: "error", message: "unavailable" } }), { status: 503, headers: { "content-type": "application/json" } });
      return jsonResponse({ response: { result: "success", data: routes.tautulliMetadata ?? {} } });
    }
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
      const error = routes.episodeFileErrorsBySeries?.[seriesId];
      if (error) return new Response(JSON.stringify({ message: error }), { status: 404, headers: { "content-type": "application/json" } });
      return jsonResponse(routes.episodeFilesBySeries?.[seriesId] ?? []);
    }
    if ((init?.method ?? "GET").toUpperCase() !== "GET") return jsonResponse({});
    throw new Error(`Unhandled fetch in test: ${url.toString()}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

test("stored watch events are not associated by title alone during history import", async () => {
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

    assert.equal(db.listUnmatchedWatchEvents().length, 1);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("history import reuses the cached Sonarr library instead of fetching it again", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  const theWire: SonarrSeries = { id: 701, title: "The Wire", year: 2002, seasons: [] };
  db.saveSonarrLibraryCache([{ series: theWire, posterUrl: null }]);
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const restoreFetch = installFetchStub({ requests });
  try {
    await services.importHistory();

    assert.equal(requests.some((request) => request.pathname === "/api/v3/series"), false);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("Tautulli history resolves through its own rating-key metadata, not its title", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.saveTautulliSettings({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" });
  const [viewer] = db.upsertUsers([{ plexUserId: "viewer", plexAccountId: "1", tautulliUserId: "7", username: "viewer", displayName: "Viewer", avatarUrl: null }]);
  const series: SonarrSeries = { id: 5810, title: "Gold Rush", tvdbId: 208111, imdbId: "tt1800864", seasons: [] };
  const restoreFetch = installFetchStub({
    series: [series],
    tautulliHistory: [{ reference_id: "tautulli-gold", user_id: 7, username: "viewer", user: "Viewer", grandparent_title: "Gold Rush: Alaska", parent_media_index: 16, media_index: 23, date: 1784220000, rating_key: "episode", grandparent_rating_key: "118306" }],
    tautulliMetadata: { guids: ["imdb://tt1800864", "tvdb://208111"] },
  });
  try {
    await services.importHistory();
    assert.deepEqual(db.listLatestUserProgressForSeries(5810).map((item) => item.userId), [viewer!.id]);
    assert.equal(db.getSourceIdentity("tautulli", `${sourceIdentityScope(db.getSessionSecret(), "http://tautulli:8181", "secret")}:rating:118306`)?.status, "resolved");
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("history import rejects a non-unique Sonarr external ID", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.saveTautulliSettings({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" });
  db.upsertUsers([{ plexUserId: "viewer", plexAccountId: "1", tautulliUserId: "7", username: "viewer", displayName: "Viewer", avatarUrl: null }]);
  const restoreFetch = installFetchStub({
    series: [
      { id: 5810, title: "Gold Rush", tvdbId: 208111, seasons: [] },
      { id: 5811, title: "Different Gold Rush", tvdbId: 208111, seasons: [] },
    ],
    tautulliHistory: [{ reference_id: "duplicate-tvdb", user_id: 7, username: "viewer", user: "Viewer", grandparent_title: "Gold Rush: Alaska", parent_media_index: 16, media_index: 23, date: 1784220000, rating_key: "episode", grandparent_rating_key: "118306" }],
    tautulliMetadata: { guids: ["tvdb://208111"] },
  });
  try {
    const result = await services.importHistory();

    assert.equal(result.matched, 0);
    assert.equal(db.listUnmatchedWatchEvents().length, 1);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("history import rechecks a stale missing source identity", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.saveTautulliSettings({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" });
  db.upsertUsers([{ plexUserId: "viewer", plexAccountId: "1", tautulliUserId: "7", username: "viewer", displayName: "Viewer", avatarUrl: null }]);
  db.saveSourceIdentity("tautulli", `${sourceIdentityScope(db.getSessionSecret(), "http://tautulli:8181", "secret")}:rating:118306`, { status: "missing", tvdbId: null, imdbId: null }, new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString());
  const series: SonarrSeries = { id: 5810, title: "Gold Rush", tvdbId: 208111, seasons: [] };
  const restoreFetch = installFetchStub({
    series: [series],
    tautulliHistory: [{ reference_id: "stale-missing", user_id: 7, username: "viewer", user: "Viewer", grandparent_title: "Gold Rush: Alaska", parent_media_index: 16, media_index: 23, date: 1784220000, rating_key: "episode", grandparent_rating_key: "118306" }],
    tautulliMetadata: { guids: ["tvdb://208111"] },
  });
  try {
    const result = await services.importHistory();

    assert.equal(result.matched, 1);
    assert.equal(db.getSourceIdentity("tautulli", `${sourceIdentityScope(db.getSessionSecret(), "http://tautulli:8181", "secret")}:rating:118306`)?.status, "resolved");
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("history import stops source identity lookups after repeated metadata failures", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.saveTautulliSettings({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" });
  const requests: Array<{ method: string; pathname: string; search?: string; body?: string }> = [];
  const restoreFetch = installFetchStub({
    requests,
    tautulliMetadataError: true,
    tautulliHistory: ["1", "2", "3", "4", "5"].map((grandparent_rating_key) => ({
      reference_id: `failure-${grandparent_rating_key}`,
      user_id: 7,
      username: "viewer",
      user: "Viewer",
      grandparent_title: "Unavailable Show",
      parent_media_index: 1,
      media_index: 1,
      date: 1784220000,
      rating_key: `episode-${grandparent_rating_key}`,
      grandparent_rating_key,
    })),
  });
  try {
    const result = await services.importHistory();

    assert.equal(result.unmatched, 5);
    assert.equal(requests.filter((request) => request.search?.includes("cmd=get_metadata")).length, 3);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("history import rechecks a reused Tautulli rating key after its connection changes", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  const series: SonarrSeries = { id: 5810, title: "Gold Rush", tvdbId: 208111, seasons: [] };
  const history = [{ reference_id: "reused-rating-key", user_id: 7, username: "viewer", user: "Viewer", grandparent_title: "Gold Rush: Alaska", parent_media_index: 16, media_index: 23, date: 1784220000, rating_key: "episode", grandparent_rating_key: "118306" }];
  db.saveTautulliSettings({ enabled: true, baseUrl: "http://tautulli-one:8181", apiKey: "first-secret" });
  const firstFetch = installFetchStub({ series: [series], tautulliHistory: history, tautulliMetadata: { guids: ["tvdb://208111"] } });
  try {
    await services.importHistory();
  } finally {
    firstFetch();
  }
  db.saveTautulliSettings({ enabled: true, baseUrl: "http://tautulli-two:8181", apiKey: "second-secret" });
  const requests: Array<{ method: string; pathname: string; search?: string; body?: string }> = [];
  const secondFetch = installFetchStub({ series: [series], tautulliHistory: history, tautulliMetadata: { guids: ["tvdb://208111"] }, requests });
  try {
    await services.reconcileFullHistory();

    assert.equal(requests.filter((request) => request.search?.includes("cmd=get_metadata")).length, 1);
  } finally {
    secondFetch();
    cleanup();
  }
});

test("history import rechecks a reused Plex rating key after its connection changes", async () => {
  const { db, services, cleanup } = createHarness();
  const series: SonarrSeries = { id: 5810, title: "Gold Rush", tvdbId: 208111, seasons: [] };
  const history = `<?xml version="1.0"?><MediaContainer size="1"><Video type="episode" grandparentTitle="Gold Rush: Alaska" parentIndex="16" index="23" viewedAt="1784220000" historyKey="reused-rating-key" ratingKey="episode" grandparentRatingKey="118306" accountID="1" user="viewer"/></MediaContainer>`;
  const metadata = '<?xml version="1.0"?><MediaContainer><Directory><Guid id="tvdb://208111" /></Directory></MediaContainer>';
  db.savePlexSettings({ serverUrl: "http://plex-one:32400", machineIdentifier: "plex-one", token: "first-token" });
  const firstFetch = installFetchStub({ series: [series], plexHistoryXml: history, plexMetadataXml: metadata });
  try {
    await services.importHistory();
  } finally {
    firstFetch();
  }
  db.savePlexSettings({ serverUrl: "http://plex-two:32400", machineIdentifier: "plex-two", token: "second-token" });
  const requests: Array<{ method: string; pathname: string; search?: string; body?: string }> = [];
  const secondFetch = installFetchStub({ series: [series], plexHistoryXml: history, plexMetadataXml: metadata, requests });
  try {
    await services.reconcileFullHistory();

    assert.equal(requests.filter((request) => request.pathname === "/library/metadata/118306").length, 1);
  } finally {
    secondFetch();
    cleanup();
  }
});

test("sparse Plex history resolves through candidate metadata, not its title", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.upsertUsers([{ plexUserId: "viewer", plexAccountId: "1", tautulliUserId: null, username: "viewer", displayName: "Viewer", avatarUrl: null }]);
  const series: SonarrSeries = { id: 5810, title: "Gold Rush", tvdbId: 208111, seasons: [] };
  const history = '<?xml version="1.0"?><MediaContainer size="1"><Video type="episode" grandparentTitle="Gold Rush: Alaska" parentIndex="16" index="23" viewedAt="1784220000" historyKey="sparse-title" ratingKey="episode" librarySectionID="5" accountID="1" user="viewer"/></MediaContainer>';
  const requests: Array<{ method: string; pathname: string; search?: string; body?: string }> = [];
  const restoreFetch = installFetchStub({
    series: [series],
    plexHistoryXml: history,
    plexTitleSearchXml: '<?xml version="1.0"?><MediaContainer><Directory type="show" ratingKey="118306" title="Gold Rush: Alaska" /></MediaContainer>',
    plexMetadataXml: '<?xml version="1.0"?><MediaContainer><Directory><Guid id="tvdb://208111" /></Directory></MediaContainer>',
    requests,
  });
  try {
    const result = await services.importHistory();

    assert.equal(requests.some((request) => request.pathname === "/library/sections/5/all"), true);
    assert.equal(requests.some((request) => request.pathname === "/library/metadata/118306"), true);
    assert.equal(result.matched, 1);
    assert.equal(db.listUnmatchedWatchEvents().length, 0);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("sparse Plex history leaves ambiguous title-search candidates unmatched", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  const series: SonarrSeries = { id: 5810, title: "Gold Rush", tvdbId: 208111, seasons: [] };
  const history = '<?xml version="1.0"?><MediaContainer size="1"><Video type="episode" grandparentTitle="Gold Rush: Alaska" parentIndex="16" index="23" viewedAt="1784220000" historyKey="ambiguous-title" ratingKey="episode" librarySectionID="5" accountID="1" user="viewer"/></MediaContainer>';
  const requests: Array<{ method: string; pathname: string; search?: string; body?: string }> = [];
  const restoreFetch = installFetchStub({
    series: [series],
    plexHistoryXml: history,
    plexTitleSearchXml: '<?xml version="1.0"?><MediaContainer><Directory type="show" ratingKey="118306" title="Gold Rush: Alaska" /><Directory type="show" ratingKey="118307" title="Gold Rush: Alaska" /></MediaContainer>',
    requests,
  });
  try {
    const result = await services.importHistory();

    assert.equal(result.matched, 0);
    assert.equal(db.listUnmatchedWatchEvents().length, 1);
    assert.equal(requests.some((request) => request.pathname.startsWith("/library/metadata/")), false);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("history import batches events outside the activity window while still applying rolling logic to recent ones", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.updateAppSettings({ dryRun: false, viewerActivityWindowDays: 30 });
  const [user] = db.upsertUsers([{ plexUserId: "plex-batch", plexAccountId: "1", tautulliUserId: null, username: "batchuser", displayName: "Batch User", avatarUrl: null }]);
  db.updateUser(user!.id, { enabled: true });

  const series: SonarrSeries = {
    id: 950,
    title: "Rolling Test",
    tvdbId: 9500,
    monitored: true,
    monitorNewItems: "none",
    seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: false }],
  };
  const episodes: SonarrEpisode[] = [
    { id: 9501, seriesId: 950, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 95001 },
    { id: 9502, seriesId: 950, seasonNumber: 2, episodeNumber: 1, monitored: false, hasFile: true, episodeFileId: 95003 },
  ];
  db.upsertRollingShow(series);

  const recentUnix = Math.floor((Date.now() - 1 * 24 * 60 * 60 * 1000) / 1000);
  const oldUnix = Math.floor((Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000);
  const plexHistoryXml = `<?xml version="1.0"?>
    <MediaContainer size="2">
      <Video type="episode" grandparentTitle="Rolling Test" parentIndex="1" index="1" viewedAt="${recentUnix}" historyKey="hk-recent" ratingKey="rk-recent" grandparentRatingKey="grk" accountID="1" user="batchuser"/>
      <Video type="episode" grandparentTitle="Rolling Test" parentIndex="2" index="1" viewedAt="${oldUnix}" historyKey="hk-old" ratingKey="rk-old" grandparentRatingKey="grk" accountID="1" user="batchuser"/>
    </MediaContainer>`;
  const restoreFetch = installFetchStub({
    series: [series],
    seriesById: { 950: series },
    episodesBySeries: { 950: episodes },
    episodeFilesBySeries: { 950: [] },
    plexHistoryXml,
    plexMetadataXml: '<?xml version="1.0"?><MediaContainer><Directory><Guid id="tvdb://9500" /></Directory></MediaContainer>',
  });
  try {
    const result = await services.importHistory();

    assert.equal(result.ok, true);
    assert.equal(result.processed, 2);
    assert.equal(result.imported, 2);
    assert.equal(result.matched, 2);
    assert.equal(result.unmatched, 0);

    // The recent event (S1E1) went through the Sonarr-touching path and expanded
    // season 1. The old event (S2E1) was routed to the batched insert-only path and
    // must not have triggered any rolling logic - season 2 stays un-expanded.
    const rolling = db.getRollingShowBySeriesId(950);
    assert.deepEqual(rolling?.expandedSeasons, [1]);

    const stored = db.listLatestUserProgressForSeries(950);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.seasonNumber, 1);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("a full history reconciliation repairs a previously orphaned Tautulli event and refreshes rolling progress", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.updateAppSettings({ dryRun: false });
  db.saveTautulliSettings({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" });
  const [dave] = db.upsertUsers([{ plexUserId: "plex-dave", plexAccountId: "4", tautulliUserId: null, username: "dave_plex", displayName: "Dave", avatarUrl: null }]);
  db.updateUser(dave!.id, { enabled: true });

  const series: SonarrSeries = { id: 960, title: "Repair Test", monitored: true, monitorNewItems: "none", seasons: [{ seasonNumber: 1, monitored: true }] };
  db.upsertRollingShow(series);

  // Simulates a row imported before #75's fix: Tautulli's friendly name at the time didn't
  // resolve to any Pacearr user, so it landed with user_id = NULL.
  const stored = db.insertWatchEvent({
    source: "tautulli", sourceEventId: "ref-orphan-1", userId: null, plexAccountId: null, username: "Big Chief Dave",
    sonarrSeriesId: 960, showTitle: "Repair Test", seasonNumber: 1, episodeNumber: 2,
    watchedAt: "2026-04-01T10:00:00.000Z", rawPayload: {},
  });
  assert.equal(stored.inserted, true);

  const oldUnix = Math.floor(new Date("2026-04-01T10:00:00.000Z").getTime() / 1000);
  const restoreFetch = installFetchStub({
    series: [series],
    seriesById: { 960: series },
    episodesBySeries: { 960: [] },
    episodeFilesBySeries: { 960: [] },
    tautulliHistory: [{
      reference_id: "ref-orphan-1", user_id: 4, username: "dave_plex", user: "Big Chief Dave",
      grandparent_title: "Repair Test", parent_media_index: 1, media_index: 2, date: oldUnix,
      rating_key: "rk-1", grandparent_rating_key: "grk-1",
    }],
  });
  try {
    // A full reconciliation re-fetches this same event from Tautulli. It's still a
    // duplicate by (source, source_event_id), so it must be repaired in place rather than
    // relying on a fresh insert.
    const result = await services.reconcileFullHistory();

    assert.equal(result.ok, true);
    assert.deepEqual(db.listLatestWatchProgressForUser(dave!.id), [{ sonarrSeriesId: 960, seasonNumber: 1, episodeNumber: 2, watchedAt: "2026-04-01T10:00:00.000Z" }]);
    // Rolling progress must also be refreshed, not just the raw watch_events row.
    const progress = db.listProgressForShow(db.getRollingShowBySeriesId(960)!.id);
    assert.deepEqual(progress.map((item) => ({ userId: item.userId, season: item.lastWatchedSeason, episode: item.lastWatchedEpisode })), [{ userId: dave!.id, season: 1, episode: 2 }]);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("a full history reconciliation refreshes rolling progress after repairing an orphaned Plex series link", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.updateAppSettings({ dryRun: false });
  const [viewer] = db.upsertUsers([{ plexUserId: "plex-viewer", plexAccountId: "1", tautulliUserId: null, username: "viewer", displayName: "Viewer", avatarUrl: null }]);
  db.updateUser(viewer!.id, { enabled: true });
  const series: SonarrSeries = { id: 962, title: "Plex Repair Test", tvdbId: 9620, monitored: true, monitorNewItems: "none", seasons: [{ seasonNumber: 2, monitored: true }] };
  const rolling = db.upsertRollingShow(series);
  db.insertWatchEvent({
    source: "plex-history", sourceEventId: "plex-orphan-1", userId: viewer!.id, plexAccountId: "1", username: "viewer",
    sonarrSeriesId: null, showTitle: "Plex Repair Test", seasonNumber: 2, episodeNumber: 3,
    watchedAt: "2026-04-02T10:00:00.000Z", rawPayload: {},
  });
  const viewedAt = Math.floor(new Date("2026-04-02T10:00:00.000Z").getTime() / 1000);
  const restoreFetch = installFetchStub({
    series: [series],
    plexHistoryXml: `<?xml version="1.0"?><MediaContainer size="1"><Video type="episode" historyKey="plex-orphan-1" grandparentTitle="Plex Repair Test" parentIndex="2" index="3" viewedAt="${viewedAt}" grandparentRatingKey="plex-repair-show" accountID="1" user="viewer"/></MediaContainer>`,
    plexMetadataXml: '<?xml version="1.0"?><MediaContainer><Directory><Guid id="tvdb://9620" /></Directory></MediaContainer>',
  });
  try {
    const result = await services.reconcileFullHistory();

    assert.equal(result.ok, true);
    assert.equal(result.changed, 1);
    assert.deepEqual(db.listProgressForShow(rolling.id).map((item) => ({ userId: item.userId, season: item.lastWatchedSeason, episode: item.lastWatchedEpisode })), [
      { userId: viewer!.id, season: 2, episode: 3 },
    ]);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("manual Tautulli mapping refreshes rolling progress from relinked history", () => {
  const { db, services, cleanup } = createHarness();
  try {
    const [dave] = db.upsertUsers([{ plexUserId: "plex-dave", plexAccountId: "4", tautulliUserId: null, username: "dave", displayName: "Dave", avatarUrl: null }]);
    const rolling = db.upsertRollingShow({ id: 961, title: "Manual Mapping Test" });
    db.insertWatchEvent({
      source: "tautulli", sourceEventId: "manual-map-orphan", userId: null, plexAccountId: null, username: "Different Tautulli Name",
      sonarrSeriesId: 961, showTitle: "Manual Mapping Test", seasonNumber: 2, episodeNumber: 4,
      watchedAt: "2026-04-02T10:00:00.000Z", rawPayload: { user_id: 47 },
    });

    assert.deepEqual(services.mapTautulliUser(dave.id, "47", "Different Tautulli Name"), { linkedEvents: 1 });
    assert.deepEqual(db.listProgressForShow(rolling.id).map((item) => ({ userId: item.userId, season: item.lastWatchedSeason, episode: item.lastWatchedEpisode })), [
      { userId: dave.id, season: 2, episode: 4 },
    ]);
  } finally {
    cleanup();
  }
});

function rollingSeries(id: number): SonarrSeries {
  return {
    id,
    title: "Delay Test",
    monitored: true,
    monitorNewItems: "none",
    seasons: [{ seasonNumber: 1, monitored: true }],
  };
}

function rollingEpisodes(id: number): SonarrEpisode[] {
  return [
    { id: id * 10 + 1, seriesId: id, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: id * 100 + 1 },
    { id: id * 10 + 2, seriesId: id, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: id * 100 + 2 },
  ];
}

test("rolling reconciliation waits for the default seven-day inactivity delay", async () => {
  const { db, services, cleanup } = createHarness();
  const series = rollingSeries(901);
  const requests: Array<{ method: string; pathname: string }> = [];
  const restoreFetch = installFetchStub({ seriesById: { 901: series }, episodesBySeries: { 901: rollingEpisodes(901) }, episodeFilesBySeries: { 901: [] }, requests });
  try {
    db.updateAppSettings({ dryRun: false });
    const rolling = db.upsertRollingShow({ id: 901, title: series.title });
    db.markSeasonExpanded(rolling.id, 1, "2026-01-01T00:00:00.000Z");
    db.markSeasonInactive(rolling.id, 1, new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString());

    await services.reconcileRollingShows();

    assert.deepEqual(db.getRollingShow(rolling.id)?.expandedSeasons, [1]);
    assert.equal(requests.some((request) => request.method === "DELETE"), false);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("rolling reconciliation honours a custom delay and immediate cleanup at zero", async () => {
  const { db, services, cleanup } = createHarness();
  const series = rollingSeries(902);
  const requests: Array<{ method: string; pathname: string }> = [];
  const restoreFetch = installFetchStub({ seriesById: { 902: series }, episodesBySeries: { 902: rollingEpisodes(902) }, episodeFilesBySeries: { 902: [] }, requests });
  try {
    db.updateAppSettings({ dryRun: false, progressiveCleanupDelayDays: 3 });
    const rolling = db.upsertRollingShow({ id: 902, title: series.title });
    db.markSeasonExpanded(rolling.id, 1, "2026-01-01T00:00:00.000Z");
    db.markSeasonInactive(rolling.id, 1, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
    await services.reconcileRollingShows();
    assert.deepEqual(db.getRollingShow(rolling.id)?.expandedSeasons, [1]);

    db.updateAppSettings({ progressiveCleanupDelayDays: 0 });
    await services.reconcileRollingShows();
    assert.deepEqual(db.getRollingShow(rolling.id)?.expandedSeasons, []);
    assert.equal(requests.some((request) => request.method === "DELETE" && request.pathname.endsWith("/90202")), true);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("a returning active viewer clears an inactive season's cleanup timer", async () => {
  const { db, services, cleanup } = createHarness();
  const series = rollingSeries(903);
  const restoreFetch = installFetchStub({ seriesById: { 903: series }, episodesBySeries: { 903: rollingEpisodes(903) }, episodeFilesBySeries: { 903: [] } });
  try {
    db.updateAppSettings({ dryRun: false, progressiveCleanupDelayDays: 0 });
    const [user] = db.upsertUsers([{ plexUserId: "plex-delay", plexAccountId: "delay", tautulliUserId: null, username: "delay", displayName: "Delay", avatarUrl: null }]);
    db.updateUser(user.id, { enabled: true });
    const rolling = db.upsertRollingShow({ id: 903, title: series.title });
    db.markSeasonExpanded(rolling.id, 1, "2026-01-01T00:00:00.000Z");
    db.markSeasonInactive(rolling.id, 1, "2026-01-01T00:00:00.000Z");
    db.upsertRollingUserProgress(rolling.id, user.id, 1, 2, new Date().toISOString());

    await services.reconcileRollingShows();

    assert.deepEqual(db.getRollingShow(rolling.id)?.expandedSeasons, [1]);
    assert.equal(db.getSeasonInactiveSince(rolling.id, 1), null);
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
  db.updateUser(user.id, { enabled: true });

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

test("enrollment repairs and seeds previously unmatched history with a full verified source read", async () => {
  const { db, services, cleanup } = createHarness();
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  const [user] = db.upsertUsers([{ plexUserId: "plex-1", plexAccountId: "1", tautulliUserId: null, username: "bob", displayName: "Bob", avatarUrl: null }]);
  db.updateUser(user.id, { enabled: true });
  const fringe: SonarrSeries = { id: 802, title: "Fringe", tvdbId: 82066, year: 2008, seasons: [] };
  db.insertWatchEvent({
    source: "plex-history", sourceEventId: "pre-enrollment-orphan", userId: user.id, plexAccountId: "1", username: "bob",
    sonarrSeriesId: null, showTitle: "Fringe", seasonNumber: 2, episodeNumber: 4,
    watchedAt: "2026-04-05T10:00:00.000Z", rawPayload: {},
  });
  const viewedAt = Math.floor(new Date("2026-04-05T10:00:00.000Z").getTime() / 1000);
  const restoreFetch = installFetchStub({
    series: [fringe], seriesById: { 802: fringe },
    plexHistoryXml: `<?xml version="1.0"?><MediaContainer size="1"><Video type="episode" historyKey="pre-enrollment-orphan" grandparentTitle="Fringe" parentIndex="2" index="4" viewedAt="${viewedAt}" grandparentRatingKey="fringe-show" accountID="1" user="bob"/></MediaContainer>`,
    plexMetadataXml: '<?xml version="1.0"?><MediaContainer><Directory><Guid id="tvdb://82066" /></Directory></MediaContainer>',
  });
  try {
    const result = await services.enrollShow(802, { applyBaseline: false, importHistory: true });

    assert.equal(result.ok, true);
    assert.equal(result.changed, 1);
    assert.deepEqual(db.listProgressForShow(db.getRollingShowBySeriesId(802)!.id).map((item) => ({ userId: item.userId, season: item.lastWatchedSeason, episode: item.lastWatchedEpisode })), [
      { userId: user.id, season: 2, episode: 4 },
    ]);
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
    await assert.rejects(() => services.beginEnrollment(801, { applyBaseline: false, importHistory: false }), /already running/);
    const reconciliation = await services.reconcileRollingShows();
    const reset = await services.resetShow(enrollment.rolling.id);
    const remove = await services.removeShow(enrollment.rolling.id);

    assert.equal(reconciliation.ok, true);
    assert.equal(reconciliation.changed, 0);
    assert.equal(reset.ok, false);
    assert.equal(remove.ok, false);
    assert.match(reset.message, /still running/);
    assert.match(remove.message, /still running/);

    await services.completeEnrollment(enrollment.series, enrollment.rolling, enrollment.operation, { applyBaseline: false, importHistory: false });
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("reset clears prefetch targets before applying the pilot baseline", async () => {
  const { db, services, cleanup } = createHarness();
  const series: SonarrSeries = {
    id: 904,
    title: "Prefetch Reset",
    monitored: true,
    monitorNewItems: "none",
    seasons: [{ seasonNumber: 1, monitored: true }],
  };
  const episodes: SonarrEpisode[] = [
    { id: 9041, seriesId: 904, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 90401 },
    { id: 9042, seriesId: 904, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: 90402 },
  ];
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const restoreFetch = installFetchStub({
    seriesById: { 904: series },
    episodesBySeries: { 904: episodes },
    episodeFilesBySeries: { 904: [{ id: 90402, seriesId: 904, seasonNumber: 1, size: 100 }] },
    requests,
  });
  try {
    db.updateAppSettings({ dryRun: false });
    const [user] = db.upsertUsers([{ plexUserId: "plex-reset", plexAccountId: "reset", tautulliUserId: null, username: "reset", displayName: "Reset", avatarUrl: null }]);
    const rolling = db.upsertRollingShow({ id: 904, title: series.title });
    db.recordPrefetchedEpisodes(rolling.id, user.id, 1, [2], "2026-08-03T10:00:00.000Z");

    const result = await services.resetShow(rolling.id);

    assert.equal(result.ok, true);
    assert.deepEqual(db.listPrefetchedEpisodes(rolling.id), []);
    assert.equal(requests.some((request) => request.method === "PUT" && request.pathname.endsWith("/episode/monitor") && JSON.parse(request.body ?? "{}").monitored === false && JSON.parse(request.body ?? "{}").episodeIds?.includes(9042)), true);
    assert.equal(requests.some((request) => request.method === "DELETE" && request.pathname.endsWith("/90402")), true);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("dry-run reset excludes prefetch targets from the projected pilot baseline", async () => {
  const skippedMutations: Array<{ action?: string; episodes?: Array<{ id: number; monitored: boolean }>; episodeFileIds?: number[] }> = [];
  const logger = {
    debug() {},
    info() {},
    warn(_message: string, meta?: unknown) {
      if (meta && typeof meta === "object") skippedMutations.push(meta as typeof skippedMutations[number]);
    },
    error() {},
  } as unknown as Logger;
  const { db, services, cleanup } = createHarness(logger);
  const series: SonarrSeries = {
    id: 907,
    title: "Dry Run Prefetch Reset",
    monitored: true,
    monitorNewItems: "none",
    seasons: [{ seasonNumber: 1, monitored: true }],
  };
  const episodes: SonarrEpisode[] = [
    { id: 9071, seriesId: 907, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 90701 },
    { id: 9072, seriesId: 907, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: 90702 },
  ];
  const restoreFetch = installFetchStub({
    seriesById: { 907: series },
    episodesBySeries: { 907: episodes },
    episodeFilesBySeries: { 907: [{ id: 90702, seriesId: 907, seasonNumber: 1, size: 100 }] },
  });
  try {
    const [user] = db.upsertUsers([{ plexUserId: "plex-dry-reset", plexAccountId: "dry-reset", tautulliUserId: null, username: "dry-reset", displayName: "Dry Reset", avatarUrl: null }]);
    const rolling = db.upsertRollingShow({ id: 907, title: series.title });
    db.recordPrefetchedEpisodes(rolling.id, user.id, 1, [2], "2026-08-03T10:00:00.000Z");

    const result = await services.resetShow(rolling.id);

    assert.equal(result.ok, true);
    assert.equal(db.listPrefetchedEpisodes(rolling.id).length, 1);
    assert.equal(skippedMutations.find((mutation) => mutation.action === "update-episodes-monitoring")?.episodes?.some((episode) => episode.id === 9072 && !episode.monitored), true);
    assert.deepEqual(skippedMutations.find((mutation) => mutation.action === "delete-episode-files")?.episodeFileIds, [90702]);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("dry-run expansion does not clear existing prefetch targets", async () => {
  const { db, services, cleanup } = createHarness();
  try {
    const [user] = db.upsertUsers([{ plexUserId: "plex-dry-expand", plexAccountId: "dry-expand", tautulliUserId: null, username: "dry-expand", displayName: "Dry Expand", avatarUrl: null }]);
    const rolling = db.upsertRollingShow({ id: 908, title: "Dry Run Expansion" });
    db.markSeasonExpanded(rolling.id, 1, "2026-08-03T10:00:00.000Z");
    db.recordPrefetchedEpisodes(rolling.id, user.id, 1, [2], "2026-08-03T10:00:00.000Z");
    db.updateAppSettings({ dryRun: true });

    const result = await services.expandSeason(908, 1, "2026-08-03T11:00:00.000Z", "test");

    assert.equal(result, false);
    assert.equal(db.listPrefetchedEpisodes(rolling.id).length, 1);
  } finally {
    cleanup();
  }
});

test("scheduled reconciliation reclaims stale prefetches that no active viewer needs", async () => {
  const { db, services, cleanup } = createHarness();
  const series: SonarrSeries = {
    id: 905,
    title: "Stale Prefetch",
    monitored: true,
    monitorNewItems: "none",
    seasons: [{ seasonNumber: 1, monitored: true }],
  };
  const episodes: SonarrEpisode[] = [
    { id: 9051, seriesId: 905, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 90501 },
    { id: 9052, seriesId: 905, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: 90502 },
  ];
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const restoreFetch = installFetchStub({
    seriesById: { 905: series },
    episodesBySeries: { 905: episodes },
    episodeFilesBySeries: { 905: [{ id: 90502, seriesId: 905, seasonNumber: 1, size: 100 }] },
    requests,
  });
  try {
    db.updateAppSettings({ dryRun: false, progressiveCleanupDelayDays: 3 });
    const [user] = db.upsertUsers([{ plexUserId: "plex-stale", plexAccountId: "stale", tautulliUserId: null, username: "stale", displayName: "Stale", avatarUrl: null }]);
    const rolling = db.upsertRollingShow({ id: 905, title: series.title });
    db.recordPrefetchedEpisodes(rolling.id, user.id, 1, [2], "2026-01-01T10:00:00.000Z");

    const result = await services.reconcileRollingShows();

    assert.equal(result.ok, true);
    assert.deepEqual(db.listPrefetchedEpisodes(rolling.id), []);
    assert.equal(requests.some((request) => request.method === "PUT" && request.pathname.endsWith("/episode/monitor") && JSON.parse(request.body ?? "{}").monitored === false && JSON.parse(request.body ?? "{}").episodeIds?.includes(9052)), true);
    assert.equal(requests.some((request) => request.method === "DELETE" && request.pathname.endsWith("/90502")), true);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("scheduled reconciliation leaves stale prefetches alone when progressive cleanup is disabled", async () => {
  const { db, services, cleanup } = createHarness();
  const series: SonarrSeries = {
    id: 906,
    title: "Cleanup Disabled",
    monitored: true,
    monitorNewItems: "none",
    seasons: [{ seasonNumber: 1, monitored: true }],
  };
  const episodes: SonarrEpisode[] = [
    { id: 9061, seriesId: 906, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 90601 },
    { id: 9062, seriesId: 906, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: 90602 },
  ];
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const restoreFetch = installFetchStub({
    seriesById: { 906: series },
    episodesBySeries: { 906: episodes },
    episodeFilesBySeries: { 906: [{ id: 90602, seriesId: 906, seasonNumber: 1, size: 100 }] },
    requests,
  });
  try {
    db.updateAppSettings({ dryRun: false, progressiveCleanupEnabled: false, progressiveCleanupDelayDays: 0 });
    const [user] = db.upsertUsers([{ plexUserId: "plex-disabled", plexAccountId: "disabled", tautulliUserId: null, username: "disabled", displayName: "Disabled", avatarUrl: null }]);
    const rolling = db.upsertRollingShow({ id: 906, title: series.title });
    db.recordPrefetchedEpisodes(rolling.id, user.id, 1, [2], "2026-01-01T10:00:00.000Z");

    const result = await services.reconcileRollingShows();

    assert.equal(result.ok, true);
    assert.equal(db.listPrefetchedEpisodes(rolling.id).length, 1);
    assert.equal(requests.some((request) => request.method === "PUT" && request.pathname.endsWith("/episode/monitor") && JSON.parse(request.body ?? "{}").monitored === false && JSON.parse(request.body ?? "{}").episodeIds?.includes(9062)), false);
    assert.equal(requests.some((request) => request.method === "DELETE" && request.pathname.endsWith("/90602")), false);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("listRecommendations computes precise per-season savings, excludes enrolled/fully-retained shows, and sorts by savings descending", async () => {
  const { db, services, cleanup } = createHarness();

  // Candidate A: no viewers, both seasons drop to pilot-only. Bigger savings.
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
  db.updateUser(user.id, { enabled: true });
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
  db.updateUser(user2.id, { enabled: true });
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
  db.saveSonarrLibraryCache([showA, showB, showC, showD].map((series) => ({ series, posterUrl: null })));

  try {
    await services.refreshRecommendations();
    const result = services.listRecommendations();
    assert.ok(result.generatedAt);

    assert.deepEqual(result.candidates.map((candidate) => candidate.sonarrSeriesId), [500, 600]);

    const [candidateA, candidateB] = result.candidates;
    assert.deepEqual(candidateA!.retainedSeasons, []);
    assert.deepEqual(candidateA!.droppedSeasons, [1, 2]);
    assert.equal(candidateA!.projectedSavingsBytes, 1_100_000_000 + 1_600_000_000);
    assert.equal(candidateA!.viewerCount, 0);

    assert.deepEqual(candidateB!.retainedSeasons, [2]);
    assert.deepEqual(candidateB!.droppedSeasons, [1]);
    assert.equal(candidateB!.projectedSavingsBytes, 100_000_000);
    assert.equal(candidateB!.viewerCount, 1);
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

test("recommendation refresh does not fetch Sonarr when the library cache is empty", async () => {
  const warnings: string[] = [];
  const logger = {
    debug() {}, info() {}, error() {},
    warn(message: string) { warnings.push(message); },
  } as unknown as Logger;
  const { db, services, cleanup } = createHarness(logger);
  try {
    await services.refreshRecommendations();

    assert.equal(db.getRecommendationCache(), null);
    assert.deepEqual(warnings, ["Skipped recommendation refresh; Sonarr library cache is empty"]);
  } finally {
    cleanup();
  }
});

test("recommendation refresh skips a Sonarr failure and logs it without losing other candidates", async () => {
  const warnings: Array<{ message: string; meta?: unknown }> = [];
  const logger = {
    debug() {},
    info() {},
    warn(message: string, meta?: unknown) { warnings.push({ message, meta }); },
    error() {},
  } as unknown as Logger;
  const { db, services, cleanup } = createHarness(logger);
  const broken: SonarrSeries = {
    id: 1000,
    title: "Broken Episode File Reference",
    seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 2, totalEpisodeCount: 2, sizeOnDisk: 2_000 } }],
  };
  const healthy: SonarrSeries = {
    id: 1001,
    title: "Healthy Recommendation",
    seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 2, totalEpisodeCount: 2, sizeOnDisk: 2_000 } }],
  };
  const episodes = (seriesId: number): SonarrEpisode[] => [
    { id: seriesId + 1, seriesId, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: seriesId + 10 },
    { id: seriesId + 2, seriesId, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: seriesId + 20 },
  ];
  const restoreFetch = installFetchStub({
    series: [broken, healthy],
    episodesBySeries: { 1000: episodes(1000), 1001: episodes(1001) },
    episodeFilesBySeries: { 1001: [
      { id: 1011, seriesId: 1001, seasonNumber: 1, size: 500 },
      { id: 1021, seriesId: 1001, seasonNumber: 1, size: 1_500 },
    ] },
    episodeFileErrorsBySeries: { 1000: "EpisodeFile with ID 258557 does not exist" },
  });
  db.saveSonarrLibraryCache([broken, healthy].map((series) => ({ series, posterUrl: null })));

  try {
    await services.refreshRecommendations();
    assert.deepEqual(services.listRecommendations().candidates.map((candidate) => candidate.sonarrSeriesId), [1001]);
    const skipped = warnings.find((warning) => warning.message === "Skipped show during recommendation refresh");
    assert.ok(skipped);
    assert.equal((skipped.meta as { seriesId: number }).seriesId, 1000);
    assert.equal((skipped.meta as { title: string }).title, "Broken Episode File Reference");
    assert.match((skipped.meta as { error: string }).error, /EpisodeFile with ID 258557 does not exist/);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("recommendation refresh keeps the previous cache when every candidate fails", async () => {
  const errors: Array<{ message: string; meta?: unknown }> = [];
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error(message: string, meta?: unknown) { errors.push({ message, meta }); },
  } as unknown as Logger;
  const { db, services, cleanup } = createHarness(logger);
  const show: SonarrSeries = {
    id: 1100,
    title: "Unavailable Recommendation",
    seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeCount: 2, totalEpisodeCount: 2, sizeOnDisk: 2_000 } }],
  };
  const restoreFetch = installFetchStub({
    series: [show],
    episodesBySeries: { 1100: [
      { id: 1101, seriesId: 1100, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 1110 },
      { id: 1102, seriesId: 1100, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, episodeFileId: 1120 },
    ] },
    episodeFileErrorsBySeries: { 1100: "EpisodeFile with ID 999999 does not exist" },
  });
  db.saveSonarrLibraryCache([{ series: show, posterUrl: null }]);

  try {
    db.saveRecommendationCache([{
      sonarrSeriesId: 9999,
      title: "Previous Recommendation",
      year: null,
      posterUrl: null,
      status: null,
      seasonCount: 1,
      episodeCount: 2,
      sizeOnDiskBytes: 2_000,
      retainedSeasons: [],
      droppedSeasons: [1],
      viewerCount: 0,
      viewers: [],
      projectedSavingsBytes: 1_000,
      ignored: false,
    }]);

    await services.refreshRecommendations();

    assert.deepEqual(services.listRecommendations().candidates.map((candidate) => candidate.sonarrSeriesId), [9999]);
    assert.equal(errors[0]?.message, "Recommendation refresh failed for every candidate; keeping previous cache");
    assert.deepEqual(errors[0]?.meta, { attempted: 1, skipped: 1 });
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
  db.saveSonarrLibraryCache([{ series: show, posterUrl: null }]);

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
