import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { ImageCacheService } from "../../src/server/image-cache.js";
import { PacearrServices } from "../../src/server/services.js";
import { SonarrIntegration } from "../../src/server/integrations/sonarr.js";
import { SonarrTagMirror } from "../../src/server/sonarr-tags.js";
import type { Logger } from "../../src/server/logger.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import type { SonarrSeries } from "../../src/shared/types.js";

// A tag the administrator applied themselves. Pacearr must never add or remove it.
const OTHER_TAG = { id: 1, label: "kometafranchise" };

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function createHarness(options: { dryRun: boolean; tagsEnabled?: boolean }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-tags-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1000, logLevel: "error" };
  const logger = silentLogger();
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, logger, new ImageCacheService(dir, logger), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.updateAppSettings({ dryRun: options.dryRun, sonarrTagsEnabled: options.tagsEnabled ?? true });
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
    /** Series IDs whose direct read returns 503, as a transient Sonarr failure. */
    failSeriesRead: new Set<number>(),
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    state.requests.push({ method, pathname: url.pathname, body });
    if (url.hostname === "plex") {
      // An empty Plex history, for tests that need a full history read to succeed.
      return new Response('<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>', { status: 200, headers: { "content-type": "application/xml" } });
    }
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
      if (method === "GET" && state.failSeriesRead.has(Number(byId[1]))) return json({ message: "unavailable" }, 503);
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

