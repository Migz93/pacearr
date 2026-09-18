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

test("an active Tautulli session expands an unexpanded season after episode 1 and is deduplicated on the next poll", async () => {
  const { db, services, cleanup } = createHarness();
  const originalFetch = globalThis.fetch;
  const series: SonarrSeries = { id: 31, title: "The Wire", tvdbId: 81189, monitored: true, monitorNewItems: "none", seasons: [{ seasonNumber: 2, monitored: false }] };
  const episodes: SonarrEpisode[] = [
    { id: 311, seriesId: 31, seasonNumber: 2, episodeNumber: 1, monitored: false, hasFile: true },
    { id: 312, seriesId: 31, seasonNumber: 2, episodeNumber: 2, monitored: false, hasFile: false },
  ];
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  let sessionKey = "session-2";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ method: (init?.method ?? "GET").toUpperCase(), pathname: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.hostname === "tautulli") {
      const command = url.searchParams.get("cmd");
      if (command === "get_activity") return new Response(JSON.stringify({ response: { result: "success", data: { sessions: [{
        media_type: "episode", session_key: sessionKey, user_id: "tautulli-gina", username: "gina", user: "Gina",
        grandparent_title: "The Wire", grandparent_rating_key: "11", rating_key: "101", parent_media_index: 2, media_index: 2, started: 1700000000,
      }] } } }), { status: 200, headers: { "content-type": "application/json" } });
      if (command === "get_metadata") return new Response(JSON.stringify({ response: { result: "success", data: { guids: ["tvdb://81189"] } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/v3/series") return new Response(JSON.stringify([series]), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v3/series/31") return new Response(JSON.stringify(series), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v3/episode") return new Response(JSON.stringify(episodes), { status: 200, headers: { "content-type": "application/json" } });
    if ((init?.method ?? "GET").toUpperCase() !== "GET") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`Unhandled fetch: ${url}`);
  }) as typeof fetch;
  try {
    db.updateAppSettings({ dryRun: false });
    const [gina] = db.upsertUsers([{ plexUserId: "plex-gina", plexAccountId: "42", tautulliUserId: "tautulli-gina", username: "gina", displayName: "Gina", avatarUrl: null }]);
    db.updateUser(gina!.id, { enabled: true });
    db.upsertRollingShow(series);

    const first = await services.checkTautulliActiveSessions();
    const second = await services.checkTautulliActiveSessions();

    assert.equal(first.changed, 1);
    assert.equal(second.changed, 0);
    assert.equal(db.getUser(gina!.id)?.tautulliUsername, "gina");
    assert.deepEqual(db.getRollingShowBySeriesId(31)?.expandedSeasons, [2]);
    assert.equal(db.countWatchEvents(), 1);
    assert.equal(db.getLatestWatchEventAt("tautulli"), null);
    assert.equal(requests.filter((request) => request.method === "POST" && request.pathname === "/api/v3/command" && request.body === JSON.stringify({ name: "SeasonSearch", seriesId: 31, seasonNumber: 2 })).length, 1);

    // An active event can arrive before its Tautulli identity is mapped. A later poll
    // repairs that row in place; it is a real job change, even though it is a duplicate.
    sessionKey = "session-3";
    db.insertWatchEvent({
      source: "tautulli-session", sourceEventId: "activity:session-3:101:1700000000", userId: null,
      plexAccountId: null, username: "gina", sonarrSeriesId: 31, showTitle: "The Wire",
      seasonNumber: 2, episodeNumber: 2, watchedAt: "2023-11-14T22:13:20.000Z", rawPayload: {},
    });
    const repaired = await services.checkTautulliActiveSessions();
    assert.equal(repaired.changed, 1);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("a reused Tautulli session key with a later start is a new playback event", async () => {
  const originalFetch = globalThis.fetch;
  let started = 1700000000;
  globalThis.fetch = (async () => new Response(JSON.stringify({ response: { result: "success", data: { sessions: [{
    media_type: "episode", session_key: "reused-key", user_id: "1", grandparent_title: "The Wire", rating_key: "101",
    parent_media_index: 1, media_index: 1, started,
  }] } } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const { db, cleanup } = createHarness();
    try {
      const integration = new TautulliIntegration(db.getTautulliSettings(), silentLogger());
      const first = await integration.getActiveSessions();
      started += 3600;
      const second = await integration.getActiveSessions();
      assert.notEqual(first[0]!.referenceId, second[0]!.referenceId);
    } finally { cleanup(); }
  } finally { globalThis.fetch = originalFetch; }
});
