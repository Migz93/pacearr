import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { ImageCacheService } from "../../src/server/image-cache.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import type { Logger } from "../../src/server/logger.js";
import { PacearrServices } from "../../src/server/services.js";
import type { SonarrSeries } from "../../src/shared/types.js";

/**
 * Plex session keys are small counters that restart with Plex Media Server, and
 * insertWatchEvent ignores a source_event_id it has already stored. A live event ID built
 * only from the session key therefore silently dropped later playbacks that happened to
 * reuse it (#169). These are server tests because the failure is invisible in the UI.
 */

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

const tedLasso: SonarrSeries = { id: 41, title: "Ted Lasso", tvdbId: 383203, monitored: true, monitorNewItems: "none", seasons: [{ seasonNumber: 1, monitored: true }] };
const nineOneOne: SonarrSeries = { id: 42, title: "9-1-1", tvdbId: 345596, monitored: true, monitorNewItems: "none", seasons: [{ seasonNumber: 1, monitored: true }] };
const tvdbByGrandparentKey: Record<string, number> = { "410": 383203, "420": 345596 };

function sessionVideo(options: { sessionKey: string; sessionId?: string; ratingKey: string; grandparentRatingKey: string; title: string; userId: string; username: string }) {
  const session = options.sessionId ? `<Session id="${options.sessionId}" bandwidth="10000" location="lan" />` : "";
  return `<Video type="episode" sessionKey="${options.sessionKey}" ratingKey="${options.ratingKey}" grandparentRatingKey="${options.grandparentRatingKey}" grandparentTitle="${options.title}" parentIndex="1" index="10"><User id="${options.userId}" title="${options.username}" />${session}</Video>`;
}

function createHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-live-session-ids-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1000, logLevel: "error" };
  const logger = silentLogger();
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, logger, new ImageCacheService(dir, logger), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  db.updateAppSettings({ dryRun: false, earlyPrefetchEnabled: false });
  const [gina, ivy] = db.upsertUsers([
    { plexUserId: "plex-gina", plexAccountId: "42", tautulliUserId: null, username: "gina", displayName: "Gina", avatarUrl: null },
    { plexUserId: "plex-ivy", plexAccountId: "43", tautulliUserId: null, username: "ivy", displayName: "Ivy", avatarUrl: null },
  ]);
  db.updateUser(gina!.id, { enabled: true });
  db.updateUser(ivy!.id, { enabled: true });
  // Season 1 is already expanded, so each stored event only has to advance progress.
  for (const series of [tedLasso, nineOneOne]) db.markSeasonExpanded(db.upsertRollingShow(series).id, 1, new Date().toISOString());

  let sessionsXml = '<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "plex" && url.pathname === "/status/sessions") return new Response(sessionsXml, { status: 200, headers: { "content-type": "application/xml" } });
    const metadata = url.pathname.match(/^\/library\/metadata\/(\d+)$/);
    if (url.hostname === "plex" && metadata) {
      return new Response(`<?xml version="1.0"?><MediaContainer><Directory><Guid id="tvdb://${tvdbByGrandparentKey[metadata[1]!]}" /></Directory></MediaContainer>`, { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.pathname === "/api/v3/series") return new Response(JSON.stringify([tedLasso, nineOneOne]), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`Unhandled fetch in test: ${url.toString()}`);
  }) as typeof fetch;
  return {
    db,
    services,
    gina: gina!,
    ivy: ivy!,
    setSessions: (...videos: string[]) => { sessionsXml = `<?xml version="1.0"?><MediaContainer size="${videos.length}">${videos.join("")}</MediaContainer>`; },
    progress: (series: SonarrSeries, userId: number) => db.listProgressForShow(db.getRollingShowBySeriesId(series.id)!.id).find((row) => row.userId === userId) ?? null,
    cleanup: () => {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a Plex session key reused after a restart for the same episode numbers still stores the new playback", async () => {
  const { db, services, gina, ivy, setSessions, progress, cleanup } = createHarness();
  try {
    setSessions(sessionVideo({ sessionKey: "39", sessionId: "ted-lasso-playback", ratingKey: "411", grandparentRatingKey: "410", title: "Ted Lasso", userId: "43", username: "ivy" }));
    await services.checkSessions();
    assert.equal(db.countWatchEvents(), 1);
    assert.equal(progress(tedLasso, ivy.id)?.lastWatchedEpisode, 10);

    // Plex restarted overnight and handed key 39 to a different viewer, show and playback.
    setSessions(sessionVideo({ sessionKey: "39", sessionId: "nine-one-one-playback", ratingKey: "421", grandparentRatingKey: "420", title: "9-1-1", userId: "42", username: "gina" }));
    await services.checkSessions();
    assert.equal(db.countWatchEvents(), 2);
    assert.equal(progress(nineOneOne, gina.id)?.lastWatchedEpisode, 10);

    // Later polls of that same ongoing playback remain one event.
    await services.checkSessions();
    await services.checkSessions();
    assert.equal(db.countWatchEvents(), 2);
  } finally {
    cleanup();
  }
});

test("without a Plex Session.id, a reused session key is still separated by viewer", async () => {
  const { db, services, gina, ivy, setSessions, progress, cleanup } = createHarness();
  try {
    setSessions(sessionVideo({ sessionKey: "142", ratingKey: "421", grandparentRatingKey: "420", title: "9-1-1", userId: "43", username: "ivy" }));
    await services.checkSessions();
    await services.checkSessions();
    assert.equal(db.countWatchEvents(), 1);

    setSessions(sessionVideo({ sessionKey: "142", ratingKey: "421", grandparentRatingKey: "420", title: "9-1-1", userId: "42", username: "gina" }));
    await services.checkSessions();
    assert.equal(db.countWatchEvents(), 2);
    assert.equal(progress(nineOneOne, ivy.id)?.lastWatchedEpisode, 10);
    assert.equal(progress(nineOneOne, gina.id)?.lastWatchedEpisode, 10);
  } finally {
    cleanup();
  }
});
