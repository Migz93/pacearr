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
import type { SonarrSeries } from "../../src/shared/types.js";

// A tag the administrator applied themselves. Pacearr must never add or remove it.
const OTHER_TAG = { id: 1, label: "kometafranchise" };

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function createHarness(options: { dryRun: boolean }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-tags-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1000, logLevel: "error" };
  const logger = silentLogger();
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, logger, new ImageCacheService(dir, logger), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.updateAppSettings({ dryRun: options.dryRun });
  return { db, services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

type Request = { method: string; pathname: string; body?: unknown };

/**
 * An in-memory Sonarr holding series and tags. The series editor applies `add`/`remove`
 * as Sonarr does; `failEditor` makes it return 500 to simulate an unreachable Sonarr.
 */
function installFakeSonarr(initial: { series: SonarrSeries[]; tags?: Array<{ id: number; label: string }> }) {
  const state = {
    series: new Map(initial.series.map((item) => [item.id, structuredClone(item)])),
    tags: [OTHER_TAG, ...(initial.tags ?? [])],
    requests: [] as Request[],
    failEditor: false,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    state.requests.push({ method, pathname: url.pathname, body });
    if (url.pathname === "/api/v3/tag" && method === "GET") return json(state.tags);
    if (url.pathname === "/api/v3/tag" && method === "POST") {
      const tag = { id: Math.max(...state.tags.map((item) => item.id)) + 1, label: body.label };
      state.tags.push(tag);
      return json(tag);
    }
    if (url.pathname === "/api/v3/series/editor" && method === "PUT") {
      if (state.failEditor) return json({ message: "unavailable" }, 500);
      for (const id of body.seriesIds as number[]) {
        const series = state.series.get(id)!;
        const tags = new Set(series.tags ?? []);
        for (const tagId of body.tags as number[]) body.applyTags === "add" ? tags.add(tagId) : tags.delete(tagId);
        series.tags = [...tags];
      }
      return json([]);
    }
    if (url.pathname === "/api/v3/series" && method === "GET") return json([...state.series.values()]);
    const byId = url.pathname.match(/^\/api\/v3\/series\/(\d+)$/);
    if (byId) {
      const series = state.series.get(Number(byId[1]));
      if (!series) return json({ message: "NotFound" }, 404);
      if (method === "PUT") {
        state.series.set(series.id, { ...series, ...body });
        return json(state.series.get(series.id));
      }
      return json(series);
    }
    if (url.pathname === "/api/v3/episode" || url.pathname === "/api/v3/episodefile") return json([]);
    if (method !== "GET") return json({});
    throw new Error(`Unhandled fetch in test: ${method} ${url}`);
  }) as typeof fetch;
  const tagId = (label: string) => state.tags.find((tag) => tag.label === label)?.id;
  const tagLabels = (seriesId: number) => (state.series.get(seriesId)?.tags ?? []).map((id) => state.tags.find((tag) => tag.id === id)?.label).sort();
  const tagRequests = () => state.requests.filter((request) => request.pathname === "/api/v3/tag" || request.pathname === "/api/v3/series/editor");
  return { state, tagId, tagLabels, tagRequests, restore: () => { globalThis.fetch = originalFetch; } };
}

function series(id: number, title: string, tags: number[] = [OTHER_TAG.id], seasons: SonarrSeries["seasons"] = []): SonarrSeries {
  return { id, title, monitored: true, monitorNewItems: "none", tags, seasons };
}

