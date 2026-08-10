import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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
  return { db, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * addHistory always stamps created_at with the current time - there's no legitimate
 * production reason for a caller to backdate it themselves. Tests that need to exercise
 * age-based pruning open a second connection to the same file just to set it directly.
 */
function backdateHistoryEvent(dir: string, title: string, createdAt: string) {
  const raw = new Database(path.join(dir, "pacearr.db"));
  raw.prepare("UPDATE history_events SET created_at = ? WHERE title = ?").run(createdAt, title);
  raw.close();
}

test("findUserByTautulliName prefers an exact username match and refuses to guess between ambiguous display names", () => {
  const { db, cleanup } = createDb();
  try {
    // username has no uniqueness constraint in the schema, and display_name even less
    // so — Plex Home profiles commonly share generic names. A bare OR query with .get()
    // would pick an arbitrary row on a tie, silently attributing one person's Tautulli
    // history to a different Pacearr user.
    const [alice, bob] = db.upsertUsers([
      { plexUserId: "plex-alice", plexAccountId: "1", tautulliUserId: null, username: "alice_h", displayName: "Kid", avatarUrl: null },
      { plexUserId: "plex-bob", plexAccountId: "2", tautulliUserId: null, username: "bob_h", displayName: "Kid", avatarUrl: null },
    ]);

    // Exact username match wins even when it would also match another user's display name.
    assert.equal(db.findUserByTautulliName("alice_h")?.id, alice.id);
    assert.equal(db.findUserByTautulliName("bob_h")?.id, bob.id);

    // Two users share this display name and neither has it as a username — ambiguous,
    // so the lookup must refuse to guess rather than returning whichever row SQLite
    // happens to return first.
    assert.equal(db.findUserByTautulliName("Kid"), null);
  } finally {
    cleanup();
  }
});

test("findUserByTautulliName refuses to guess between two users whose usernames collide case-insensitively", () => {
  const { db, cleanup } = createDb();
  try {
    // The username step used to trust a bare .get() as if a match there always meant
    // exactly one row — but username has no uniqueness constraint either, and the
    // lookup is case-insensitive, so "Kid" and "kid" collide. Matches the display-name
    // fallback's own "refuse to guess on a tie" rule rather than picking whichever row
    // SQLite returns first.
    db.upsertUsers([
      { plexUserId: "plex-kid-1", plexAccountId: "1", tautulliUserId: null, username: "Kid", displayName: "Kid A", avatarUrl: null },
      { plexUserId: "plex-kid-2", plexAccountId: "2", tautulliUserId: null, username: "kid", displayName: "Kid B", avatarUrl: null },
    ]);
    assert.equal(db.findUserByTautulliName("KID"), null);
  } finally {
    cleanup();
  }
});

test("findUserByTautulliName falls back to an unambiguous display name match", () => {
  const { db, cleanup } = createDb();
  try {
    const [carol] = db.upsertUsers([
      { plexUserId: "plex-carol", plexAccountId: "3", tautulliUserId: null, username: "carol87", displayName: "Carol", avatarUrl: null },
    ]);
    // Tautulli reported "Carol" (a custom friendly name), which matches nobody's username
    // but exactly one display_name — the case this method exists for.
    assert.equal(db.findUserByTautulliName("carol")?.id, carol.id);
  } finally {
    cleanup();
  }
});

test("updateUser with an empty patch preserves the current enabled state", () => {
  const { db, cleanup } = createDb();
  try {
    // The route that calls this (PATCH /api/users/:id) used to coerce a genuinely absent
    // `enabled` field into `false` before it ever reached this method — that bug lived in
    // app.ts, not here, but this locks in that updateUser's own `patch.enabled ??
    // current.enabled` does the right thing when nothing overrides it.
    const [user] = db.upsertUsers([
      { plexUserId: "plex-frank", plexAccountId: "6", tautulliUserId: null, username: "frank", displayName: "Frank", avatarUrl: null },
    ]);
    db.updateUser(user.id, { enabled: true });
    const unchanged = db.updateUser(user.id, {});
    assert.equal(unchanged.enabled, true);
  } finally {
    cleanup();
  }
});

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

test("early-prefetched episodes persist their triggering user and clear on expansion", () => {
  const { db, cleanup } = createDb();
  try {
    const [user] = db.upsertUsers([{ plexUserId: "plex-prefetch", plexAccountId: "2", tautulliUserId: null, username: "bob", displayName: "Bob", avatarUrl: "avatar" }]);
    const show = db.upsertRollingShow({ id: 43, title: "The Expanse" });
    assert.equal(db.recordPrefetchedEpisodes(show.id, user.id, 2, [2, 3], "2026-08-03T10:00:00.000Z"), 2);
    assert.equal(db.recordPrefetchedEpisodes(show.id, user.id, 2, [2, 3], "2026-08-03T11:00:00.000Z"), 0);
    assert.deepEqual(db.listPrefetchedEpisodesWithUsers(show.id).map((episode) => ({
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      displayName: episode.displayName,
      triggeredAt: episode.triggeredAt,
    })), [
      { seasonNumber: 2, episodeNumber: 2, displayName: "Bob", triggeredAt: "2026-08-03T10:00:00.000Z" },
      { seasonNumber: 2, episodeNumber: 3, displayName: "Bob", triggeredAt: "2026-08-03T10:00:00.000Z" },
    ]);
    db.clearPrefetchedEpisodes(show.id);
    assert.deepEqual(db.listPrefetchedEpisodes(show.id), []);
    assert.equal(db.recordPrefetchedEpisodes(show.id, user.id, 2, [2], "2026-08-03T11:00:00.000Z"), 1);
    db.markSeasonExpanded(show.id, 2, "2026-08-03T12:00:00.000Z");
    assert.deepEqual(db.listPrefetchedEpisodes(show.id), []);
  } finally {
    cleanup();
  }
});

test("rolling progress follows a viewer's most recent watch, even after a rewatch starts in an earlier season", () => {
  const { db, cleanup } = createDb();
  try {
    const [user] = db.upsertUsers([{ plexUserId: "plex-1", plexAccountId: "1", tautulliUserId: null, username: "alice", displayName: "Alice", avatarUrl: null }]);
    const rolling = db.upsertRollingShow({ id: 42, title: "Fringe" });
    assert.equal(db.upsertRollingUserProgress(rolling.id, user.id, 5, 8, "2025-01-01T10:00:00.000Z"), true);
    assert.equal(db.upsertRollingUserProgress(rolling.id, user.id, 1, 3, "2026-07-13T10:00:00.000Z"), true);
    assert.equal(db.upsertRollingUserProgress(rolling.id, user.id, 5, 9, "2025-02-01T10:00:00.000Z"), false);

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
    assert.equal(db.getAppSettings().progressiveCleanupDelayDays, 7);
    assert.equal(db.getAppSettings().earlyPrefetchEnabled, false);
    assert.equal(db.getAppSettings().earlyPrefetchTriggerEpisodesRemaining, 3);
    assert.equal(db.getAppSettings().earlyPrefetchEpisodeCount, 2);
    assert.equal(db.updateAppSettings({ cleanupDeletesFiles: false }).cleanupDeletesFiles, true);
    assert.equal(db.updateAppSettings({ progressiveCleanupDelayDays: 3 }).progressiveCleanupDelayDays, 3);
  } finally {
    cleanup();
  }
});

test("season inactivity timestamps persist until a viewer returns or the season is cleaned", () => {
  const { db, cleanup } = createDb();
  try {
    const show = db.upsertRollingShow({ id: 7, title: "Severance", tvdbId: 371980, year: 2022 });
    db.markSeasonInactive(show.id, 1, "2026-04-01T10:00:00.000Z");
    // A later observation must not restart a retention period already in progress.
    db.markSeasonInactive(show.id, 1, "2026-04-03T10:00:00.000Z");
    assert.equal(db.getSeasonInactiveSince(show.id, 1), "2026-04-01T10:00:00.000Z");
    db.clearSeasonInactivity(show.id, 1);
    assert.equal(db.getSeasonInactiveSince(show.id, 1), null);
    db.markSeasonInactive(show.id, 1, "2026-04-04T10:00:00.000Z");
    db.removeExpandedSeason(show.id, 1);
    assert.equal(db.getSeasonInactiveSince(show.id, 1), null);
  } finally {
    cleanup();
  }
});

test("per-user activity windows the show count but not the last-watched timestamp", () => {
  const { db, cleanup } = createDb();
  try {
    const [alice, bob] = db.upsertUsers([
      { plexUserId: "plex-alice", plexAccountId: "1", tautulliUserId: null, username: "alice", displayName: "Alice", avatarUrl: null },
      { plexUserId: "plex-bob", plexAccountId: "2", tautulliUserId: null, username: "bob", displayName: "Bob", avatarUrl: null },
    ]);
    const fringe = db.upsertRollingShow({ id: 10, title: "Fringe" });
    const wire = db.upsertRollingShow({ id: 11, title: "The Wire" });

    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    db.upsertRollingUserProgress(fringe.id, alice.id, 2, 4, recent);
    db.upsertRollingUserProgress(wire.id, alice.id, 1, 1, old);
    db.upsertRollingUserProgress(fringe.id, bob.id, 1, 3, old);

    const activity = db.countActiveShowsByUser(cutoff);
    // Alice drives one show inside the window, but her other, older watch still counts
    // toward "last watched" — a quiet viewer shows when they were last seen, not "never".
    assert.equal(activity.get(alice.id)?.activeShowCount, 1);
    assert.equal(activity.get(alice.id)?.lastWatchedAt, recent);
    assert.equal(activity.get(bob.id)?.activeShowCount, 0);
    assert.equal(activity.get(bob.id)?.lastWatchedAt, old);

    assert.deepEqual(db.listShowsDrivenByUser(alice.id).map((show) => show.title), ["Fringe", "The Wire"]);
  } finally {
    cleanup();
  }
});

test("a disabled user's recent watch does not count as an active show, but still counts as last watched", () => {
  const { db, cleanup } = createDb();
  try {
    // A disabled viewer's progress can't keep a season expanded — every retention
    // calculation in services.ts filters on user.enabled — so counting their shows as
    // "active" here would claim an effect the switch doesn't actually have.
    const [carol] = db.upsertUsers([
      { plexUserId: "plex-carol", plexAccountId: "3", tautulliUserId: null, username: "carol", displayName: "Carol", avatarUrl: null },
    ]);
    db.updateUser(carol.id, { enabled: false });
    const show = db.upsertRollingShow({ id: 12, title: "Deadwood" });

    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertRollingUserProgress(show.id, carol.id, 1, 1, recent);

    const activity = db.countActiveShowsByUser(cutoff);
    assert.equal(activity.get(carol.id)?.activeShowCount, 0);
    assert.equal(activity.get(carol.id)?.lastWatchedAt, recent);
  } finally {
    cleanup();
  }
});

test("a recommendation cache written in an older field shape is treated as absent", () => {
  const { db, dir, cleanup } = createDb();
  try {
    // Recommendations are cached as whole objects in JSON, so renaming a field (watchers
    // -> viewers) leaves existing installs holding rows the client reads as undefined.
    // Reporting the stale cache as absent makes the callers trigger a refresh instead.
    const raw = new Database(path.join(dir, "pacearr.db"));
    const legacy = [{ sonarrSeriesId: 1, title: "Fringe", watchers: [], watcherCount: 0 }];
    raw.prepare("INSERT INTO recommendation_cache (id, candidates, generated_at) VALUES (1, ?, ?)")
      .run(JSON.stringify(legacy), new Date().toISOString());
    raw.close();
    assert.equal(db.getRecommendationCache(), null);

    db.saveRecommendationCache([
      { sonarrSeriesId: 1, title: "Fringe", year: 2008, posterUrl: null, status: null, seasonCount: 5, episodeCount: 100, sizeOnDiskBytes: 0, retainedSeasons: [], droppedSeasons: [2], viewerCount: 0, viewers: [], projectedSavingsBytes: 1, ignored: false },
    ]);
    assert.equal(db.getRecommendationCache()?.candidates.length, 1);
  } finally {
    cleanup();
  }
});

test("a recommendation cache missing any field, not just viewers/viewerCount, is treated as absent", () => {
  const { db, dir, cleanup } = createDb();
  try {
    // The guard used to check only the two fields that broke last time (viewers,
    // viewerCount). A row with those two present but sizeOnDiskBytes missing would have
    // passed the old check and then crashed formatBytes(undefined) downstream. Same for a
    // malformed entry nested inside viewers — a real client crash either way.
    const raw = new Database(path.join(dir, "pacearr.db"));
    const missingField = [{
      sonarrSeriesId: 1, title: "Fringe", year: 2008, posterUrl: null, status: null,
      seasonCount: 5, episodeCount: 100, retainedSeasons: [], droppedSeasons: [2],
      viewerCount: 0, viewers: [], projectedSavingsBytes: 1, ignored: false,
      // sizeOnDiskBytes intentionally omitted
    }];
    raw.prepare("INSERT INTO recommendation_cache (id, candidates, generated_at) VALUES (1, ?, ?)")
      .run(JSON.stringify(missingField), new Date().toISOString());
    raw.close();
    assert.equal(db.getRecommendationCache(), null);

    const raw2 = new Database(path.join(dir, "pacearr.db"));
    const malformedViewer = [{
      sonarrSeriesId: 1, title: "Fringe", year: 2008, posterUrl: null, status: null,
      seasonCount: 5, episodeCount: 100, sizeOnDiskBytes: 0, retainedSeasons: [], droppedSeasons: [2],
      viewerCount: 1, viewers: [{ userId: 1, displayName: "Alice" }], // missing enabled, seasonNumber, etc.
      projectedSavingsBytes: 1, ignored: false,
    }];
    raw2.prepare("UPDATE recommendation_cache SET candidates = ? WHERE id = 1").run(JSON.stringify(malformedViewer));
    raw2.close();
    assert.equal(db.getRecommendationCache(), null);
  } finally {
    cleanup();
  }
});

test("history supports filtered server-side pagination", () => {
  const { db, cleanup } = createDb();
  try {
    db.addHistory("info", "history.import", "First import", { processed: 10 });
    db.addHistory("warn", "history.import", "Second import", { errors: ["timeout"] });
    db.addHistory("info", "sessions.check", "Plex sessions", { changed: 1 });

    const firstPage = db.listHistoryPaginated({ page: 1, pageSize: 2 });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.results.length, 2);
    assert.equal(firstPage.results[0]?.title, "Plex sessions");

    const warnings = db.listHistoryPaginated({ page: 1, pageSize: 10, level: "warn" });
    assert.equal(warnings.total, 1);
    assert.equal(warnings.results[0]?.title, "Second import");
  } finally {
    cleanup();
  }
});

