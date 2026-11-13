import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { signedValue } from "../../src/server/auth.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import { createApp } from "../../src/server/app.js";
import { JobScheduler } from "../../src/server/job-scheduler.js";

test("app settings preserve a triage boundary unless triage is newly enabled", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "pacearr-app-settings-"));
  const config: RuntimeConfig = { port: 9302, dataDir, sessionCookieName: "pacearr_test", sessionTtlMs: 60_000, logLevel: "error" };
  const { app, db, logger } = createApp(config);
  const sessionId = "test-session";
  db.savePlexOwner({ plexId: "owner", username: "owner", displayName: "Owner", email: null, avatarUrl: null, plexToken: "token" });
  db.createSession(sessionId, "owner", new Date(Date.now() + 60_000).toISOString());
  const cookie = `${config.sessionCookieName}=${encodeURIComponent(`${sessionId}.${signedValue(db.getSessionSecret(), sessionId)}`)}`;
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  const url = `http://127.0.0.1:${address.port}/api/settings/app`;
  try {
    const enabled = await fetch(url, { method: "PATCH", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ newShowTriageEnabled: true }) });
    assert.equal(enabled.status, 200);
    const firstBoundary = db.getAppSettings().newShowTriageEnabledAt;
    assert.ok(firstBoundary);

    const unchanged = await fetch(url, { method: "PATCH", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ newShowTriageEnabled: true, dryRun: false }) });
    assert.equal(unchanged.status, 200);
    assert.equal(db.getAppSettings().newShowTriageEnabledAt, firstBoundary);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await logger.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("saving a newly usable or changed Tautulli connection queues a history import", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "pacearr-app-settings-"));
  const config: RuntimeConfig = { port: 9302, dataDir, sessionCookieName: "pacearr_test", sessionTtlMs: 60_000, logLevel: "error" };
  const scheduler = new JobScheduler({ catchUpDelayMs: 60_000 });
  let imports = 0;
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * 60 * 60 * 1000, task: async () => { imports += 1; } });
  t.after(() => scheduler.updateJob("history-import", { enabled: false }));
  const { app, db, logger } = createApp(config, scheduler);
  const sessionId = "test-session";
  db.savePlexOwner({ plexId: "owner", username: "owner", displayName: "Owner", email: null, avatarUrl: null, plexToken: "token" });
  db.createSession(sessionId, "owner", new Date(Date.now() + 60_000).toISOString());
  const cookie = `${config.sessionCookieName}=${encodeURIComponent(`${sessionId}.${signedValue(db.getSessionSecret(), sessionId)}`)}`;
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  const save = async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/settings/tautulli`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    // Let the queued run's task start before counting.
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  try {
    await save({ enabled: false, baseUrl: "http://tautulli:8181", apiKey: "key" });
    assert.equal(imports, 0, "a disabled connection imports nothing");
    await save({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "key" });
    assert.equal(imports, 1, "enabling the connection imports its history");
    await save({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "" });
    assert.equal(imports, 1, "saving the same connection again does not");
    await save({ enabled: true, baseUrl: "http://tautulli-new:8181", apiKey: "" });
    assert.equal(imports, 2, "pointing at a different server imports again");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await logger.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("saving Plex resumes waiting jobs after user discovery and queues a history import only when discovery succeeds", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "pacearr-app-settings-"));
  const config: RuntimeConfig = { port: 9302, dataDir, sessionCookieName: "pacearr_test", sessionTtlMs: 60_000, logLevel: "error" };
  const order: string[] = [];
  const scheduler = new JobScheduler({ catchUpDelayMs: 60_000 });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * 60 * 60 * 1000, task: async () => { order.push("import"); } });
  t.after(() => scheduler.updateJob("history-import", { enabled: false }));
  const resumeAfterSetup = scheduler.resumeAfterSetup.bind(scheduler);
  scheduler.resumeAfterSetup = () => { order.push("resume"); resumeAfterSetup(); };
  const { app, db, logger, services } = createApp(config, scheduler);
  let discoveryFails = false;
  services.discoverPlexUsers = async () => {
    order.push("discover");
    if (discoveryFails) throw new Error("plex.tv unavailable");
    return [];
  };
  services.restartPlexSessionMonitor = () => {};
  const sessionId = "test-session";
  db.savePlexOwner({ plexId: "owner", username: "owner", displayName: "Owner", email: null, avatarUrl: null, plexToken: "token" });
  db.createSession(sessionId, "owner", new Date(Date.now() + 60_000).toISOString());
  const cookie = `${config.sessionCookieName}=${encodeURIComponent(`${sessionId}.${signedValue(db.getSessionSecret(), sessionId)}`)}`;
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  const originalFetch = globalThis.fetch;
  // Only the Plex server's connection test is faked; the test's own requests pass through.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/identity" && url.hostname.startsWith("plex")) {
      return new Response('<MediaContainer machineIdentifier="plex-id" />', { status: 200, headers: { "content-type": "application/xml" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const save = async (serverUrl: string) => {
    order.length = 0;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/settings/plex`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ mode: "preset", serverUrl, machineIdentifier: "plex-id" }) });
    // Let a queued run's task start before reading the order.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return response.status;
  };
  try {
    assert.equal(await save("http://plex:32400"), 200);
    assert.deepEqual(order, ["discover", "resume", "import"], "a new connection resumes after discovery, then imports");

    assert.equal(await save("http://plex:32400"), 200);
    assert.deepEqual(order, ["discover", "resume"], "saving the same connection again does not import");

    discoveryFails = true;
    assert.notEqual(await save("http://plex-new:32400"), 200);
    assert.deepEqual(order, ["discover", "resume"], "a failed discovery still resumes waiting jobs but does not import");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await logger.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("turning on the season search clears recorded seasons only when it becomes active", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "pacearr-app-settings-"));
  const config: RuntimeConfig = { port: 9302, dataDir, sessionCookieName: "pacearr_test", sessionTtlMs: 60_000, logLevel: "error" };
  const { app, db, logger } = createApp(config);
  const sessionId = "test-session";
  db.savePlexOwner({ plexId: "owner", username: "owner", displayName: "Owner", email: null, avatarUrl: null, plexToken: "token" });
  db.createSession(sessionId, "owner", new Date(Date.now() + 60_000).toISOString());
  const cookie = `${config.sessionCookieName}=${encodeURIComponent(`${sessionId}.${signedValue(db.getSessionSecret(), sessionId)}`)}`;
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  const patch = async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/settings/app`, { method: "PATCH", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  };
  const recorded = () => db.listTriagedSeries().find((row) => row.seriesId === 1)?.searchedSeasons;
  try {
    db.recordNewShowTriage({ seriesId: 1, title: "Recorded", addedAt: null, decision: "baseline" });
    db.setNewShowTriageSearchedSeasons(1, [1]);

    // Not active while triage is off.
    await patch({ searchNewlyMonitoredSeasonsEnabled: true });
    assert.deepEqual(recorded(), [1]);

    const activation = () => db.getAppSettings().searchNewlyMonitoredSeasonsActivation;
    assert.equal(activation(), 0);
    await patch({ newShowTriageEnabled: true, searchNewlyMonitoredSeasonsEnabled: true });
    assert.equal(recorded(), null);
    assert.equal(activation(), 1);

    // Saving the form again while it is already on keeps the records and the boundary.
    db.setNewShowTriageSearchedSeasons(1, [1, 2]);
    await patch({ newShowTriageEnabled: true, searchNewlyMonitoredSeasonsEnabled: true, dryRun: false });
    assert.deepEqual(recorded(), [1, 2]);
    assert.equal(activation(), 1);

    await patch({ searchNewlyMonitoredSeasonsEnabled: false });
    assert.deepEqual(recorded(), [1, 2]);
    await patch({ searchNewlyMonitoredSeasonsEnabled: true });
    assert.equal(recorded(), null);
    assert.equal(activation(), 2);

    // Turning triage off and on again also starts a new activation, however quickly.
    db.setNewShowTriageSearchedSeasons(1, [1]);
    await patch({ newShowTriageEnabled: false });
    await patch({ newShowTriageEnabled: true });
    assert.equal(recorded(), null);
    assert.equal(activation(), 3);

    const invalid = await fetch(`http://127.0.0.1:${address.port}/api/settings/app`, { method: "PATCH", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ searchNewlyMonitoredSeasonsEnabled: "yes" }) });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await logger.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
