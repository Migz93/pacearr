import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageCacheService } from "../../src/server/image-cache.js";
import type { Logger } from "../../src/server/logger.js";

test("a deleted cached image is fetched again", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-image-cache-"));
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
  const cache = new ImageCacheService(dataDir, logger);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  try {
    const first = await cache.ensureAvatarCached("plex-user", "https://images.example/avatar.png");
    assert.ok(first);
    fs.unlinkSync(path.join(cache.publicDir, path.basename(first)));
    const second = await cache.ensureAvatarCached("plex-user", "https://images.example/avatar.png");
    assert.equal(second, first);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