test("tag writing is off by default: nothing is sent, removals queue, and import still works", async () => {
  const { db, services, cleanup } = createHarness({ dryRun: false, tagsEnabled: false });
  const sonarr = installFakeSonarr({
    series: [series(70, "Eta", [1, 51]), series(71, "Theta"), series(72, "Iota", [50])],
    tags: [{ id: 50, label: "pacearr-enrolled" }, { id: 51, label: "pacearr-ignored" }],
  });
  try {
    // A fresh install must not opt in on its own.
    db.updateAppSettings({ sonarrTagsEnabled: undefined });
    assert.equal(db.getAppSettings().sonarrTagsEnabled, false);

    db.ignoreRecommendation(70, "Eta");
    await services.unignoreRecommendation(70);
    await services.ignoreRecommendation(71, "Theta");
    await services.refreshSonarrLibrary();
    assert.deepEqual(sonarr.tagRequests(), []);
    assert.deepEqual(db.listSonarrTagRemovals(), [{ sonarrSeriesId: 70, tag: "ignored" }]);

    const preview = await services.previewSonarrTagImport();
    assert.deepEqual(preview.toEnroll.map((show) => show.sonarrSeriesId), [72]);

    db.updateAppSettings({ sonarrTagsEnabled: true });
    await services.refreshSonarrLibrary();
    assert.deepEqual(sonarr.tagLabels(70), ["kometafranchise"]);
    assert.deepEqual(sonarr.tagLabels(71), ["kometafranchise", "pacearr-ignored"]);
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

test("a re-adopted show is not reconciled or cleaned up until a full history read completes", async () => {
  const { db, services, cleanup } = createHarness({ dryRun: false });
  // Immediate cleanup: without the guard, a reconcile before history is rebuilt would
  // trim the still-monitored season straight away.
  db.updateAppSettings({ progressiveCleanupDelayDays: 0 });
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  const sonarr = installFakeSonarr({
    series: [series(80, "Kappa", [50], [{ seasonNumber: 1, monitored: false }, { seasonNumber: 2, monitored: true }])],
    tags: [{ id: 50, label: "pacearr-enrolled" }],
  });
  const seriesWrites = () => sonarr.state.requests.filter((request) => request.method === "PUT" && request.pathname === "/api/v3/series/80");
  try {
    await services.importFromSonarrTags({ enrollSeriesIds: [80], ignoreSeriesIds: [] });
    const rollingId = db.getRollingShowBySeriesId(80)!.id;
    assert.deepEqual(db.listRollingShowIdsAwaitingHistory(), [rollingId]);

    await services.reconcileRollingShows();
    assert.deepEqual(seriesWrites(), [], "an intervening reconcile leaves the show as found");
    assert.deepEqual(db.getRollingShow(rollingId)!.expandedSeasons, [2]);

    const history = await services.reconcileFullHistory();
    assert.equal(history.ok, true);
    assert.deepEqual(db.listRollingShowIdsAwaitingHistory(), []);

    // Released: with no viewer and a zero-day delay, the normal reconcile now trims it.
    await services.reconcileRollingShows();
    assert.ok(seriesWrites().length > 0);
  } finally {
    sonarr.restore();
    cleanup();
  }
});

test("a series confirmed deleted from Sonarr drops its queued tag removals without sending them", async () => {
  const { db, services, cleanup } = createHarness({ dryRun: false, tagsEnabled: false });
  const sonarr = installFakeSonarr({
    series: [series(90, "Lambda", [1, 51]), series(91, "Mu", [1, 50]), series(92, "Nu")],
    tags: [{ id: 50, label: "pacearr-enrolled" }, { id: 51, label: "pacearr-ignored" }],
  });
  try {
    // Restored while tag writing is off: the removal is queued, and no record remains.
    db.ignoreRecommendation(90, "Lambda");
    await services.unignoreRecommendation(90);
    // Still enrolled, with a leftover queued removal of the other tag.
    db.upsertRollingShow({ id: 91, title: "Mu" });
    db.queueSonarrTagRemoval(91, "ignored");
    assert.equal(db.listSonarrTagRemovals().length, 2);

    sonarr.state.series.delete(90);
    sonarr.state.series.delete(91);
    await services.refreshSonarrLibrary();

    assert.deepEqual(db.listSonarrTagRemovals(), []);
    assert.equal(db.getRollingShowBySeriesId(91), null);
    assert.deepEqual(sonarr.tagRequests(), []);
  } finally {
    sonarr.restore();
    cleanup();
  }
});

test("a reconcile defers a show another operation holds, logs it, and tags it once it is free", async () => {
  const { db, cleanup } = createHarness({ dryRun: false });
  const sonarr = installFakeSonarr({ series: [series(100, "Xi"), series(101, "Omicron"), series(102, "Pi")] });
  const messages: Array<{ message: string; meta: unknown }> = [];
  const record = (message: string, meta: unknown) => { messages.push({ message, meta }); };
  const logger = { debug() {}, info: record, warn: record, error: record } as unknown as Logger;
  const busy = new Set([101, 102]);
  const mirror = new SonarrTagMirror(
    db,
    logger,
    () => new SonarrIntegration(db.getSonarrSettings()!, logger, false),
    (seriesId) => busy.has(seriesId),
    { timeoutMs: 300, pollMs: 10 },
  );
  try {
    for (const id of [100, 101, 102]) db.upsertRollingShow({ id, title: String(id) });
    // 101 finishes its operation while the reconcile waits; 102 stays busy throughout.
    setTimeout(() => busy.delete(101), 50);
    const result = await mirror.reconcile([...sonarr.state.series.values()]);

    assert.deepEqual(result && { added: result.added, deferred: result.deferred }, { added: 2, deferred: 1 });
    assert.deepEqual(sonarr.tagLabels(100), ["kometafranchise", "pacearr-enrolled"]);
    assert.deepEqual(sonarr.tagLabels(101), ["kometafranchise", "pacearr-enrolled"]);
    assert.deepEqual(sonarr.tagLabels(102), ["kometafranchise"]);
    const deferredLog = messages.find((entry) => entry.message.startsWith("Sonarr tag changes deferred"));
    assert.ok(deferredLog, "the deferral is logged");
    assert.deepEqual((deferredLog.meta as { titles: string[] }).titles.sort(), ["Omicron", "Pi"]);
    const stillDeferredLog = messages.find((entry) => entry.message.startsWith("Sonarr tag changes still deferred"));
    assert.ok(stillDeferredLog, "the show still deferred is logged");
    assert.deepEqual((stillDeferredLog.meta as { titles: string[] }).titles, ["Pi"]);
  } finally {
    sonarr.restore();
    cleanup();
  }
});

test("a deferred show whose re-read fails stays deferred instead of being counted as done", async () => {
  const { db, cleanup } = createHarness({ dryRun: false });
  const sonarr = installFakeSonarr({ series: [series(110, "Rho")] });
  const warnings: string[] = [];
  const logger = { debug() {}, info() {}, warn: (message: string) => { warnings.push(message); }, error() {} } as unknown as Logger;
  const busy = new Set([110]);
  const mirror = new SonarrTagMirror(
    db,
    logger,
    () => new SonarrIntegration(db.getSonarrSettings()!, logger, false),
    (seriesId) => busy.has(seriesId),
    { timeoutMs: 300, pollMs: 10 },
  );
  try {
    db.upsertRollingShow({ id: 110, title: "Rho" });
    sonarr.state.failSeriesRead.add(110);
    setTimeout(() => busy.delete(110), 30);
    const result = await mirror.reconcile([...sonarr.state.series.values()]);

    assert.equal(result?.deferred, 1);
    assert.equal(result?.added, 0);
    assert.deepEqual(sonarr.tagLabels(110), ["kometafranchise"]);
    assert.ok(warnings.some((message) => message.startsWith("Could not re-read a deferred Sonarr series")));
    assert.ok(warnings.some((message) => message.startsWith("Sonarr tag changes still deferred")));
  } finally {
    sonarr.restore();
    cleanup();
  }
});
