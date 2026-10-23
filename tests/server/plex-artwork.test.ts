import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { PlexIntegration } from "../../src/server/integrations/plex.js";
import { formatIntegrationError } from "../../src/server/integrations/request.js";
import { PlexArtworkService } from "../../src/server/plex-artwork.js";
import type { Logger } from "../../src/server/logger.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

for (const proxyPrefix of ["", "/plex"]) {
test(`redirected Plex thumbnails are backed up, overlaid and restored without contacting another origin${proxyPrefix ? " through a subpath proxy" : ""}`, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-artwork-"));
  const original = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#456789" } }).jpeg().toBuffer();
  const uploads = new Map<string, Buffer>();
  const requests: URL[] = [];
  let remoteRequests = 0;
  const remote = createServer((_req, res) => { remoteRequests++; res.end(original); });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  const remoteAddress = remote.address();
  assert(remoteAddress && typeof remoteAddress !== "string");
  const redirect = `http://127.0.0.1:${remoteAddress.port}/remote-image`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://plex.local");
    requests.push(new URL(url));
    if (proxyPrefix) {
      if (!url.pathname.startsWith(`${proxyPrefix}/`)) { res.writeHead(404).end(); return; }
      url.pathname = url.pathname.slice(proxyPrefix.length);
    }
    if (url.searchParams.get("X-Plex-Token") !== "secret") { res.writeHead(401).end(); return; }
    if (url.pathname === "/thumb/episode") { res.writeHead(302, { Location: redirect }).end(); return; }
    if (url.pathname === "/photo/:/transcode") {
      const source = new URL(url.searchParams.get("url")!, "http://plex.local");
      if (source.origin !== "http://plex.local" || source.searchParams.get("X-Plex-Token") !== "secret") {
        res.writeHead(401).end();
        return;
      }
      // Plex looks up this path internally, after the proxy prefix is stripped.
      if (source.pathname !== "/thumb/episode") { res.writeHead(404).end(); return; }
    }
    if (url.pathname === "/photo/:/transcode" || url.pathname === "/thumb/season" || url.pathname === "/thumb/season-changed") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(url.pathname === "/thumb/season-changed" ? uploads.get("season") : original);
      return;
    }
    const metadata = url.pathname.match(/^\/library\/metadata\/(season|episode)(\/posters)?$/);
    if (metadata && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      uploads.set(metadata[1], Buffer.concat(chunks));
      res.end();
      return;
    }
    if (metadata) {
      res.setHeader("Content-Type", "application/xml");
      res.end(`<MediaContainer><Video thumb="/thumb/${metadata[1]}" /></MediaContainer>`);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const serverUrl = `http://127.0.0.1:${address.port}${proxyPrefix}`;
  try {
    const db = new PacearrDatabase({ port: 9302, dataDir: dir, sessionCookieName: "test", sessionTtlMs: 1000, logLevel: "error" });
    const series = { id: 1, title: "Test show", seasons: [{ seasonNumber: 1, monitored: true }] };
    const rolling = db.upsertRollingShow(series);
    const plex = new PlexIntegration({ serverUrl, token: "secret", machineIdentifier: "test" }, silentLogger);
    const season = { ratingKey: "season", seasonNumber: 1, thumb: "/thumb/season" };
    plex.findShowForArtwork = async () => ({ ratingKey: "show", thumb: "", seasons: [season] });
    plex.getSeasonPilotArtwork = async () => ({ ratingKey: "episode", seasonNumber: 1, episodeNumber: 1, thumb: "/thumb/episode" });
    const warnings: unknown[] = [];
    const logger = { debug() {}, info() {}, error() {}, warn(_message: string, meta: unknown) { warnings.push(meta); } } as unknown as Logger;
    const artwork = new PlexArtworkService(db, logger, dir);
    await artwork.syncShow(plex, rolling, series, []);
    assert.deepEqual(warnings, []);
    const records = db.listPlexArtwork(rolling.id);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.overlayApplied, true);
      assert.deepEqual(readFileSync(record.originalPosterPath), original);
      const overlay = uploads.get(record.plexItemRatingKey)!;
      assert.deepEqual(overlay, readFileSync(record.overlayPosterPath));
      assert.notDeepEqual(overlay, original);
      const dimensions = await sharp(overlay).metadata();
      assert.equal(dimensions.width, 1920);
      assert.equal(dimensions.height, 1080);
    }
    const transcodes = requests.filter((url) => url.pathname === `${proxyPrefix}/photo/:/transcode`);
    assert.equal(transcodes.length, 1);
    assert.equal(transcodes[0].searchParams.get("url"), "/thumb/episode?X-Plex-Token=secret");
    assert.equal(transcodes[0].searchParams.get("width"), "1920");
    assert.equal(transcodes[0].searchParams.get("height"), "1920");
    assert.equal(transcodes[0].searchParams.get("minSize"), "0");
    assert.equal(transcodes[0].searchParams.get("upscale"), "0");
    assert.equal(remoteRequests, 0);

    // A changed Plex URL serving our exact overlay must keep the original backup.
    season.thumb = "/thumb/season-changed";
    await artwork.syncShow(plex, rolling, series, []);
    assert.deepEqual(readFileSync(records.find((record) => record.itemType === "season")!.originalPosterPath), original);
    assert.equal(requests.filter((url) => url.pathname === `${proxyPrefix}/photo/:/transcode`).length, 1);
    await artwork.restoreAll(plex, rolling.id);
    assert.deepEqual(uploads.get("season"), original);
    assert.deepEqual(uploads.get("episode"), original);
    assert(db.listPlexArtwork(rolling.id).every((record) => !record.overlayApplied));
    plex.getSeasonPilotArtwork = async () => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); };
    await artwork.syncShow(plex, rolling, series, []);
    assert.deepEqual(warnings, [{ seriesId: 1, seasonNumber: 1, error: "fetch failed <- unexpected redirect" }]);
  } finally {
    server.closeAllConnections();
    remote.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => remote.close(() => resolve()))]);
    rmSync(dir, { recursive: true, force: true });
  }
});
}

