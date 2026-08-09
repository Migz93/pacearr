import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { ImageCacheService } from "../../src/server/image-cache.js";
import { PacearrServices } from "../../src/server/services.js";
import type { Logger } from "../../src/server/logger.js";
import type { RuntimeConfig } from "../../src/server/config.js";

/**
 * History is the audit log the user reads, not a heartbeat. The session-check job can run
 * once a minute and the reconcile job every six hours, so a run that changed nothing must
 * leave no trace in history_events - otherwise the History page fills with thousands of
 * "processed 0, changed 0" rows and its type filter grows a button per action.
 *
 * These are server tests rather than Playwright because the failure is silent: the UI
 * looks fine either way, the damage is in the table.
 */

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function createHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-history-noise-test-"));
  const config: RuntimeConfig = {
    port: 9302,
    dataDir: dir,
    sessionCookieName: "pacearr_test",
    sessionTtlMs: 1000,
    logLevel: "error",
  };
  const logger = silentLogger();
  const db = new PacearrDatabase(config);
  const services = new PacearrServices(db, logger, new ImageCacheService(dir, logger), dir);
  db.saveSonarrSettings({ baseUrl: "http://sonarr:8989", apiKey: "secret" });
  db.savePlexSettings({ serverUrl: "http://plex:32400", machineIdentifier: "plex-id", token: "tok" });
  return { db, services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function installFetchStub(sessionsXml: string) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "plex" && url.pathname === "/status/sessions") {
      return new Response(sessionsXml, { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (url.pathname === "/api/v3/series") {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unhandled fetch in test: ${url.toString()}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

test("a session check that moved nobody's progress records no history event", async () => {
  const { db, services, cleanup } = createHarness();
  const restoreFetch = installFetchStub('<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>');
  try {
    const result = await services.checkSessions();
    assert.equal(result.changed, 0);
    assert.deepEqual(db.listHistory(10), []);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test("a rolling reconcile with nothing to change and no errors records no history event", async () => {
  const { db, services, cleanup } = createHarness();
  const restoreFetch = installFetchStub('<?xml version="1.0"?><MediaContainer size="0"></MediaContainer>');
  try {
    // No enrolled shows, so the sweep has nothing to apply and nothing to fail on.
    const result = await services.reconcileRollingShows();
    assert.equal(result.changed, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(db.listHistory(10), []);
  } finally {
    restoreFetch();
    cleanup();
  }
});
