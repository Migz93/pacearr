import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PacearrDatabase } from "../../src/server/db/index.js";
import type { RuntimeConfig } from "../../src/server/config.js";

function createDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-test-"));
  const config: RuntimeConfig = {
    port: 9302,
    dataDir: dir,
    sessionCookieName: "pacearr_test",
    sessionTtlMs: 1000,
    logLevel: "error",
  };
  const db = new PacearrDatabase(config);
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("rolling show enrollment is idempotent by Sonarr series id", () => {
  const { db, cleanup } = createDb();
  try {
    const first = db.upsertRollingShow({ id: 42, title: "Fringe", tvdbId: 82066, imdbId: "tt1119644", year: 2008 });
    const second = db.upsertRollingShow({ id: 42, title: "Fringe", tvdbId: 82066, imdbId: "tt1119644", year: 2008 });
    assert.equal(first.id, second.id);
    assert.equal(db.listRollingShows().length, 1);
  } finally {
    cleanup();
  }
});

test("rolling progress follows a viewer's most recent watch, even after a rewatch starts in an earlier season", () => {
  const { db, cleanup } = createDb();
  try {
    const [user] = db.upsertUsers([{ plexUserId: "plex-1", plexAccountId: "1", tautulliUserId: null, username: "alice", displayName: "Alice", avatarUrl: null }]);
    const rolling = db.upsertRollingShow({ id: 42, title: "Fringe" });
    db.upsertRollingUserProgress(rolling.id, user.id, 5, 8, "2025-01-01T10:00:00.000Z");
    db.upsertRollingUserProgress(rolling.id, user.id, 1, 3, "2026-07-13T10:00:00.000Z");

    const progress = db.listProgressForShow(rolling.id)[0];
    assert.equal(progress?.lastWatchedSeason, 1);
    assert.equal(progress?.lastWatchedEpisode, 3);
    assert.equal(progress?.lastWatchedAt, "2026-07-13T10:00:00.000Z");

    db.insertWatchEvent({
      source: "plex-history", sourceEventId: "old", userId: user.id, plexAccountId: "1", username: "alice",
      sonarrSeriesId: 42, showTitle: "Fringe", seasonNumber: 5, episodeNumber: 8,
      watchedAt: "2025-01-01T10:00:00.000Z", rawPayload: {},
    });
    db.insertWatchEvent({
      source: "plex-history", sourceEventId: "recent", userId: user.id, plexAccountId: "1", username: "alice",
      sonarrSeriesId: 42, showTitle: "Fringe", seasonNumber: 1, episodeNumber: 3,
      watchedAt: "2026-07-13T10:00:00.000Z", rawPayload: {},
    });
    const latest = db.listLatestUserProgressForSeries(42)[0];
    assert.equal(latest?.seasonNumber, 1);
    assert.equal(latest?.episodeNumber, 3);
  } finally {
    cleanup();
  }
});

test("dry-run mode is enabled by default and live cleanup deletion cannot be disabled", () => {
  const { db, cleanup } = createDb();
  try {
    assert.equal(db.getAppSettings().dryRun, true);
    db.setSetting("app", { cleanupDeletesFiles: false });
    assert.equal(db.getAppSettings().dryRun, true);
    assert.equal(db.getAppSettings().cleanupDeletesFiles, true);
    assert.equal(db.updateAppSettings({ cleanupDeletesFiles: false }).cleanupDeletesFiles, true);
  } finally {
    cleanup();
  }
});

test("history supports filtered server-side pagination", () => {
  const { db, cleanup } = createDb();
  try {
    db.addHistory("info", "history.import", "First import", { processed: 10 });
    db.addHistory("warn", "history.import", "Second import", { errors: ["timeout"] });
    db.addHistory("error", "sessions.check", "Session failure", "Plex unavailable");

    const firstPage = db.listHistoryPaginated({ page: 1, pageSize: 2 });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.results.length, 2);
    assert.equal(firstPage.results[0]?.title, "Session failure");
    assert.deepEqual(firstPage.actions, ["history.import", "sessions.check"]);

    const warningImports = db.listHistoryPaginated({ page: 1, pageSize: 10, level: "warn", action: "history.import" });
    assert.equal(warningImports.total, 1);
    assert.equal(warningImports.results[0]?.title, "Second import");
  } finally {
    cleanup();
  }
});