test("tag writes add and remove only Pacearr's own tags, through the series editor", async () => {
  const { db, services, cleanup } = createHarness({ dryRun: false });
  const sonarr = installFakeSonarr({ series: [series(10, "Alpha"), series(11, "Beta")] });
  try {
    await services.ignoreRecommendation(10, "Alpha");
    assert.deepEqual(sonarr.tagLabels(10), ["kometafranchise", "pacearr-ignored"]);

    // Ignored → enrolled swaps the tags; the administrator's own tag stays.
    await services.enrollShow(10, { applyBaseline: false, importHistory: false });
    assert.deepEqual(sonarr.tagLabels(10), ["kometafranchise", "pacearr-enrolled"]);

    await services.removeShow(db.getRollingShowBySeriesId(10)!.id);
    assert.deepEqual(sonarr.tagLabels(10), ["kometafranchise"]);

    await services.ignoreRecommendation(11, "Beta");
    await services.unignoreRecommendation(11);
    assert.deepEqual(sonarr.tagLabels(11), ["kometafranchise"]);

    const pacearrTagIds = [sonarr.tagId("pacearr-enrolled"), sonarr.tagId("pacearr-ignored")];
    const editorRequests = sonarr.state.requests.filter((request) => request.pathname === "/api/v3/series/editor");
    assert.ok(editorRequests.length > 0);
    for (const request of editorRequests) {
      const body = request.body as { tags: number[]; applyTags: string };
      assert.ok(["add", "remove"].includes(body.applyTags), "never replaces the tag list");
      assert.ok(body.tags.every((id) => pacearrTagIds.includes(id)), "only Pacearr's tags are sent");
    }
    assert.deepEqual(db.listSonarrTagRemovals(), []);
  } finally {
    sonarr.restore();
    cleanup();
  }
});

test("a reconcile adds missing tags but never removes a tag Pacearr has no record for", async () => {
  const { db, services, cleanup } = createHarness({ dryRun: false });
  // An empty database facing a Sonarr full of Pacearr tags: the state after database loss.
  const sonarr = installFakeSonarr({
    series: [series(20, "Tagged Enrolled", [1, 50]), series(21, "Tagged Ignored", [51]), series(22, "Enrolled Untagged")],
    tags: [{ id: 50, label: "pacearr-enrolled" }, { id: 51, label: "pacearr-ignored" }],
  });
  try {
    db.upsertRollingShow({ id: 22, title: "Enrolled Untagged" });
    await services.refreshSonarrLibrary();

    assert.deepEqual(sonarr.tagLabels(20), ["kometafranchise", "pacearr-enrolled"]);
    assert.deepEqual(sonarr.tagLabels(21), ["pacearr-ignored"]);
    assert.deepEqual(sonarr.tagLabels(22), ["kometafranchise", "pacearr-enrolled"]);
    const removals = sonarr.state.requests.filter((request) => (request.body as { applyTags?: string } | undefined)?.applyTags === "remove");
    assert.deepEqual(removals, []);
  } finally {
    sonarr.restore();
    cleanup();
  }
});

test("a tag removal that fails is queued and retried until it succeeds", async () => {
  const { db, services, cleanup } = createHarness({ dryRun: false });
  const sonarr = installFakeSonarr({ series: [series(30, "Gamma")] });
  try {
    await services.ignoreRecommendation(30, "Gamma");
    sonarr.state.failEditor = true;
    await services.unignoreRecommendation(30);
    assert.deepEqual(db.listSonarrTagRemovals(), [{ sonarrSeriesId: 30, tag: "ignored" }]);
    assert.deepEqual(sonarr.tagLabels(30), ["kometafranchise", "pacearr-ignored"]);

    await services.refreshSonarrLibrary();
    assert.deepEqual(db.listSonarrTagRemovals(), [{ sonarrSeriesId: 30, tag: "ignored" }], "still queued while Sonarr fails");

    sonarr.state.failEditor = false;
    await services.refreshSonarrLibrary();
    assert.deepEqual(db.listSonarrTagRemovals(), []);
    assert.deepEqual(sonarr.tagLabels(30), ["kometafranchise"]);
  } finally {
    sonarr.restore();
    cleanup();
  }
});

