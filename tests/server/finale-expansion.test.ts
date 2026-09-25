import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { ImageCacheService } from "../../src/server/image-cache.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import type { Logger } from "../../src/server/logger.js";
import { PacearrServices, selectFinaleNextSeason } from "../../src/server/services.js";
import type { AppSettings, SonarrEpisode, SonarrSeries } from "../../src/shared/types.js";

/**
 * Expanding the next season when a season's last episode is watched (#171). These are
 * server tests because a wrong expansion, or a later sweep quietly undoing one, only
 * shows up as Sonarr downloading (or deleting) the wrong files.
 */

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function episode(id: number, seasonNumber: number, episodeNumber: number, overrides: Partial<SonarrEpisode> = {}): SonarrEpisode {
  return { id, seriesId: 71, seasonNumber, episodeNumber, monitored: false, hasFile: false, ...overrides };
}

// 9-1-1 with a watched, expanded season 1 of ten episodes and an unexpanded season 2.
function nineOneOneEpisodes(): SonarrEpisode[] {
  return [
    ...Array.from({ length: 10 }, (_, index) => episode(7100 + index + 1, 1, index + 1, { monitored: true, hasFile: true, episodeFileId: 7100 + index + 1 })),
    ...Array.from({ length: 5 }, (_, index) => episode(7200 + index + 1, 2, index + 1, { monitored: index === 0 })),
  ];
}

const nineOneOne: SonarrSeries = { id: 71, title: "9-1-1", tvdbId: 345596, monitored: true, monitorNewItems: "none", seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: false }] };

type Request = { method: string; pathname: string; body?: string };