test("watch event import is idempotent by source and source event id", () => {
  const { db, cleanup } = createDb();
  try {
    const input = {
      source: "plex-history" as const,
      sourceEventId: "history-1",
      userId: null,
      plexAccountId: "1",
      username: "alice",
      sonarrSeriesId: 99,
      showTitle: "The Expanse",
      seasonNumber: 5,
      episodeNumber: 1,
      watchedAt: "2026-04-01T10:00:00.000Z",
      rawPayload: { ok: true },
    };
    assert.equal(db.insertWatchEvent(input).inserted, true);
    assert.equal(db.insertWatchEvent(input).inserted, false);
    assert.equal(db.countWatchEvents(), 1);
  } finally {
    cleanup();
  }
});

test("server-local Plex owner history can be linked and used to rebuild progress", () => {
  const { db, cleanup } = createDb();
  try {
    const [owner] = db.upsertUsers([{ plexUserId: "owner-cloud-id", plexAccountId: "owner-cloud-id", tautulliUserId: null, username: "owner", displayName: "Owner", avatarUrl: null }]);
    db.insertWatchEvent({
      source: "plex-history", sourceEventId: "owner-history-1", userId: null, plexAccountId: "1", username: null,
      sonarrSeriesId: 99, showTitle: "The Expanse", seasonNumber: 1, episodeNumber: 11,
      watchedAt: "2026-04-12T10:00:00.000Z", rawPayload: {},
    });
    assert.equal(db.linkUnassignedWatchEventsByPlexAccount(owner.id, "1"), 1);
    assert.deepEqual(db.listLatestWatchProgressForUser(owner.id), [{ sonarrSeriesId: 99, seasonNumber: 1, episodeNumber: 11, watchedAt: "2026-04-12T10:00:00.000Z" }]);
  } finally {
    cleanup();
  }
});

test("latest show progress and season stats are derived from watch events", () => {
  const { db, cleanup } = createDb();
  try {
    const [user] = db.upsertUsers([{ plexUserId: "plex-1", plexAccountId: "1", tautulliUserId: null, username: "alice", displayName: "Alice", avatarUrl: null }]);
    db.insertWatchEvent({
      source: "plex-history",
      sourceEventId: "history-1",
      userId: user.id,
      plexAccountId: "1",
      username: "alice",
      sonarrSeriesId: 99,
      showTitle: "The Expanse",
      seasonNumber: 1,
      episodeNumber: 1,
      watchedAt: "2026-04-01T10:00:00.000Z",
      rawPayload: { ok: true },
    });
    db.insertWatchEvent({
      source: "plex-history",
      sourceEventId: "history-2",
      userId: user.id,
      plexAccountId: "1",
      username: "alice",
      sonarrSeriesId: 99,
      showTitle: "The Expanse",
      seasonNumber: 2,
      episodeNumber: 3,
      watchedAt: "2026-04-02T10:00:00.000Z",
      rawPayload: { ok: true },
    });

    assert.deepEqual(db.listLatestUserProgressForSeries(99), [{
      userId: user.id,
      displayName: "Alice",
      avatarUrl: null,
      enabled: true,
      seasonNumber: 2,
      episodeNumber: 3,
      watchedAt: "2026-04-02T10:00:00.000Z",
    }]);
    assert.deepEqual(db.listSeasonWatchStatsForSeries(99), [
      { seasonNumber: 1, watchedUsers: 1, latestWatchedAt: "2026-04-01T10:00:00.000Z" },
      { seasonNumber: 2, watchedUsers: 1, latestWatchedAt: "2026-04-02T10:00:00.000Z" },
    ]);
  } finally {
    cleanup();
  }
});

