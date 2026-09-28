import assert from "node:assert/strict";
import test from "node:test";
import { PlexIntegration } from "../../src/server/integrations/plex.js";
import type { Logger } from "../../src/server/logger.js";

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

test("findShowForArtwork requests a single seed item per TV section", async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const xml = (body: string) => new Response(body, { status: 200, headers: { "Content-Type": "application/xml" } });
    if (url.pathname === "/library/sections") return xml("<MediaContainer><Directory key=\"2\" type=\"show\" agent=\"tv.plex.agents.series\" title=\"TV\" /></MediaContainer>");
    if (url.pathname === "/library/sections/2/all" && url.searchParams.has("guid")) return xml("<MediaContainer><Directory type=\"show\" ratingKey=\"42\" guid=\"plex://show/abc\" thumb=\"/thumb/42\" /></MediaContainer>");
    if (url.pathname === "/library/sections/2/all") return xml("<MediaContainer><Directory type=\"show\" ratingKey=\"7\" /></MediaContainer>");
    if (url.pathname === "/library/metadata/7/matches") return xml("<MediaContainer><SearchResult type=\"show\" guid=\"plex://show/abc\" /></MediaContainer>");
    if (url.pathname === "/library/metadata/42/children") return xml("<MediaContainer><Directory type=\"season\" index=\"1\" ratingKey=\"43\" thumb=\"/thumb/43\" /></MediaContainer>");
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const plex = new PlexIntegration({ serverUrl: "https://plex.example", machineIdentifier: "", token: "secret" }, silentLogger());
    const show = await plex.findShowForArtwork({ tvdbId: 123, imdbId: "tt456" });
    assert.equal(show?.ratingKey, "42");

    // Regression for #200 — without X-Plex-Container-Start, Plex ignores the
    // size and returns the entire section for every identifier.
    const seedRequests = requests.filter((url) => url.pathname === "/library/sections/2/all" && !url.searchParams.has("guid"));
    assert.equal(seedRequests.length, 2);
    for (const url of seedRequests) {
      assert.equal(url.searchParams.get("X-Plex-Container-Start"), "0");
      assert.equal(url.searchParams.get("X-Plex-Container-Size"), "1");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