function createHarness(settings: Partial<AppSettings>, options: { episodes?: SonarrEpisode[]; expandSeasonOne?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-finale-expansion-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1000, logLevel: "error" };
  const logger = silentLogger();
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, logger, new ImageCacheService(dir, logger), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.updateAppSettings({ dryRun: false, earlyPrefetchEnabled: false, expandNextSeasonOnFinaleEnabled: false, ...settings });
  const [gina] = db.upsertUsers([
    { plexUserId: "plex-gina", plexAccountId: "42", tautulliUserId: null, username: "gina", displayName: "Gina", avatarUrl: null },
  ]);
  db.updateUser(gina!.id, { enabled: true });
  const rolling = db.upsertRollingShow(nineOneOne);
  if (options.expandSeasonOne ?? true) db.markSeasonExpanded(rolling.id, 1, new Date().toISOString());

  let episodes = options.episodes ?? nineOneOneEpisodes();
  let sessionsXml = '<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>';
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, pathname: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.hostname === "plex" && url.pathname === "/status/sessions") return new Response(sessionsXml, { status: 200, headers: { "content-type": "application/xml" } });
    if (url.hostname === "plex" && url.pathname.startsWith("/library/metadata/")) {
      return new Response('<?xml version="1.0"?><MediaContainer><Directory><Guid id="tvdb://345596" /></Directory></MediaContainer>', { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.pathname === "/api/v3/series") return Response.json([nineOneOne]);
    if (url.pathname === "/api/v3/series/71") return Response.json(nineOneOne);
    if (url.pathname === "/api/v3/episode") return Response.json(episodes);
    if (url.pathname === "/api/v3/episodefile") return Response.json([]);
    if (method !== "GET") return Response.json({});
    throw new Error(`Unhandled fetch in test: ${url.toString()}`);
  }) as typeof fetch;

  return {
    db,
    services,
    requests,
    rollingShowId: rolling.id,
    setEpisodes: (next: SonarrEpisode[]) => { episodes = next; },
    watch: (seasonNumber: number, episodeNumber: number, sessionKey = `${seasonNumber}-${episodeNumber}`) => {
      sessionsXml = `<?xml version="1.0"?><MediaContainer size="1"><Video type="episode" sessionKey="${sessionKey}" ratingKey="7${seasonNumber}${episodeNumber}" grandparentRatingKey="710" grandparentTitle="9-1-1" parentIndex="${seasonNumber}" index="${episodeNumber}"><User id="42" title="gina" /></Video></MediaContainer>`;
      return services.checkSessions();
    },
    expandedSeasons: () => db.getRollingShowBySeriesId(71)!.expandedSeasons,
    seasonSearched: (seasonNumber: number) => requests.some((request) => request.method === "POST" && request.pathname === "/api/v3/command" && request.body === JSON.stringify({ name: "SeasonSearch", seriesId: 71, seasonNumber })),
    cleanup: () => {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("finale selection finds the next real season only from a season's last known episode", () => {
  const episodes = [
    episode(1, 0, 1),
    episode(2, 1, 1), episode(3, 1, 2),
    // Season 2 is absent, so season 3 is the next real season.
    episode(4, 3, 1), episode(5, 3, 2), episode(6, 3, 3),
  ];
  assert.equal(selectFinaleNextSeason(episodes, 1, 2), 3);
  assert.equal(selectFinaleNextSeason(episodes, 1, 1), null);
  // An episode past the last one Sonarr lists is stale or mismatched data, not a finale.
  assert.equal(selectFinaleNextSeason(episodes, 1, 3), null);
  // Every episode Sonarr lists counts, aired or not, so E03 is the finale here, not E02.
  assert.equal(selectFinaleNextSeason(episodes, 3, 2), null);
  // No later season exists in Sonarr yet.
  assert.equal(selectFinaleNextSeason(episodes, 3, 3), null);
  // Specials are never the next season, and never trigger an expansion themselves.
  assert.equal(selectFinaleNextSeason(episodes, 0, 1), null);
});

test("starting a season's last episode expands the whole next season, with early prefetch off", async () => {
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true });
  try {
    await harness.watch(1, 9);
    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.equal(harness.seasonSearched(2), false);

    const result = await harness.watch(1, 10);

    assert.equal(result.changed, 1);
    assert.deepEqual(harness.expandedSeasons(), [1, 2]);
    assert.equal(harness.seasonSearched(2), true);
    assert.equal(harness.requests.some((request) => request.pathname === "/api/v3/episode/monitor" && request.body === JSON.stringify({ episodeIds: [7202, 7203, 7204, 7205], monitored: true })), true);
    const history = harness.db.listHistory(20).filter((entry) => entry.action === "sonarr.expand_season");
    assert.equal(history.length, 1);
    assert.deepEqual(JSON.parse(String(history[0]!.details)), { seasonNumber: 2, source: "plex-session-finale", monitoredEpisodes: 4, dryRun: false });
  } finally {
    harness.cleanup();
  }
});

test("a watch past the last episode Sonarr lists does not expand the next season", async () => {
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true });
  try {
    await harness.watch(1, 11);

    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.equal(harness.seasonSearched(2), false);
  } finally {
    harness.cleanup();
  }
});

test("with the setting off, the finale leaves early prefetch behaving as before", async () => {
  const harness = createHarness({ earlyPrefetchEnabled: true, earlyPrefetchTriggerEpisodesRemaining: 3, earlyPrefetchEpisodeCount: 2 });
  try {
    await harness.watch(1, 10);

    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.equal(harness.seasonSearched(2), false);
    assert.deepEqual(harness.db.listPrefetchedEpisodes(harness.rollingShowId).map((row) => [row.seasonNumber, row.episodeNumber]), [[2, 2], [2, 3]]);
  } finally {
    harness.cleanup();
  }
});

test("a finale expansion supersedes early prefetch of the same season", async () => {
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true, earlyPrefetchEnabled: true, earlyPrefetchTriggerEpisodesRemaining: 3, earlyPrefetchEpisodeCount: 2 });
  try {
    await harness.watch(1, 8);
    assert.equal(harness.db.listPrefetchedEpisodes(harness.rollingShowId).length, 2);

    await harness.watch(1, 10);

    assert.deepEqual(harness.expandedSeasons(), [1, 2]);
    assert.deepEqual(harness.db.listPrefetchedEpisodes(harness.rollingShowId), []);
    assert.equal(harness.db.listHistory(20).filter((entry) => entry.action === "sonarr.early_prefetch").length, 1);
  } finally {
    harness.cleanup();
  }
});

