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

/**
 * History is the audit log the user reads, not a heartbeat. The session-check job can run
 * once a minute and the reconcile job every six hours, so a run that changed nothing must
 * leave no trace in history_events - otherwise the History page fills with thousands of
 * "processed 0, changed 0" rows and its type filter grows a button per action.
 *
 * These are server tests rather than Playwright because the failure is silent: the UI
 * looks fine either way, the damage is in the table.
 */

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function createHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-history-noise-test-"));
  const config: RuntimeConfig = {
    port: 9302,
    dataDir: dir,
    sessionCookieName: "pacearr_test",
    sessionTtlMs: 1000,
    logLevel: "error",
  };
  const logger = silentLogger();
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, logger, new ImageCacheService(dir, logger), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  return { db, services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function installFetchStub(sessionsXml: string, options: { seriesJson?: string; seriesByIdJson?: Record<number, string>; episodesBySeriesJson?: Record<number, string> } = {}) {
  const { seriesJson = "[]", seriesByIdJson = {}, episodesBySeriesJson = {} } = options;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "plex" && url.pathname === "/status/sessions") {
      return new Response(sessionsXml, { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.pathname === "/api/v3/series") {
      return new Response(seriesJson, { status: 200, headers: { "content-type": "application/json" } });
    }
    const byIdMatch = url.pathname.match(/^\/api\/v3\/series\/(\d+)$/);
    if (byIdMatch && seriesByIdJson[Number(byIdMatch[1])]) {
      return new Response(seriesByIdJson[Number(byIdMatch[1])], { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/v3/episode") {
      const seriesId = Number(url.searchParams.get("seriesId"));
      return new Response(episodesBySeriesJson[seriesId] ?? "[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/v3/episodefile") {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    // Sonarr mutation requests (PUT/POST) - the test only cares that they were
    // attempted, tracked separately via changedSomething, not their response body.
    if ((init?.method ?? "GET").toUpperCase() !== "GET") {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unhandled fetch in test: ${url.toString()}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

test("a session check that moved nobody's progress records no history event", async () => {
  const { db, services, cleanup } = createHarness();
  const restoreFetch = installFetchStub('<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>');
  try {
    const result = await services.checkSessions();
    assert.equal(result.changed, 0);
    assert.deepEqual(db.listHistory(10), []);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("a session check that only advances a viewer's progress, without expanding or prefetching a season, still records a history event", async () => {
  const { db, services, cleanup } = createHarness();
  const [gina] = db.upsertUsers([
    { plexUserId: "plex-gina", plexAccountId: "42", tautulliUserId: null, username: "gina", displayName: "Gina", avatarUrl: null },
  ]);
  const wire = db.upsertRollingShow({ id: 30, title: "The Wire" });
  // A watch of episode 2 already resolves at a newer timestamp than this seed, so
  // upsertRollingUserProgress persists a change. It isn't a premiere (skips
  // expandSeason) and earlyPrefetchEnabled defaults to false (skips prefetchNextSeason
  // before it ever calls Sonarr), so processWatchEvent reports changed: false even
  // though a viewer's progress genuinely moved.
  db.upsertRollingUserProgress(wire.id, gina.id, 1, 1, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const sessionsXml = `<?xml version="1.0"?>
    <MediaContainer size="1">
      <Video type="episode" sessionKey="1" ratingKey="100" grandparentRatingKey="10" grandparentTitle="The Wire" parentIndex="1" index="2">
        <User id="42" title="gina" />
      </Video>
    </MediaContainer>`;
  const seriesJson = JSON.stringify([{ id: 30, title: "The Wire" }]);
  const restoreFetch = installFetchStub(sessionsXml, { seriesJson });
  try {
    const result = await services.checkSessions();
    assert.equal(result.changed, 0);
    const history = db.listHistory(10);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.action, "sessions.check");
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("a rolling reconcile with nothing to change and no errors records no history event", async () => {
  const { db, services, cleanup } = createHarness();
  const restoreFetch = installFetchStub('<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>');
  try {
    // No enrolled shows, so the sweep has nothing to apply and nothing to fail on.
    const result = await services.reconcileRollingShows();
    assert.equal(result.changed, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(db.listHistory(10), []);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("a rolling reconcile that only flips series-level Sonarr monitoring, with no episode/season change, still records a history event", async () => {
  const { db, services, cleanup } = createHarness();
  // Season 1 already sits at its target (unretained, unmonitored) and episode 1
  // already matches its target monitored state with a file on disk, so nothing in
  // calculateRollingPlan's episode/season/search/file outputs differs. Only
  // series.monitored (false, should be true) differs - changedSomething used to miss
  // that, so applyMonitoringPlan mutated Sonarr but sonarr.baseline never appeared in
  // History for a scheduled sweep that genuinely changed something.
  db.updateAppSettings({ dryRun: false });
  const series = { id: 40, title: "Baseline Show", monitored: false, monitorNewItems: "none", seasons: [{ seasonNumber: 1, monitored: false }] };
  const episodes = [{ id: 4001, seriesId: 40, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 1 }];
  db.upsertRollingShow({ id: 40, title: "Baseline Show" });
  const restoreFetch = installFetchStub('<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>', {
    seriesJson: JSON.stringify([series]),
    seriesByIdJson: { 40: JSON.stringify(series) },
    episodesBySeriesJson: { 40: JSON.stringify(episodes) },
  });
  try {
    const result = await services.reconcileRollingShows();
    assert.equal(result.changed, 0);
    const history = db.listHistory(10);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.action, "sonarr.baseline");
  } finally {
    restoreFetch();
    cleanup();
  }
});