test("poster downloads preserve direct bytes, reject invalid responses and report failed transcoder causes", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from("original image bytes");
  let mode = "direct";
  const requests: URL[] = [];
  globalThis.fetch = (async (input, options) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.origin, "https://plex.example");
    assert.equal(options?.redirect, "error");
    assert(options?.signal);
    if (mode === "network") throw new TypeError("fetch failed", { cause: new Error("connection refused") });
    if (mode === "redirect") throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    if (mode === "missing") return new Response("missing", { status: 404 });
    return new Response(bytes, { headers: { "Content-Type": mode === "html" ? "text/html" : "image/jpeg" } });
  }) as typeof fetch;
  try {
    const plex = new PlexIntegration({ serverUrl: "https://plex.example", machineIdentifier: "", token: "secret" }, silentLogger);
    assert.deepEqual(await plex.downloadPoster("/thumb/1"), bytes);
    for (mode of ["network", "missing", "html"]) {
      requests.length = 0;
      await assert.rejects(plex.downloadPoster("/thumb/1"));
      assert.equal(requests.length, 1);
    }
    mode = "redirect";
    requests.length = 0;
    await assert.rejects(plex.downloadPoster("/thumb/1"), (error) => {
      assert.equal(formatIntegrationError(error), "fetch failed <- unexpected redirect");
      return true;
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].pathname, "/photo/:/transcode");
    assert.equal(requests[1].searchParams.get("url"), "/thumb/1?X-Plex-Token=secret");
    const proxied = new PlexIntegration({ serverUrl: "https://plex.example/plex", machineIdentifier: "", token: "secret" }, silentLogger);
    requests.length = 0;
    await assert.rejects(proxied.downloadPoster("/thumb/1?version=2&X-Plex-Token=old#fragment"));
    assert.equal(requests[1].pathname, "/plex/photo/:/transcode");
    assert.equal(requests[1].searchParams.get("url"), "/thumb/1?version=2&X-Plex-Token=secret");
    for (const remote of ["https://images.plex.tv/image.jpg", "//images.plex.tv/image.jpg"]) {
      requests.length = 0;
      await assert.rejects(plex.downloadPoster(remote));
      assert.equal(requests.length, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("integration error formatting includes nested and non-Error causes and stops at cycles", () => {
  const cause = new Error("unexpected redirect");
  const error = new TypeError("fetch failed", { cause });
  assert.equal(formatIntegrationError(error), "fetch failed <- unexpected redirect");
  cause.cause = error;
  assert.equal(formatIntegrationError(error), "fetch failed <- unexpected redirect");
  assert.equal(formatIntegrationError(new Error("failed", { cause: "offline" })), "failed <- offline");
  assert.equal(formatIntegrationError("offline"), "offline");
  assert.equal(formatIntegrationError(undefined), "undefined");
});