test("a one-episode season expands both itself and the next season from its only episode", async () => {
  const episodes = [
    episode(7101, 1, 1, { monitored: true, hasFile: true }),
    episode(7201, 2, 1, { monitored: true }), episode(7202, 2, 2),
  ];
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true }, { episodes, expandSeasonOne: false });
  try {
    await harness.watch(1, 1);

    assert.deepEqual(harness.expandedSeasons(), [1, 2]);
    assert.equal(harness.seasonSearched(2), true);
  } finally {
    harness.cleanup();
  }
});

test("a dry-run finale records the expansion without changing Sonarr or expanded seasons, and repeat polls stay silent", async () => {
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true, dryRun: true });
  try {
    await harness.watch(1, 10);
    await harness.watch(1, 10);

    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.equal(harness.requests.some((request) => request.pathname.startsWith("/api/v3/") && request.method !== "GET"), false);
    assert.equal(harness.db.listHistory(20).filter((entry) => entry.action === "dry_run.sonarr.expand_season").length, 1);
  } finally {
    harness.cleanup();
  }
});

test("scheduled reconciliation keeps a finale-expanded season while its viewer is still on the previous season", async () => {
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true, progressiveCleanupEnabled: true, progressiveCleanupDelayDays: 0 });
  try {
    await harness.watch(1, 10);
    assert.deepEqual(harness.expandedSeasons(), [1, 2]);
    // Sonarr now reflects the expansion.
    harness.setEpisodes(nineOneOneEpisodes().map((item) => item.seasonNumber === 2 ? { ...item, monitored: true } : item));
    harness.requests.length = 0;

    await harness.services.reconcileRollingShows();

    assert.deepEqual(harness.expandedSeasons(), [1, 2]);
    const unmonitored = harness.requests
      .filter((request) => request.pathname === "/api/v3/episode/monitor")
      .map((request) => JSON.parse(request.body!) as { episodeIds: number[]; monitored: boolean })
      .filter((body) => !body.monitored)
      .flatMap((body) => body.episodeIds);
    assert.deepEqual(unmonitored, []);
    assert.equal(harness.requests.some((request) => request.method === "DELETE"), false);
  } finally {
    harness.cleanup();
  }
});

test("the rolling reconcile expands the next season for a finale watched before the setting was enabled", async () => {
  const harness = createHarness({ earlyPrefetchEnabled: true, earlyPrefetchTriggerEpisodesRemaining: 3, earlyPrefetchEpisodeCount: 2 });
  try {
    await harness.watch(1, 8);
    await harness.watch(1, 10);
    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.equal(harness.db.listPrefetchedEpisodes(harness.rollingShowId).length, 2);

    // The stored finale event is never reprocessed, so only the sweep can catch it up.
    harness.db.updateAppSettings({ expandNextSeasonOnFinaleEnabled: true });
    await harness.watch(1, 10);
    assert.deepEqual(harness.expandedSeasons(), [1]);
    await harness.services.reconcileRollingShows();

    assert.deepEqual(harness.expandedSeasons(), [1, 2]);
    assert.equal(harness.seasonSearched(2), true);
    assert.deepEqual(harness.db.listPrefetchedEpisodes(harness.rollingShowId), []);
    const history = harness.db.listHistory(20).filter((entry) => entry.action === "sonarr.expand_season");
    assert.deepEqual(history.map((entry) => JSON.parse(String(entry.details)).source), ["active-progress-reconcile-finale"]);

    await harness.services.reconcileRollingShows();
    assert.equal(harness.db.listHistory(50).filter((entry) => entry.action === "sonarr.expand_season").length, 1);
  } finally {
    harness.cleanup();
  }
});

