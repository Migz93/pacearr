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

type FakeShow = { ratingKey: string; guid: string; folder: string };
type FakeSection = { key: string; title: string; shows: FakeShow[] };

// Fakes just enough of Plex for findShowForArtwork: each section's seed item,
// the matches endpoint (keyed by the external identifier in `title`), the
// section GUID filter, and each show's folder and seasons.
async function findWithFakePlex(sections: FakeSection[], guidsByIdentifier: Record<string, string[]>, ids: { tvdbId: number | null; imdbId: string | null; path?: string | null }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    const xml = (body: string) => new Response(`<MediaContainer>${body}</MediaContainer>`, { status: 200, headers: { "Content-Type": "application/xml" } });
    const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    if (url.pathname === "/library/sections") {
      return xml(sections.map((section) => `<Directory key="${section.key}" type="show" agent="tv.plex.agents.series" title="${section.title}" />`).join(""));
    }
    const sectionAll = url.pathname.match(/^\/library\/sections\/(\w+)\/all$/);
    if (sectionAll) {
      const section = sections.find((candidate) => candidate.key === sectionAll[1]);
      const guid = url.searchParams.get("guid");
      const shows = guid ? section?.shows.filter((show) => show.guid === guid) : section?.shows.slice(0, 1);
      return xml((shows ?? []).map((show) => `<Directory type="show" ratingKey="${show.ratingKey}" guid="${show.guid}" thumb="/thumb/${show.ratingKey}" />`).join(""));
    }
    const metadata = url.pathname.match(/^\/library\/metadata\/(\w+)(\/children|\/matches)?$/);
    const show = sections.flatMap((section) => section.shows).find((candidate) => candidate.ratingKey === metadata?.[1]);
    if (metadata?.[2] === "/matches") {
      const guids = guidsByIdentifier[url.searchParams.get("title") ?? ""] ?? [];
      return xml(guids.map((guid) => `<SearchResult type="show" guid="${guid}" />`).join(""));
    }
    if (show && metadata?.[2] === "/children") return xml(`<Directory type="season" index="1" ratingKey="${show.ratingKey}01" thumb="/thumb/${show.ratingKey}01" />`);
    if (show) return xml(`<Directory type="show" ratingKey="${show.ratingKey}" guid="${show.guid}"><Location path="${escape(show.folder)}" /></Directory>`);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const plex = new PlexIntegration({ serverUrl: "https://plex.example", machineIdentifier: "", token: "secret" }, silentLogger());
    return await plex.findShowForArtwork(ids);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const SAME_SHOW_TWO_LIBRARIES: FakeSection[] = [
  { key: "2", title: "TV", shows: [{ ratingKey: "23828", guid: "plex://show/911", folder: "/mnt/user/media/TV/TV/9-1-1 (2018) [imdb-tt7235466]" }] },
  { key: "4", title: "TV HQ", shows: [{ ratingKey: "320635", guid: "plex://show/911", folder: "/mnt/user/media/TV/HQ/9-1-1 (2018) [imdb-tt7235466]" }] },
];
const SAME_SHOW_IDS = { "tvdb-337907": ["plex://show/911"], "imdb-tt7235466": ["plex://show/911"] };

test("findShowForArtwork picks the copy in Sonarr's folder when one show is in several libraries", async () => {
  // Each path differs only by a trailing separator, which is normalised away.
  for (const separator of ["/", "\\"]) {
    const show = await findWithFakePlex(SAME_SHOW_TWO_LIBRARIES, SAME_SHOW_IDS, {
      tvdbId: 337907,
      imdbId: "tt7235466",
      path: `/mnt/user/media/TV/TV/9-1-1 (2018) [imdb-tt7235466]${separator}`,
    });
    assert.equal(show?.ratingKey, "23828", `trailing ${separator}`);
    assert.deepEqual(show?.seasons.map((season) => season.ratingKey), ["2382801"]);
  }
});

test("findShowForArtwork skips a show in several libraries when none is in Sonarr's folder", async () => {
  const show = await findWithFakePlex(SAME_SHOW_TWO_LIBRARIES, SAME_SHOW_IDS, {
    tvdbId: 337907,
    imdbId: "tt7235466",
    path: "/tv/9-1-1 (2018) [imdb-tt7235466]",
  });
  assert.equal(show, null);
});

test("findShowForArtwork never lets Sonarr's folder pick between different shows", async () => {
  const sections: FakeSection[] = [
    { key: "2", title: "TV", shows: [{ ratingKey: "10", guid: "plex://show/right", folder: "/tv/Right Show" }] },
    { key: "4", title: "TV HQ", shows: [{ ratingKey: "20", guid: "plex://show/wrong", folder: "/hq/Wrong Show" }] },
  ];
  const show = await findWithFakePlex(sections, { "tvdb-123": ["plex://show/right", "plex://show/wrong"] }, { tvdbId: 123, imdbId: null, path: "/tv/Right Show" });
  assert.equal(show, null);
});

test("findShowForArtwork uses a single match whether or not its folder is Sonarr's", async () => {
  const sections: FakeSection[] = [{ key: "2", title: "TV", shows: [{ ratingKey: "10", guid: "plex://show/only", folder: "/data/tv/Only Show" }] }];
  const ids = { "tvdb-123": ["plex://show/only"] };
  assert.equal((await findWithFakePlex(sections, ids, { tvdbId: 123, imdbId: null, path: "/data/tv/Only Show" }))?.ratingKey, "10");
  assert.equal((await findWithFakePlex(sections, ids, { tvdbId: 123, imdbId: null, path: "/tv/Only Show" }))?.ratingKey, "10");
  assert.equal((await findWithFakePlex(sections, ids, { tvdbId: 123, imdbId: null }))?.ratingKey, "10");
});
