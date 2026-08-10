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

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

function createHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-users-activity-test-"));
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
  return { db, services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the shows-driven-by-user dialog reports nothing as active for a disabled viewer, even a recent watch", async () => {
  const { db, services, cleanup } = createHarness();
  try {
    // Mirrors the card-level fix in countActiveShowsByUser: a disabled viewer's watches
    // can't keep any season expanded, so the per-show "Active" tag in the dialog this
    // opens from must agree with the card's "No active shows" rather than showing the
    // same shows as active once you click in.
    const [dave] = db.upsertUsers([
      { plexUserId: "plex-dave", plexAccountId: "4", tautulliUserId: null, username: "dave", displayName: "Dave", avatarUrl: null },
    ]);
    db.updateUser(dave.id, { enabled: false });
    const show = db.upsertRollingShow({ id: 20, title: "The Wire" });
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertRollingUserProgress(show.id, dave.id, 1, 1, recent);

    const shows = await services.listShowsDrivenByUser(dave.id);
    assert.equal(shows.length, 1);
    assert.equal(shows[0]!.active, false);
  } finally {
    cleanup();
  }
});

test("the shows-driven-by-user dialog reports a recent watch as active for an enabled viewer", async () => {
  const { db, services, cleanup } = createHarness();
  try {
    const [erin] = db.upsertUsers([
      { plexUserId: "plex-erin", plexAccountId: "5", tautulliUserId: null, username: "erin", displayName: "Erin", avatarUrl: null },
    ]);
    const show = db.upsertRollingShow({ id: 21, title: "Fringe" });
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertRollingUserProgress(show.id, erin.id, 2, 4, recent);

    const shows = await services.listShowsDrivenByUser(erin.id);
    assert.equal(shows.length, 1);
    assert.equal(shows[0]!.active, true);
  } finally {
    cleanup();
  }
});

test("the shows-driven-by-user dialog reports a recent special (season 0) as inactive", async () => {
  const { db, services, cleanup } = createHarness();
  try {
    // Specials don't expand a season, so they shouldn't read as "keeping this show
    // active" here either — matches the countActiveShowsByUser card-level fix.
    const [frank] = db.upsertUsers([
      { plexUserId: "plex-frank", plexAccountId: "7", tautulliUserId: null, username: "frank", displayName: "Frank", avatarUrl: null },
    ]);
    const show = db.upsertRollingShow({ id: 22, title: "Doctor Who" });
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertRollingUserProgress(show.id, frank.id, 0, 1, recent);

    const shows = await services.listShowsDrivenByUser(frank.id);
    assert.equal(shows.length, 1);
    assert.equal(shows[0]!.active, false);
  } finally {
    cleanup();
  }
});