test("the rolling reconcile ignores a finale watched by a viewer outside the activity window", async () => {
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true, viewerActivityWindowDays: 30 });
  try {
    const user = harness.db.listUsers().find((item) => item.username === "gina")!;
    harness.db.upsertRollingUserProgress(harness.rollingShowId, user.id, 1, 10, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString());

    await harness.services.reconcileRollingShows();

    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.equal(harness.seasonSearched(2), false);
  } finally {
    harness.cleanup();
  }
});

/*
 * Every job must reach the same actions from the same viewer position. These cover the
 * paths that move progress without a fresh watch event reaching processWatchEvent.
 */

test("the rolling reconcile prefetches for a viewer whose progress reached the trigger without a processed watch event", async () => {
  const harness = createHarness({ earlyPrefetchEnabled: true, earlyPrefetchTriggerEpisodesRemaining: 3, earlyPrefetchEpisodeCount: 2 });
  try {
    const user = harness.db.listUsers().find((item) => item.username === "gina")!;
    harness.db.upsertRollingUserProgress(harness.rollingShowId, user.id, 1, 8, new Date().toISOString());

    await harness.services.reconcileRollingShows();

    assert.deepEqual(harness.db.listPrefetchedEpisodes(harness.rollingShowId).map((row) => [row.seasonNumber, row.episodeNumber]), [[2, 2], [2, 3]]);
    const prefetch = harness.db.listHistory(20).filter((entry) => entry.action === "sonarr.early_prefetch");
    assert.deepEqual(prefetch.map((entry) => JSON.parse(String(entry.details)).source), ["active-progress-reconcile"]);

    // Already prefetched, so a second sweep does nothing further.
    await harness.services.reconcileRollingShows();
    assert.equal(harness.db.listHistory(50).filter((entry) => entry.action === "sonarr.early_prefetch").length, 1);
  } finally {
    harness.cleanup();
  }
});

test("enrolment applies a stored finale watch the same way a live watch would", async () => {
  const harness = createHarness({ expandNextSeasonOnFinaleEnabled: true }, { expandSeasonOne: false });
  try {
    const user = harness.db.listUsers().find((item) => item.username === "gina")!;
    harness.db.deleteRollingShow(harness.rollingShowId);
    harness.db.insertWatchEvent({
      source: "plex-history", sourceEventId: "finale-before-enrolment", userId: user.id, plexAccountId: "42", username: "gina",
      sonarrSeriesId: 71, showTitle: "9-1-1", seasonNumber: 1, episodeNumber: 10, watchedAt: new Date().toISOString(), rawPayload: {},
    });

    await harness.services.enrollShow(71, { applyBaseline: true, importHistory: false });

    assert.deepEqual(harness.expandedSeasons(), [1, 2]);
    assert.equal(harness.seasonSearched(2), true);
    const sources = harness.db.listHistory(20).filter((entry) => entry.action === "sonarr.expand_season").map((entry) => JSON.parse(String(entry.details)).source);
    assert.equal(sources.includes("enroll-finale"), true);
  } finally {
    harness.cleanup();
  }
});

/*
 * Enrolment applies viewer positions before the pass that deletes files. The other
 * order deleted a season's files and then expanded or prefetched it straight back.
 */

// Season 2 fully downloaded, as it is when an existing library show is enrolled.
function nineOneOneWithSeasonTwoFiles(): SonarrEpisode[] {
  return nineOneOneEpisodes().map((item) => item.seasonNumber === 2 ? { ...item, monitored: true, hasFile: true, episodeFileId: item.id } : item);
}

async function enrollWithStoredProgress(settings: Partial<AppSettings>, episodeNumber: number) {
  const harness = createHarness(settings, { episodes: nineOneOneWithSeasonTwoFiles(), expandSeasonOne: false });
  const user = harness.db.listUsers().find((item) => item.username === "gina")!;
  harness.db.deleteRollingShow(harness.rollingShowId);
  harness.db.insertWatchEvent({
    source: "plex-history", sourceEventId: `s1e${episodeNumber}-before-enrolment`, userId: user.id, plexAccountId: "42", username: "gina",
    sonarrSeriesId: 71, showTitle: "9-1-1", seasonNumber: 1, episodeNumber, watchedAt: new Date().toISOString(), rawPayload: {},
  });
  try {
    await harness.services.enrollShow(71, { applyBaseline: true, importHistory: false });
  } catch (error) {
    harness.cleanup();
    throw error;
  }
  const deletedFileIds = harness.requests
    .filter((request) => request.method === "DELETE" && request.pathname.startsWith("/api/v3/episodefile/"))
    .map((request) => Number(request.pathname.split("/").pop()));
  return { harness, deletedFileIds };
}