test("dry run sends no tag request, and queued removals catch up once it is off", async () => {
  const { db, services, cleanup } = createHarness({ dryRun: true });
  const sonarr = installFakeSonarr({
    series: [series(40, "Delta", [1, 51]), series(41, "Epsilon"), series(42, "Zeta", [1, 51])],
    tags: [{ id: 51, label: "pacearr-ignored" }],
  });
  try {
    db.ignoreRecommendation(40, "Delta");
    db.ignoreRecommendation(42, "Zeta");
    await services.unignoreRecommendation(40);
    await services.ignoreRecommendation(41, "Epsilon");
    // Restored and then ignored again before the removal could be sent.
    await services.unignoreRecommendation(42);
    await services.ignoreRecommendation(42, "Zeta");
    await services.refreshSonarrLibrary();

    assert.deepEqual(sonarr.tagRequests(), []);
    assert.deepEqual(db.listSonarrTagRemovals().map((entry) => entry.sonarrSeriesId).sort(), [40, 42]);

    db.updateAppSettings({ dryRun: false });
    await services.refreshSonarrLibrary();
    assert.deepEqual(sonarr.tagLabels(40), ["kometafranchise"]);
    assert.deepEqual(sonarr.tagLabels(41), ["kometafranchise", "pacearr-ignored"]);
    assert.deepEqual(sonarr.tagLabels(42), ["kometafranchise", "pacearr-ignored"], "a stale removal must not strip a current tag");
    assert.deepEqual(db.listSonarrTagRemovals(), []);
  } finally {
    sonarr.restore();
    cleanup();
  }
});

test("importing from Sonarr tags is additive, skips conflicts, and re-adopts without a pilot baseline", async () => {
  const { db, services, cleanup } = createHarness({ dryRun: false });
  const seasons = [
    { seasonNumber: 0, monitored: true },
    { seasonNumber: 1, monitored: false },
    { seasonNumber: 2, monitored: true },
  ];
  const sonarr = installFakeSonarr({
    series: [
      series(60, "Adopt Me", [1, 50], seasons),
      series(61, "Ignore Me", [51]),
      series(62, "Both Tags", [50, 51]),
      series(63, "Already Enrolled", [51]),
      series(64, "Removal Pending", [50]),
      series(65, "Not Confirmed", [51]),
      series(66, "Untagged"),
    ],
    tags: [{ id: 50, label: "pacearr-enrolled" }, { id: 51, label: "pacearr-ignored" }],
  });
  try {
    db.upsertRollingShow({ id: 63, title: "Already Enrolled" });
    db.queueSonarrTagRemoval(64, "enrolled");

    const preview = await services.previewSonarrTagImport();
    const ids = (shows: Array<{ sonarrSeriesId: number }>) => shows.map((show) => show.sonarrSeriesId);
    assert.deepEqual(ids(preview.toEnroll), [60]);
    assert.deepEqual(ids(preview.toIgnore), [61, 65]);
    assert.deepEqual(ids(preview.alreadyKnown), [63]);
    assert.deepEqual(ids(preview.conflicts), [62]);
    const requestsBeforeImport = sonarr.state.requests.length;

    // 65 was not in what the administrator confirmed.
    const result = await services.importFromSonarrTags({ enrollSeriesIds: [60], ignoreSeriesIds: [61] });
    assert.equal(result.enrolled, 1);
    assert.equal(result.ignored, 1);

    const adopted = db.getRollingShowBySeriesId(60);
    assert.ok(adopted);
    assert.deepEqual(adopted.expandedSeasons, [2], "a still-monitored season is kept as expanded");
    assert.deepEqual(db.listIgnoredRecommendationIds().sort(), [61]);
    assert.ok(db.getRollingShowBySeriesId(63), "an existing enrolment is left alone");
    assert.equal(db.getRollingShowBySeriesId(62), null);
    assert.equal(db.getRollingShowBySeriesId(64), null);
    assert.ok(!db.listIgnoredRecommendationIds().includes(65));
    const writes = sonarr.state.requests.slice(requestsBeforeImport).filter((request) => request.method !== "GET");
    assert.deepEqual(writes, [], "re-adoption sends nothing to Sonarr, so no pilot baseline");
  } finally {
    sonarr.restore();
    cleanup();
  }
});
