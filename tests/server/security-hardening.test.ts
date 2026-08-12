import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { hashSessionId, isValidSignature } from "../../src/server/auth.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { runMigrations } from "../../src/server/db/migrations.js";
import { buildIntegrationUrl } from "../../src/server/integrations/request.js";
import { PlexIntegration } from "../../src/server/integrations/plex.js";
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

test("session signature validation rejects a same-character-length non-ASCII value without throwing", () => {
  assert.doesNotThrow(() => isValidSignature("secret", "session-id", "é".repeat(64)));
  assert.equal(isValidSignature("secret", "session-id", "é".repeat(64)), false);
});

test("migration 14 hashes an existing session while preserving its usable cookie token", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-security-migration-test-"));
  const config: RuntimeConfig = { port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1_000, logLevel: "error" };
  const sessionId = "existing-plaintext-session";
  try {
    const raw = new Database(path.join(dir, "pacearr.db"));
    runMigrations(raw, undefined, 13);
    const stamp = new Date().toISOString();
    raw.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run("plexOwner", JSON.stringify({ plexId: "plex-owner", username: "owner", displayName: "Owner", email: null, avatarUrl: null, plexToken: "token" }), stamp);
    raw.prepare("INSERT INTO sessions (id, plex_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sessionId, "plex-owner", new Date(Date.now() + 60_000).toISOString(), stamp);
    raw.close();

    const upgraded = new PacearrDatabase(config);
    const migrated = new Database(path.join(dir, "pacearr.db"));
    const stored = migrated.prepare("SELECT id FROM sessions").get() as { id: string };
    migrated.close();
    assert.equal(stored.id, hashSessionId(sessionId));
    assert.equal(upgraded.getSession(sessionId)?.plexId, "plex-owner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Plex, Sonarr, and Tautulli reject unsafe URLs and disable redirect following for credentialed requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; redirect: RequestRedirect | undefined; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), redirect: init?.redirect, signal: init?.signal });
    const url = new URL(String(input));
    if (url.pathname.includes("identity")) return new Response("<MediaContainer machineIdentifier=\"server\" />", { status: 200 });
    if (url.pathname.includes("system/status")) return new Response(JSON.stringify({ version: "4" }), { status: 200 });
    return new Response(JSON.stringify({ response: { result: "success", data: { tautulli_version: "2" } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const logger = silentLogger();
    assert.deepEqual(await new SonarrIntegration({ baseUrl: "file:///etc", apiKey: "secret" }, logger).testConnection(), { ok: false, message: "Integration URL must be an HTTP(S) URL without credentials, query parameters, or fragments." });
    assert.deepEqual(await new TautulliIntegration({ enabled: true, baseUrl: "https://user:pass@tautulli.example", apiKey: "secret" }, logger).testConnection(), { ok: false, message: "Integration URL must be an HTTP(S) URL without credentials, query parameters, or fragments." });
    assert.deepEqual(await new PlexIntegration({ serverUrl: "file:///etc", machineIdentifier: "", token: "secret" }, logger).testConnection(), { ok: false, message: "Integration URL must be an HTTP(S) URL without credentials, query parameters, or fragments." });

    const plexResult = await new PlexIntegration({ serverUrl: "https://plex.example", machineIdentifier: "", token: "secret" }, logger).testConnection();
    const sonarrResult = await new SonarrIntegration({ baseUrl: "https://sonarr.example", apiKey: "secret" }, logger).testConnection();
    const tautulliResult = await new TautulliIntegration({ enabled: true, baseUrl: "https://tautulli.example", apiKey: "secret" }, logger).testConnection();
    assert.equal(plexResult.ok, true);
    assert.equal(sonarrResult.ok, true);
    assert.equal(tautulliResult.ok, true);
    assert.deepEqual(requests.map((request) => request.redirect), ["error", "error", "error"]);
    assert.ok(requests.every((request) => request.signal instanceof AbortSignal));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("integration request paths cannot replace the configured origin", () => {
  assert.throws(() => buildIntegrationUrl("https://sonarr.example/base", "https://attacker.example/api"), /must be relative/);
  assert.throws(() => buildIntegrationUrl("https://sonarr.example/base", "file:///etc/passwd"), /must be relative/);
  assert.throws(() => buildIntegrationUrl("https://sonarr.example/base", "//attacker.example/api"), /must be relative/);
});
