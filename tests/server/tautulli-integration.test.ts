import assert from "node:assert/strict";
import test from "node:test";
import { TautulliIntegration, TautulliMetadataUnavailableError } from "../../src/server/integrations/tautulli.js";
import { isNotFoundError } from "../../src/server/integrations/request.js";
import type { Logger } from "../../src/server/logger.js";

test("getHistory maps valid records independently and skips malformed rows", async () => {
  const originalFetch = globalThis.fetch;
  // Regression for #75: Tautulli's `user` (admin-editable friendly name) and `username`
  // (real Plex username) used to be collapsed into a single field with `??`, discarding
  // whichever one lost. This asserts getHistory keeps both distinct all the way out.
  globalThis.fetch = (async () => new Response(JSON.stringify({
    response: {
      result: "success",
      data: {
        data: [{
          reference_id: "ref-1",
          user_id: 42,
          username: "dave_plex",
          user: "Big Chief Dave",
          grandparent_title: "The Expanse",
          parent_media_index: 2,
          media_index: 5,
          date: 1700000000,
          rating_key: "999",
          grandparent_rating_key: "111",
        }, {
          reference_id: "ref-2",
          user_id: 43,
          user: "Managed viewer",
          grandparent_title: "The Expanse",
          parent_media_index: 2,
          media_index: 6,
          date: 1700000001,
          rating_key: "1000",
          grandparent_rating_key: "111",
        }, {
          // One malformed history row must not discard the valid records around it.
          reference_id: "invalid-date",
          parent_media_index: 2,
          media_index: 7,
          date: "Infinity",
        }, {
          reference_id: "missing-date",
          parent_media_index: 2,
          media_index: 8,
        }],
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const tautulli = new TautulliIntegration({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" }, logger);
    const history = await tautulli.getHistory();
    assert.equal(history.length, 2);
    const record = history[0]!;
    assert.equal(record.username, "dave_plex");
    assert.equal(record.friendlyName, "Big Chief Dave");
    assert.equal(history[1]!.username, null);
    assert.equal(history[1]!.friendlyName, "Managed viewer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getActiveSessions parses real get_activity rows, which carry no start time, and keys them by playback session", async () => {
  const originalFetch = globalThis.fetch;
  // Shaped like a live get_activity response: no `started` or `date`, and `updated_at`
  // is the media item's metadata timestamp rather than anything about this playback.
  globalThis.fetch = (async () => new Response(JSON.stringify({
    response: {
      result: "success",
      data: {
        sessions: [{
          media_type: "episode",
          session_key: "46",
          session_id: "ccl4mzu5skl4o2lft1vwwec4",
          user_id: 42,
          username: "dave_plex",
          user: "Big Chief Dave",
          grandparent_title: "The Expanse",
          parent_media_index: "2",
          media_index: "5",
          rating_key: "999",
          grandparent_rating_key: "111",
          updated_at: "1766839127",
          view_offset: "120000",
        }, {
          // Without a Session.id the reused-prone session key is scoped to the viewer,
          // the episode and the observed day.
          media_type: "episode",
          session_key: "47",
          user_id: 43,
          grandparent_title: "The Expanse",
          parent_media_index: 2,
          media_index: 6,
          rating_key: "1000",
        }, {
          // Non-episode rows must not enter the playback pipeline.
          media_type: "movie",
          session_key: "movie-1",
          session_id: "movie-session",
        }, {
          // Episode activity without a usable season/episode is not a playback observation.
          media_type: "episode",
          session_key: "malformed-episode",
          parent_media_index: 2,
          media_index: 0,
        }, {
          // Tautulli data is external input: fractional episode positions must be ignored
          // without preventing valid sessions from processing.
          media_type: "episode",
          session_key: "fractional-season",
          parent_media_index: 2.5,
          media_index: 1,
        }],
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const tautulli = new TautulliIntegration({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" }, logger);
    const before = Date.now();
    const sessions = await tautulli.getActiveSessions();
    const after = Date.now();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]!.referenceId, "session:ccl4mzu5skl4o2lft1vwwec4:999");
    assert.equal(sessions[0]!.seasonNumber, 2);
    assert.equal(sessions[0]!.episodeNumber, 5);
    assert.equal(sessions[0]!.username, "dave_plex");
    assert.equal(sessions[0]!.friendlyName, "Big Chief Dave");
    const watchedAt = new Date(sessions[0]!.watchedAt).getTime();
    assert.ok(watchedAt >= before && watchedAt <= after, "watchedAt is when Pacearr observed the session");
    assert.equal(sessions[1]!.referenceId, `key:47:43:1000:${sessions[1]!.watchedAt.slice(0, 10)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getShowGuids reports Tautulli's missing-metadata answer as its own error, never as a missing item", async () => {
  const originalFetch = globalThis.fetch;
  const json = (body: unknown, status: number, statusText: string) => new Response(JSON.stringify(body), { status, statusText, headers: { "content-type": "application/json" } });
  // Tautulli sends this both for a rating key Plex no longer has and when its own request
  // to Plex fails (#208): as a 400, or as a 200 from older versions.
  const noMetadata = (ratingKey: string, status: number, statusText: string) => json({ response: { result: "error", message: `Unable to retrieve metadata for rating_key '${ratingKey}'`, data: {} } }, status, statusText);
  const responses: Record<string, () => Response> = {
    ambiguous: () => noMetadata("ambiguous", 400, "Bad Request"),
    legacy: () => noMetadata("legacy", 200, "OK"),
    badRequest: () => json({ response: { result: "error", message: "Invalid apikey" } }, 400, "Bad Request"),
    // Tautulli answers 404 when its API is disabled.
    apiDisabled: () => json({ response: { result: "error", message: "API not enabled" } }, 404, "Not Found"),
    down: () => new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" }),
    proxyDown: () => noMetadata("proxyDown", 503, "Service Unavailable"),
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => responses[new URL(String(input)).searchParams.get("rating_key")!]!()) as typeof fetch;
  try {
    const tautulli = new TautulliIntegration({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" }, { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger);
    for (const key of ["ambiguous", "legacy"]) {
      await assert.rejects(tautulli.getShowGuids(key), (error) => error instanceof TautulliMetadataUnavailableError && !isNotFoundError(error));
    }
    const failure = (message: string) => (error: unknown) => !(error instanceof TautulliMetadataUnavailableError) && !isNotFoundError(error) && error instanceof Error && error.message === message;
    await assert.rejects(tautulli.getShowGuids("badRequest"), failure("Tautulli 400 Bad Request: Invalid apikey"));
    await assert.rejects(tautulli.getShowGuids("apiDisabled"), failure("Tautulli 404 Not Found: API not enabled"));
    await assert.rejects(tautulli.getShowGuids("down"), failure("Tautulli 503 Service Unavailable"));
    // Only Tautulli's own command error carries the missing-metadata meaning, never a 5xx.
    await assert.rejects(tautulli.getShowGuids("proxyDown"), failure("Tautulli 503 Service Unavailable: Unable to retrieve metadata for rating_key 'proxyDown'"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPlexServerId reads the Plex machine identifier Tautulli is connected to", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ response: { result: "success", data: { pms_uuid: "tautulli-install", pms_identifier: " plex-machine-id " } } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const tautulli = new TautulliIntegration({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" }, { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger);
    assert.equal(await tautulli.getPlexServerId(), "plex-machine-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
