import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { ImageCacheService } from "../../src/server/image-cache.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import { TautulliIntegration } from "../../src/server/integrations/tautulli.js";
import type { Logger } from "../../src/server/logger.js";
import { PacearrServices } from "../../src/server/services.js";
import type { SonarrEpisode, SonarrSeries } from "../../src/shared/types.js";

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function createHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-tautulli-session-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1000, logLevel: "error" };
  const logger = silentLogger();
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, logger, new ImageCacheService(dir, logger), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.saveTautulliSettings({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" });
  return { db, services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an active Tautulli session retries expansion after a series-operation collision and is then deduplicated", async () => {
  const { db, services, cleanup } = createHarness();
  const originalFetch = globalThis.fetch;
  const series: SonarrSeries = { id: 31, title: "The Wire", tvdbId: 81189, monitored: true, monitorNewItems: "none", seasons: [{ seasonNumber: 2, monitored: false }, { seasonNumber: 3, monitored: false }] };
  const episodes: SonarrEpisode[] = [
    { id: 311, seriesId: 31, seasonNumber: 2, episodeNumber: 1, monitored: false, hasFile: true },
    { id: 312, seriesId: 31, seasonNumber: 2, episodeNumber: 2, monitored: false, hasFile: false },
    { id: 313, seriesId: 31, seasonNumber: 3, episodeNumber: 1, monitored: false, hasFile: true },
    { id: 314, seriesId: 31, seasonNumber: 3, episodeNumber: 2, monitored: false, hasFile: false },
  ];
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  let sessionId = "session-2";
  let seasonNumber = 2;
  let ratingKey = "101";
  let activityUserId = "tautulli-gina";
  let activityUsername = "gina";
  let seriesAvailable = true;
  const operations = services as unknown as {
    acquireSeriesOperation(seriesId: number): number | null;
    releaseSeriesOperation(seriesId: number, operation: number): void;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ method: (init?.method ?? "GET").toUpperCase(), pathname: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.hostname === "tautulli") {
      const command = url.searchParams.get("cmd");
      if (command === "get_activity") return new Response(JSON.stringify({ response: { result: "success", data: { sessions: [{
        media_type: "episode", session_key: "7", session_id: sessionId, user_id: activityUserId, username: activityUsername, user: "Gina",
        grandparent_title: "The Wire", grandparent_rating_key: "11", rating_key: ratingKey, parent_media_index: seasonNumber, media_index: 2,
      }] } } }), { status: 200, headers: { "content-type": "application/json" } });
      if (command === "get_metadata") return new Response(JSON.stringify({ response: { result: "success", data: { guids: ["tvdb://81189"] } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/v3/series") return new Response(JSON.stringify(seriesAvailable ? [series] : []), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v3/series/31") return new Response(JSON.stringify(series), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v3/episode") return new Response(JSON.stringify(episodes), { status: 200, headers: { "content-type": "application/json" } });
    if ((init?.method ?? "GET").toUpperCase() !== "GET") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`Unhandled fetch: ${url}`);
  }) as typeof fetch;
  try {
    db.updateAppSettings({ dryRun: false });
    const [gina] = db.upsertUsers([{ plexUserId: "plex-gina", plexAccountId: "42", tautulliUserId: "tautulli-gina", username: "gina", displayName: "Gina", avatarUrl: null }]);
    const [ivy] = db.upsertUsers([{ plexUserId: "plex-ivy", plexAccountId: "43", tautulliUserId: null, username: "ivy", displayName: "Ivy", avatarUrl: null }]);
    db.updateUser(gina!.id, { enabled: true });
    db.updateUser(ivy!.id, { enabled: true });
    db.upsertRollingShow(series);

    const operation = operations.acquireSeriesOperation(31);
    assert.notEqual(operation, null);
    const deferred = await services.checkTautulliActiveSessions();
    assert.equal(deferred.changed, 0);
    assert.deepEqual(db.getRollingShowBySeriesId(31)?.expandedSeasons, []);

    operations.releaseSeriesOperation(31, operation as number);
    const first = await services.checkTautulliActiveSessions();
    const historyCountAfterFirst = db.listHistory(100).length;
    const episodeFetchesAfterFirst = requests.filter((request) => request.method === "GET" && request.pathname === "/api/v3/episode").length;
    const second = await services.checkTautulliActiveSessions();

    assert.equal(first.changed, 1);
    assert.equal(second.changed, 0);
    assert.equal(db.listHistory(100).length, historyCountAfterFirst);
    assert.equal(requests.filter((request) => request.method === "GET" && request.pathname === "/api/v3/episode").length, episodeFetchesAfterFirst);
    assert.equal(db.getUser(gina!.id)?.tautulliUsername, "gina");
    assert.deepEqual(db.getRollingShowBySeriesId(31)?.expandedSeasons, [2]);
    assert.equal(db.countWatchEvents(), 1);
    assert.equal(db.getLatestWatchEventAt("tautulli"), null);
    assert.equal(requests.filter((request) => request.method === "POST" && request.pathname === "/api/v3/command" && request.body === JSON.stringify({ name: "SeasonSearch", seriesId: 31, seasonNumber: 2 })).length, 1);

    // A poll can repair both links at once. In dry-run mode, the repair must
    // not replay prefetch work after the series repair already completed it.
    db.updateAppSettings({ dryRun: true, earlyPrefetchEnabled: true });
    sessionId = "session-combined";
    ratingKey = "102";
    activityUserId = "tautulli-ivy";
    activityUsername = "not-yet-mapped";
    seriesAvailable = false;
    await services.checkTautulliActiveSessions();
    const prefetchesBeforeRepair = db.listHistory(100).filter((entry) => entry.action === "dry_run.sonarr.early_prefetch").length;
    const episodeFetchesBeforeRepair = requests.filter((request) => request.method === "GET" && request.pathname === "/api/v3/episode").length;
    activityUsername = "ivy";
    seriesAvailable = true;
    await services.checkTautulliActiveSessions();
    assert.equal(db.listHistory(100).filter((entry) => entry.action === "dry_run.sonarr.early_prefetch").length, prefetchesBeforeRepair + 1);
    assert.equal(requests.filter((request) => request.method === "GET" && request.pathname === "/api/v3/episode").length, episodeFetchesBeforeRepair + 1);
    assert.equal(db.listUnmappedTautulliUsers().some((entry) => entry.tautulliUserId === "tautulli-ivy"), false);
    db.updateAppSettings({ dryRun: false, earlyPrefetchEnabled: false });

    // An active event can arrive before its Tautulli identity is mapped. A later poll
    // repairs that row in place; it is a real job change, even though it is a duplicate.
    sessionId = "session-3";
    seasonNumber = 3;
    ratingKey = "103";
    activityUserId = "tautulli-gina";
    activityUsername = "gina";
    db.insertWatchEvent({
      source: "tautulli-session", sourceEventId: "session:session-3:103", userId: null,
      plexAccountId: null, username: "gina", sonarrSeriesId: 31, showTitle: "The Wire",
      seasonNumber: 3, episodeNumber: 2, watchedAt: "2023-11-14T22:13:20.000Z", rawPayload: {},
    });
    const repaired = await services.checkTautulliActiveSessions();
    assert.equal(repaired.changed, 2);
    assert.deepEqual(db.getRollingShowBySeriesId(31)?.expandedSeasons, [2, 3]);
    assert.equal(requests.filter((request) => request.method === "POST" && request.pathname === "/api/v3/command" && request.body === JSON.stringify({ name: "SeasonSearch", seriesId: 31, seasonNumber: 3 })).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("a reused Tautulli session key is a new playback event, while repeated polls of one playback are not", async () => {
  const originalFetch = globalThis.fetch;
  let sessionId = "first-playback";
  globalThis.fetch = (async () => new Response(JSON.stringify({ response: { result: "success", data: { sessions: [{
    media_type: "episode", session_key: "39", session_id: sessionId, user_id: "1", grandparent_title: "The Wire", rating_key: "101",
    parent_media_index: 1, media_index: 10,
  }] } } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const { db, cleanup } = createHarness();
    try {
      const integration = new TautulliIntegration(db.getTautulliSettings(), silentLogger());
      const first = await integration.getActiveSessions();
      const repeated = await integration.getActiveSessions();
      assert.equal(first[0]!.referenceId, repeated[0]!.referenceId);
      // Plex restarted and handed the same session key to a new playback.
      sessionId = "second-playback";
      const second = await integration.getActiveSessions();
      assert.notEqual(first[0]!.referenceId, second[0]!.referenceId);
    } finally { cleanup(); }
  } finally { globalThis.fetch = originalFetch; }
});