test("a history category filter matches an action and its dry-run twin, and nothing outside the category", () => {
  const { db, cleanup } = createDb();
  try {
    db.addHistory("info", "sonarr.expand_season", "Fringe", { seasonNumber: 2 });
    db.addHistory("info", "dry_run.sonarr.expand_season", "The Wire", { seasonNumber: 3 });
    db.addHistory("info", "cleanup.progressive", "Deadwood", { seasonNumber: 1 });
    db.addHistory("info", "history.import", "Import", { processed: 4 });

    const monitoring = db.listHistoryPaginated({ page: 1, pageSize: 10, category: "monitoring" });
    assert.equal(monitoring.total, 2);
    assert.deepEqual(monitoring.results.map((event) => event.title).sort(), ["Fringe", "The Wire"]);

    const cleanup_ = db.listHistoryPaginated({ page: 1, pageSize: 10, category: "cleanup" });
    assert.deepEqual(cleanup_.results.map((event) => event.title), ["Deadwood"]);

    // Level and category stack rather than replacing each other.
    assert.equal(db.listHistoryPaginated({ page: 1, pageSize: 10, category: "monitoring", level: "warn" }).total, 0);
  } finally {
    cleanup();
  }
});

test("a legacy watch_events.reconciled row, from before that action stopped being written, still appears under the Sync category", () => {
  const { db, cleanup } = createDb();
  try {
    // Nothing writes this action any more (see history-noise.test.ts), but an install
    // that ran an older version can already have rows with it, and it was always sync
    // activity — dropping it from CATEGORY_BY_ACTION would make those existing rows
    // disappear from the Sync filter, not just stop new ones from being added.
    db.addHistory("info", "watch_events.reconciled", "Reconciled", { matchedEvents: 2 });
    const sync = db.listHistoryPaginated({ page: 1, pageSize: 10, category: "sync" });
    assert.deepEqual(sync.results.map((event) => event.title), ["Reconciled"]);
  } finally {
    cleanup();
  }
});

