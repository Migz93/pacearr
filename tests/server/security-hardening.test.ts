import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { hashSessionId } from "../../src/server/auth.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { SonarrIntegration } from "../../src/server/integrations/sonarr.js";
import { TautulliIntegration } from "../../src/server/integrations/tautulli.js";
import type { Logger } from "../../src/server/logger.js";

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

test("session IDs are hashed before persistence and cannot be used as stored", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-security-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1_000, logLevel: "error" };
  const db = new PacearrDatabase(config);
  const sessionId = "bearer-session-token";
  try {
    db.createSession(sessionId, "plex-owner", new Date(Date.now() + 60_000).toISOString());
    const raw = new Database(path.join(dir, "pacearr.db"));
    const stored = raw.prepare("SELECT id FROM sessions").get() as { id: string };
    raw.close();
    assert.equal(stored.id, hashSessionId(sessionId));
    assert.notEqual(stored.id, sessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Sonarr and Tautulli reject unsafe URLs and disable redirect following for credentialed requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; redirect: RequestRedirect | undefined; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), redirect: init?.redirect, signal: init?.signal });
    const url = new URL(String(input));
    if (url.pathname.includes("system/status")) return new Response(JSON.stringify({ version: "4" }), { status: 200 });
    return new Response(JSON.stringify({ response: { result: "success", data: { tautulli_version: "2" } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const logger = silentLogger();
    assert.deepEqual(await new SonarrIntegration({ baseUrl: "file:///etc", apiKey: "secret" }, logger).testConnection(), { ok: false, message: "Integration URL must be an HTTP(S) URL without credentials, query parameters, or fragments." });
    assert.deepEqual(await new TautulliIntegration({ enabled: true, baseUrl: "https://user:pass@tautulli.example", apiKey: "secret" }, logger).testConnection(), { ok: false, message: "Integration URL must be an HTTP(S) URL without credentials, query parameters, or fragments." });

    await new SonarrIntegration({ baseUrl: "https://sonarr.example", apiKey: "secret" }, logger).testConnection();
    await new TautulliIntegration({ enabled: true, baseUrl: "https://tautulli.example", apiKey: "secret" }, logger).testConnection();
    assert.deepEqual(requests.map((request) => request.redirect), ["error", "error"]);
    assert.ok(requests.every((request) => request.signal instanceof AbortSignal));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