test("enrolling a viewer on a finale keeps the next season's files that finale expansion needs", async () => {
  const { harness, deletedFileIds } = await enrollWithStoredProgress({ expandNextSeasonOnFinaleEnabled: true }, 10);
  try {
    assert.deepEqual(harness.expandedSeasons(), [1, 2]);
    assert.deepEqual(deletedFileIds, []);
  } finally {
    harness.cleanup();
  }
});

test("enrolling a viewer inside the prefetch trigger keeps only the prefetched next-season files", async () => {
  const { harness, deletedFileIds } = await enrollWithStoredProgress({ earlyPrefetchEnabled: true, earlyPrefetchTriggerEpisodesRemaining: 3, earlyPrefetchEpisodeCount: 2 }, 8);
  try {
    // Re-enrolment creates a new rolling show row.
    const rollingShowId = harness.db.getRollingShowBySeriesId(71)!.id;
    assert.deepEqual(harness.db.listPrefetchedEpisodes(rollingShowId).map((row) => [row.seasonNumber, row.episodeNumber]), [[2, 2], [2, 3]]);
    // E01 is the pilot and E02/E03 were prefetched; only E04/E05 are cleaned up.
    assert.deepEqual(deletedFileIds.sort((a, b) => a - b), [7204, 7205]);
  } finally {
    harness.cleanup();
  }
});

test("a first watch inside an unexpanded season expands it and still prefetches the next when near its end", async () => {
  const episodes = [
    episode(7101, 1, 1, { monitored: true, hasFile: true }),
    ...Array.from({ length: 5 }, (_, index) => episode(7201 + index, 2, index + 1, { monitored: index === 0 })),
    episode(7301, 3, 1, { monitored: true }), episode(7302, 3, 2), episode(7303, 3, 3),
  ];
  const harness = createHarness({ earlyPrefetchEnabled: true, earlyPrefetchTriggerEpisodesRemaining: 3, earlyPrefetchEpisodeCount: 2 }, { episodes });
  try {
    await harness.watch(2, 4);

    assert.deepEqual(harness.expandedSeasons(), [1, 2]);
    assert.deepEqual(harness.db.listPrefetchedEpisodes(harness.rollingShowId).map((row) => [row.seasonNumber, row.episodeNumber]), [[3, 2], [3, 3]]);
  } finally {
    harness.cleanup();
  }
});

test("a dry-run rolling reconcile records one expansion for two viewers in the same unexpanded season", async () => {
  const harness = createHarness({ dryRun: true, expandNextSeasonOnFinaleEnabled: true });
  try {
    harness.db.upsertUsers([
      { plexUserId: "plex-ivy", plexAccountId: "43", tautulliUserId: null, username: "ivy", displayName: "Ivy", avatarUrl: null },
    ]);
    const gina = harness.db.listUsers().find((item) => item.username === "gina")!;
    const ivy = harness.db.listUsers().find((item) => item.username === "ivy")!;
    harness.db.updateUser(ivy.id, { enabled: true });
    const now = new Date().toISOString();
    harness.db.upsertRollingUserProgress(harness.rollingShowId, gina.id, 2, 2, now);
    harness.db.upsertRollingUserProgress(harness.rollingShowId, ivy.id, 2, 3, now);

    await harness.services.reconcileRollingShows();

    assert.deepEqual(harness.expandedSeasons(), [1]);
    assert.equal(harness.db.listHistory(50).filter((entry) => entry.action === "dry_run.sonarr.expand_season").length, 1);
  } finally {
    harness.cleanup();
  }
});