test("pruning history events by retention only removes events older than the cutoff, and leaves watch_events/reclaimed_storage_events alone", () => {
  const { db, dir, cleanup } = createDb();
  try {
    db.addHistory("info", "history.import", "Old entry", { processed: 1 });
    db.addHistory("info", "history.import", "Recent entry", { processed: 2 });
    backdateHistoryEvent(dir, "Old entry", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    backdateHistoryEvent(dir, "Recent entry", new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString());

    const [user] = db.upsertUsers([{ plexUserId: "plex-retention", plexAccountId: "9", tautulliUserId: null, username: "retention", displayName: "Retention", avatarUrl: null }]);
    db.upsertRollingShow({ id: 900, title: "Retention Show" });
    db.insertWatchEvent({
      source: "plex-history",
      sourceEventId: "retention-evt-1",
      userId: user!.id,
      plexAccountId: "9",
      username: "retention",
      sonarrSeriesId: 900,
      showTitle: "Retention Show",
      seasonNumber: 1,
      episodeNumber: 1,
      watchedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      rawPayload: {},
    });
    db.recordStorageReclaim({ rollingShowId: null, sonarrSeriesId: 900, showTitle: "Retention Show", action: "cleanup.progressive", seasonNumber: 1, fileCount: 1, bytesReclaimed: 500 });

    const pruned = db.pruneHistoryEvents(7);

    assert.equal(pruned, 1);
    assert.deepEqual(db.listHistory(10).map((event) => event.title), ["Recent entry"]);
    // Retention only ever applies to the audit log - core viewer-progress state and the
    // dashboard's lifetime reclaimed-storage total must never be touched by it.
    assert.equal(db.countWatchEvents(), 1);
    assert.equal(db.getReclaimedStorageTotals().bytesReclaimed, 500);
  } finally {
    cleanup();
  }
});

test("pruning history events does not crash on an extreme retention value", () => {
  // Regression test: retentionDays * a day-in-ms can overflow to Infinity for a
  // sufficiently large but still Number.isFinite input (e.g. 1e308, which a number input
  // field accepts as valid scientific notation), producing an invalid Date whose
  // toISOString() throws RangeError. Confirmed this crashed rolling-reconcile entirely.
  const { db, cleanup } = createDb();
  try {
    db.addHistory("info", "history.import", "Entry", { processed: 1 });
    assert.doesNotThrow(() => db.pruneHistoryEvents(1e308));
  } finally {
    cleanup();
  }
});

test("pruning history events with a zero or negative retention value does not wipe every row", () => {
  // Regression test: the same defensive clamp only bounded the upper end
  // (Math.min(retentionDays, MAX_SAFE_RETENTION_DAYS)). A retentionDays of 0 or negative
  // pushes the cutoff to now-or-future, and DELETE FROM history_events WHERE created_at <
  // cutoff would then match every row - silently wiping the entire audit log with no
  // error, which is worse than the overflow crash this was written to guard against.
  const { db, cleanup } = createDb();
  try {
    db.addHistory("info", "history.import", "Entry one", { processed: 1 });
    db.addHistory("info", "history.import", "Entry two", { processed: 2 });

    assert.equal(db.pruneHistoryEvents(0), 0);
    assert.equal(db.listHistory(10).length, 2);

    assert.equal(db.pruneHistoryEvents(-5), 0);
    assert.equal(db.listHistory(10).length, 2);
  } finally {
    cleanup();
  }
});

test("pruning history events does not crash or wipe every row on a NaN retention value", () => {
  // Regression test: Math.min/Math.max both propagate NaN if either operand is NaN, so
  // the existing Math.max(1, Math.min(retentionDays, MAX)) clamp doesn't actually catch a
  // NaN input - it would still produce an invalid Date and throw. Number.isFinite has to
  // be checked before the clamp runs, not as part of the same expression.
  const { db, cleanup } = createDb();
  try {
    db.addHistory("info", "history.import", "Entry", { processed: 1 });
    assert.doesNotThrow(() => db.pruneHistoryEvents(NaN));
    assert.equal(db.listHistory(10).length, 1);
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