test("dashboard activity uses latest playback and counts active enrolled viewers", () => {
  const { db, cleanup } = createDb();
  try {
    const [alice, bob] = db.upsertUsers([
      { plexUserId: "plex-alice", plexAccountId: "1", tautulliUserId: null, username: "alice", displayName: "Alice", avatarUrl: null },
      { plexUserId: "plex-bob", plexAccountId: "2", tautulliUserId: null, username: "bob", displayName: "Bob", avatarUrl: null },
    ]);
    const show = db.upsertRollingShow({ id: 99, title: "The Expanse" });
    db.upsertRollingUserProgress(show.id, alice.id, 2, 3, "2026-04-02T10:00:00.000Z");
    db.upsertRollingUserProgress(show.id, bob.id, 1, 2, "2026-03-01T10:00:00.000Z");
    db.insertWatchEvent({
      source: "plex-history", sourceEventId: "dashboard-activity", userId: alice.id, plexAccountId: "1", username: "alice",
      sonarrSeriesId: 99, showTitle: "The Expanse", seasonNumber: 2, episodeNumber: 3,
      watchedAt: "2026-04-02T10:00:00.000Z", rawPayload: {},
    });

    const [activity] = db.listDashboardShowActivity("2026-04-01T00:00:00.000Z");
    assert.deepEqual(activity, {
      id: show.id,
      sonarrSeriesId: 99,
      title: "The Expanse",
      expandedSeasons: [],
      activeViewerCount: 1,
      lastWatchedAt: "2026-04-02T10:00:00.000Z",
      lastWatchedSeason: 2,
      lastWatchedEpisode: 3,
      lastWatcherName: "Alice",
    });
    assert.equal(db.countActiveViewers("2026-04-01T00:00:00.000Z"), 1);
  } finally {
    cleanup();
  }
});

test("storage reclaim totals persist confirmed file deletion sizes", () => {
  const { db, cleanup } = createDb();
  try {
    db.recordStorageReclaim({
      rollingShowId: null,
      sonarrSeriesId: 99,
      showTitle: "The Expanse",
      action: "cleanup.progressive",
      seasonNumber: 1,
      fileCount: 3,
      bytesReclaimed: 1_500_000_000,
    });
    assert.deepEqual(db.getReclaimedStorageTotals(), { bytesReclaimed: 1_500_000_000, fileCount: 3 });
  } finally {
    cleanup();
  }
});

test("expanded seasons are monotonic and not duplicated", () => {
  const { db, cleanup } = createDb();
  try {
    const show = db.upsertRollingShow({ id: 7, title: "Severance", tvdbId: 371980, year: 2022 });
    assert.equal(db.markSeasonExpanded(show.id, 2, "2026-04-01T10:00:00.000Z"), true);
    assert.equal(db.markSeasonExpanded(show.id, 2, "2026-04-01T10:00:00.000Z"), false);
    assert.equal(db.markSeasonExpanded(show.id, 1, "2026-04-01T10:00:00.000Z"), true);
    assert.deepEqual(db.getRollingShow(show.id)?.expandedSeasons, [1, 2]);
  } finally {
    cleanup();
  }
});

test("expanded seasons can be removed during progressive cleanup", () => {
  const { db, cleanup } = createDb();
  try {
    const show = db.upsertRollingShow({ id: 7, title: "Severance", tvdbId: 371980, year: 2022 });
    db.markSeasonExpanded(show.id, 1, "2026-04-01T10:00:00.000Z");
    db.markSeasonExpanded(show.id, 2, "2026-04-01T10:00:00.000Z");
    db.removeExpandedSeason(show.id, 1);
    assert.deepEqual(db.getRollingShow(show.id)?.expandedSeasons, [2]);
  } finally {
    cleanup();
  }
});

test("Plex artwork records persist original poster backups and overlay state", () => {
  const { db, cleanup } = createDb();
  try {
    const show = db.upsertRollingShow({ id: 7, title: "Severance", tvdbId: 371980, year: 2022 });
    const artwork = db.createPlexArtwork({
      rollingShowId: show.id,
      plexShowRatingKey: "100",
      plexItemRatingKey: "101",
      itemType: "season",
      seasonNumber: 1,
      originalPosterPath: "/config/plex-artwork/original.jpg",
      overlayPosterPath: "/config/plex-artwork/overlay.jpg",
      overlaySha256: "abc123",
    });
    assert.equal(artwork.overlayApplied, false);
    db.setPlexArtworkOverlayApplied(artwork.id, true);
    assert.equal(db.getPlexArtwork(show.id, "101", "season")?.overlayApplied, true);
  } finally {
    cleanup();
  }
});
