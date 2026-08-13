import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { signedValue } from "../../src/server/auth.js";
import type { RuntimeConfig } from "../../src/server/config.js";
import { createApp } from "../../src/server/app.js";

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
