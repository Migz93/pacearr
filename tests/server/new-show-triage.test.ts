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
import type { SonarrEpisode, SonarrSeries } from "../../src/shared/types.js";

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function createHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-new-show-triage-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1000, logLevel: "error" };
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, silentLogger(), new ImageCacheService(dir, silentLogger()), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  return { db, services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function installSonarrFetchStub(state: { series: SonarrSeries[]; requests: Array<{ method: string; pathname: string; body?: string }>; failingSearchSeriesIds?: Set<number>; failingSeriesUpdateIds?: Set<number> }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    state.requests.push({ method, pathname: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.pathname === "/api/v3/series") return jsonResponse(state.series);
    const byId = url.pathname.match(/^\/api\/v3\/series\/(\d+)$/);
    if (byId) {
      const seriesId = Number(byId[1]);
      if (method === "PUT" && state.failingSeriesUpdateIds?.has(seriesId)) return new Response("temporary Sonarr error", { status: 503 });
      return jsonResponse(state.series.find((item) => item.id === seriesId) ?? {});
    }
    if (url.pathname === "/api/v3/episode") return jsonResponse([] satisfies SonarrEpisode[]);
    if (url.pathname === "/api/v3/command") {
      const command = typeof init?.body === "string" ? JSON.parse(init.body) as { seriesId?: number } : {};
      if (command.seriesId && state.failingSearchSeriesIds?.has(command.seriesId)) return new Response("temporary Sonarr error", { status: 503 });
      return jsonResponse({});
    }
    throw new Error(`Unhandled fetch in test: ${url.toString()}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

function series(id: number, title: string, totalEpisodeCount: number, added?: string): SonarrSeries {
  return { id, title, added, monitored: false, monitorNewItems: "none", seasons: [], statistics: { totalEpisodeCount } };
}

function enableTriage(db: PacearrDatabase, enabledAt: string, dryRun = false) {
  db.updateAppSettings({ newShowTriageEnabled: true, newShowTriageEnabledAt: enabledAt, newShowTriageEpisodeThreshold: 80, dryRun });
}

test("new-show triage ignores existing series and searches a new series at the 80 episode limit", async () => {
  const { db, services, cleanup } = createHarness();
  const enabledAt = "2026-08-11T12:00:00.000Z";
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const restoreFetch = installSonarrFetchStub({
    requests,
    series: [series(1, "Existing", 200, "2026-08-11T11:59:59.000Z"), series(2, "New and small", 80, "2026-08-11T12:00:01.000Z")],
  });
  try {
    enableTriage(db, enabledAt);
    await services.triageNewSonarrSeries();

    const commands = requests.filter((request) => request.pathname === "/api/v3/command");
    assert.deepEqual(commands.map((request) => JSON.parse(request.body ?? "{}")), [{ name: "SeriesSearch", seriesId: 2 }]);
    assert.equal(db.hasKnownNewShowTriage(1), false);
    assert.equal(db.hasKnownNewShowTriage(2), true);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("new-show triage enrolls a series over the episode limit instead of running a full search", async () => {
  const { db, services, cleanup } = createHarness();
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const large = series(3, "New and large", 81, "2026-08-11T12:00:01.000Z");
  const restoreFetch = installSonarrFetchStub({ requests, series: [large] });
  try {
    enableTriage(db, "2026-08-11T12:00:00.000Z");
    await services.triageNewSonarrSeries();

    assert.ok(db.getRollingShowBySeriesId(3));
    assert.equal(requests.some((request) => request.pathname === "/api/v3/command" && request.body?.includes("SeriesSearch")), false);
    assert.equal(db.hasKnownNewShowTriage(3), true);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("dry-run triage remains pending for live mode and a completed decision is not repeated", async () => {
  const { db, services, cleanup } = createHarness();
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const restoreFetch = installSonarrFetchStub({ requests, series: [series(4, "New", 1, "2026-08-11T12:00:01.000Z")] });
  try {
    enableTriage(db, "2026-08-11T12:00:00.000Z", true);
    await services.triageNewSonarrSeries();
    assert.equal(db.hasKnownNewShowTriage(4), false);
    assert.equal(requests.filter((request) => request.pathname === "/api/v3/command").length, 0);

    db.updateAppSettings({ dryRun: false });
    await services.triageNewSonarrSeries();
    await services.triageNewSonarrSeries();

    assert.equal(requests.filter((request) => request.pathname === "/api/v3/command").length, 1);
    assert.equal(db.hasKnownNewShowTriage(4), true);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("new-show triage uses a first-poll ID baseline when Sonarr omits added", async () => {
  const { db, services, cleanup } = createHarness();
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const state = { requests, series: [series(5, "Existing without added", 1)] };
  const restoreFetch = installSonarrFetchStub(state);
  try {
    enableTriage(db, "2026-08-11T12:00:00.000Z");
    await services.triageNewSonarrSeries();
    assert.equal(db.hasKnownNewShowTriage(5), true);
    assert.equal(requests.filter((request) => request.pathname === "/api/v3/command").length, 0);

    state.series = [...state.series, series(6, "Later without added", 1)];
    await services.triageNewSonarrSeries();

    assert.equal(requests.filter((request) => request.pathname === "/api/v3/command").length, 1);
    assert.equal(db.hasKnownNewShowTriage(6), true);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("a failed new-show triage does not block later arrivals", async () => {
  const { db, services, cleanup } = createHarness();
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const restoreFetch = installSonarrFetchStub({
    requests,
    failingSearchSeriesIds: new Set([7]),
    series: [series(7, "Temporarily failing", 1, "2026-08-11T12:00:01.000Z"), series(8, "Still triaged", 1, "2026-08-11T12:00:02.000Z")],
  });
  try {
    enableTriage(db, "2026-08-11T12:00:00.000Z");
    await services.triageNewSonarrSeries();

    assert.equal(db.hasKnownNewShowTriage(7), false);
    assert.equal(db.hasKnownNewShowTriage(8), true);
    assert.equal(requests.filter((request) => request.pathname === "/api/v3/command").length, 2);
    assert.equal(db.listHistory().some((event) => event.action === "show.auto_triage" && event.level === "warn"), true);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("retrying a partial large-show enrollment resumes without duplicating enrollment history", async () => {
  const { db, services, cleanup } = createHarness();
  const requests: Array<{ method: string; pathname: string; body?: string }> = [];
  const state = {
    requests,
    failingSeriesUpdateIds: new Set([9]),
    series: [series(9, "Large show", 81, "2026-08-11T12:00:01.000Z")],
  };
  const restoreFetch = installSonarrFetchStub(state);
  try {
    enableTriage(db, "2026-08-11T12:00:00.000Z");
    await services.triageNewSonarrSeries();
    assert.ok(db.getRollingShowBySeriesId(9));
    assert.equal(db.hasKnownNewShowTriage(9), false);
    assert.equal(db.listHistory().filter((event) => event.action === "show.enrolled").length, 1);

    state.failingSeriesUpdateIds.clear();
    await services.triageNewSonarrSeries();

    assert.equal(db.hasKnownNewShowTriage(9), true);
    assert.equal(db.listHistory().filter((event) => event.action === "show.enrolled").length, 1);
  } finally {
    restoreFetch();
    cleanup();
  }
});
