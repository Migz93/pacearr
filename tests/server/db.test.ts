import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { PacearrDatabase } from "../../src/server/db/index.js";
import { runMigrations } from "../../src/server/db/migrations.js";
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

test("Tautulli resolver prefers an exact username match and refuses to guess between ambiguous display names", () => {
  const { db, cleanup } = createDb();
  try {
    // username has no uniqueness constraint in the schema, and display_name even less
    // so — Plex Home profiles commonly share generic names. A bare OR query with .get()
    // would pick an arbitrary row on a tie, silently attributing one person's Tautulli
    // history to a different Pacearr user.
    db.upsertUsers([
      { plexUserId: "plex-alice", plexAccountId: "1", tautulliUserId: null, username: "alice_h", displayName: "Kid", avatarUrl: null },
      { plexUserId: "plex-bob", plexAccountId: "2", tautulliUserId: null, username: "bob_h", displayName: "Kid", avatarUrl: null },
    ]);
    const alice = db.listUsers().find((user) => user.plexUserId === "plex-alice")!;
    const bob = db.listUsers().find((user) => user.plexUserId === "plex-bob")!;

    // Exact username match wins even when it would also match another user's display name.
    const resolve = db.createTautulliUserResolver();
    assert.equal(resolve(null, "alice_h")?.id, alice.id);
    assert.equal(resolve(null, "bob_h")?.id, bob.id);

    // Two users share this display name and neither has it as a username — ambiguous,
    // so the lookup must refuse to guess rather than returning whichever row SQLite
    // happens to return first.
    assert.equal(resolve(null, "Kid"), null);
  } finally {
    cleanup();
  }
});

test("Tautulli resolver refuses to guess between two users whose usernames collide case-insensitively, and does not fall through to display_name on that tie", () => {
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
      // Third user has an unambiguous display_name equal to the same query string. If
      // the ambiguous-username case ever regressed into falling through to the
      // display_name step instead of returning null immediately, this user would be
      // matched and the assertion below would catch it — without this user, "kid" also
      // matches nobody's display_name, so a query returning null wouldn't distinguish
      // "refused to guess" from "found nothing either way."
      { plexUserId: "plex-kid-3", plexAccountId: "3", tautulliUserId: null, username: "someone-else", displayName: "KID", avatarUrl: null },
    ]);
    assert.equal(db.createTautulliUserResolver()(null, "KID"), null);
  } finally {
    cleanup();
  }
});

test("Tautulli resolver falls back to an unambiguous display name match", () => {
  const { db, cleanup } = createDb();
  try {
    db.upsertUsers([
      { plexUserId: "plex-carol", plexAccountId: "3", tautulliUserId: null, username: "carol87", displayName: "Carol", avatarUrl: null },
    ]);
    const carol = db.listUsers().find((user) => user.plexUserId === "plex-carol")!;
    // Tautulli reported "Carol" (a custom friendly name), which matches nobody's username
    // but exactly one display_name — the case this method exists for.
    assert.equal(db.createTautulliUserResolver()(null, "carol")?.id, carol.id);
  } finally {
    cleanup();
  }
});

test("Tautulli resolver matches on the Plex username even when the Tautulli friendly name matches nobody", () => {
  const { db, cleanup } = createDb();
  try {
    // Regression for #75: a Tautulli admin can rename the friendly name ("user") freely
    // without touching Plex, so the lookup must not depend on it matching anything —
    // the real Plex username alone has to be enough.
    const [dave] = db.upsertUsers([
      { plexUserId: "plex-dave", plexAccountId: "4", tautulliUserId: null, username: "dave_plex", displayName: "Dave", avatarUrl: null },
    ]);
    assert.equal(db.createTautulliUserResolver()(null, "dave_plex", "Big Chief Dave")?.id, dave.id);
  } finally {
    cleanup();
  }
});

test("Tautulli resolver falls back to the friendly name when the Plex username matches nobody", () => {
  const { db, cleanup } = createDb();
  try {
    // Managed/Home Plex users have no real Plex.tv username, so Tautulli's `username`
    // field for them is frequently empty or unrelated to anything Pacearr stored.
    const [erin] = db.upsertUsers([
      { plexUserId: "plex-erin", plexAccountId: "5", tautulliUserId: null, username: "erin_plex", displayName: "Erin", avatarUrl: null },
    ]);
    const resolve = db.createTautulliUserResolver();
    assert.equal(resolve(null, null, "Erin")?.id, erin.id);
    assert.equal(resolve(null, "nonexistent_username", "Erin")?.id, erin.id);
  } finally {
    cleanup();
  }
});

test("Tautulli resolver refuses to guess when the Plex username is ambiguous, even if the friendly name uniquely matches a different user", () => {
  const { db, cleanup } = createDb();
  try {
    db.upsertUsers([
      { plexUserId: "plex-kid-1", plexAccountId: "1", tautulliUserId: null, username: "Kid", displayName: "Kid A", avatarUrl: null },
      { plexUserId: "plex-kid-2", plexAccountId: "2", tautulliUserId: null, username: "kid", displayName: "Kid B", avatarUrl: null },
      { plexUserId: "plex-dave", plexAccountId: "3", tautulliUserId: null, username: "dave_plex", displayName: "Dave", avatarUrl: null },
    ]);
    // The Plex username "Kid" is ambiguous between two users. Tautulli's friendly name for
    // this event coincidentally matches a completely unrelated third user's username — the
    // lookup must not fall through to that weaker signal once the stronger one is already
    // ambiguous, or it silently misattributes the event to whoever the friendly name
    // happens to match.
    assert.equal(db.createTautulliUserResolver()(null, "Kid", "dave_plex"), null);
  } finally {
    cleanup();
  }
});

test("Tautulli resolver tries the friendly name when the Plex username only collides ambiguously on display_name, not on username itself", () => {
  const { db, cleanup } = createDb();
  try {
    db.upsertUsers([
      { plexUserId: "plex-kid-1", plexAccountId: "1", tautulliUserId: null, username: "alice_h", displayName: "Kid", avatarUrl: null },
      { plexUserId: "plex-kid-2", plexAccountId: "2", tautulliUserId: null, username: "bob_h", displayName: "Kid", avatarUrl: null },
    ]);
    const [carol] = db.upsertUsers([
      { plexUserId: "plex-carol", plexAccountId: "3", tautulliUserId: null, username: "carol87", displayName: "Carol", avatarUrl: null },
    ]);
    // "Kid" matches nobody's real username, and only ambiguously matches two users'
    // display_name as a fallback — a failed primary lookup, not the kind of conflict on
    // the strong signal that should block trying the independent friendly name, which
    // uniquely identifies Carol here.
    assert.equal(db.createTautulliUserResolver()(null, "Kid", "carol87")?.id, carol.id);
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

test("the split library refresh job inherits the old combined job state on upgrade", () => {
  const { db, dir, cleanup } = createDb();
  try {
    const lastRunAt = "2026-08-10T12:00:00.000Z";
    db.saveJobRunState("recommendation-refresh", { lastRunAt, lastRunStatus: "success" });

    // Model an existing installation immediately before this release: its old combined
    // job row exists, but the newly split library job row has not been seeded yet.
    const raw = new Database(path.join(dir, "pacearr.db"));
    raw.prepare("DELETE FROM job_run_state WHERE job_id = 'sonarr-library-refresh'").run();
    raw.close();

    const upgraded = new PacearrDatabase({ port: 9302, dataDir: dir, sessionCookieName: "pacearr_test", sessionTtlMs: 1000, logLevel: "error" });
    assert.deepEqual(upgraded.getJobRunState("sonarr-library-refresh"), { lastRunAt, lastRunStatus: "success" });
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

test("a recent special (season 0) does not count as an active show, but still counts as last watched", () => {
  const { db, cleanup } = createDb();
  try {
    // Specials never expand a season (see the seasonNumber > 0 gate in processWatchEvent),
    // so counting one here as "active" would tell a viewer their switch is keeping a show
    // expanded when it isn't.
    const [dana] = db.upsertUsers([
      { plexUserId: "plex-dana", plexAccountId: "6", tautulliUserId: null, username: "dana", displayName: "Dana", avatarUrl: null },
    ]);
    const show = db.upsertRollingShow({ id: 13, title: "Doctor Who" });

    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertRollingUserProgress(show.id, dana.id, 0, 1, recent);

    const activity = db.countActiveShowsByUser(cutoff);
    assert.equal(activity.get(dana.id)?.activeShowCount, 0);
    assert.equal(activity.get(dana.id)?.lastWatchedAt, recent);
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

test("a recommendation cache row with corrupted JSON is treated as absent, not as zero candidates", () => {
  const { db, dir, cleanup } = createDb();
  try {
    // getRecommendationCache used to parse through a helper whose fallback-on-error
    // returned [], which passes the array/shape check vacuously and reads as a genuine
    // "0 candidates" cache instead of triggering the refresh callers expect from null.
    const raw = new Database(path.join(dir, "pacearr.db"));
    raw.prepare("INSERT INTO recommendation_cache (id, candidates, generated_at) VALUES (1, ?, ?)")
      .run("{not valid json", new Date().toISOString());
    raw.close();
    assert.equal(db.getRecommendationCache(), null);
  } finally {
    cleanup();
  }
});

test("a malformed Sonarr library cache is treated as absent", () => {
  const { db, dir, cleanup } = createDb();
  try {
    const raw = new Database(path.join(dir, "pacearr.db"));
    raw.prepare("INSERT INTO sonarr_library_cache (id, series, generated_at) VALUES (1, ?, ?)")
      .run("{not valid json", new Date().toISOString());
    raw.close();
    assert.equal(db.getSonarrLibraryCache(), null);

    const raw2 = new Database(path.join(dir, "pacearr.db"));
    raw2.prepare("UPDATE sonarr_library_cache SET series = ? WHERE id = 1")
      .run(JSON.stringify([{ series: { id: 1 }, posterUrl: null }]));
    raw2.close();
    assert.equal(db.getSonarrLibraryCache(), null);
  } finally {
    cleanup();
  }
});

test("a recommendation cache with non-numeric season entries is treated as absent", () => {
  const { db, dir, cleanup } = createDb();
  try {
    const raw = new Database(path.join(dir, "pacearr.db"));
    const badSeasons = [{
      sonarrSeriesId: 1, title: "Fringe", year: 2008, posterUrl: null, status: null,
      seasonCount: 5, episodeCount: 100, sizeOnDiskBytes: 0,
      retainedSeasons: ["2"], droppedSeasons: [2], // retainedSeasons entry is a string, not a number
      viewerCount: 0, viewers: [], projectedSavingsBytes: 1, ignored: false,
    }];
    raw.prepare("INSERT INTO recommendation_cache (id, candidates, generated_at) VALUES (1, ?, ?)")
      .run(JSON.stringify(badSeasons), new Date().toISOString());
    raw.close();
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

test("a previously orphaned Tautulli watch event can be repaired once its user resolves", () => {
  const { db, cleanup } = createDb();
  try {
    // Regression for #75: before the matching fix, a Tautulli event whose friendly name
    // matched nobody imported with user_id = NULL and INSERT OR IGNORE means it's never
    // revisited on its own — this is the targeted repair for that orphaned row.
    const [dave] = db.upsertUsers([
      { plexUserId: "plex-dave", plexAccountId: "4", tautulliUserId: null, username: "dave_plex", displayName: "Dave", avatarUrl: null },
    ]);
    db.insertWatchEvent({
      source: "tautulli", sourceEventId: "tautulli-orphan-1", userId: null, plexAccountId: null, username: "Big Chief Dave",
      sonarrSeriesId: 99, showTitle: "The Expanse", seasonNumber: 1, episodeNumber: 3,
      watchedAt: "2026-04-12T10:00:00.000Z", rawPayload: {},
    });
    assert.equal(db.repairUnmatchedTautulliWatchEvent("tautulli-orphan-1", dave.id), true);
    assert.deepEqual(db.listLatestWatchProgressForUser(dave.id), [{ sonarrSeriesId: 99, seasonNumber: 1, episodeNumber: 3, watchedAt: "2026-04-12T10:00:00.000Z" }]);
    // Already-assigned events must not be re-attributed by a later, different resolution.
    assert.equal(db.repairUnmatchedTautulliWatchEvent("tautulli-orphan-1", dave.id), false);
  } finally {
    cleanup();
  }
});

test("mapping a Tautulli identity persists it and links that identity's orphaned history", () => {
  const { db, cleanup } = createDb();
  try {
    const [dave] = db.upsertUsers([
      { plexUserId: "plex-dave", plexAccountId: "4", tautulliUserId: null, username: "dave_plex", displayName: "Dave", avatarUrl: null },
    ]);
    db.insertWatchEvent({
      source: "tautulli", sourceEventId: "tautulli-orphan-mapping", userId: null, plexAccountId: null, username: "Different Tautulli Name",
      sonarrSeriesId: 99, showTitle: "The Expanse", seasonNumber: 1, episodeNumber: 5,
      watchedAt: "2026-04-13T10:00:00.000Z", rawPayload: { user_id: 47, user: "Different Tautulli Name" },
    });

    assert.deepEqual(db.listUnmappedTautulliUsers(), [{
      tautulliUserId: "47", username: "Different Tautulli Name", friendlyName: "Different Tautulli Name", eventCount: 1,
      lastWatchedAt: "2026-04-13T10:00:00.000Z",
    }]);
    db.mapTautulliUser(dave.id, "47", "Different Tautulli Name");
    assert.equal(db.linkUnassignedTautulliWatchEvents(dave.id, "47"), 1);
    const resolve = db.createTautulliUserResolver();
    assert.equal(resolve("47", "renamed-again")?.id, dave.id);
    assert.equal(resolve(null, "Different Tautulli Name")?.id, dave.id);
    assert.equal(db.getUser(dave.id)?.tautulliUsername, "Different Tautulli Name");
    assert.deepEqual(db.listLatestWatchProgressForUser(dave.id), [{ sonarrSeriesId: 99, seasonNumber: 1, episodeNumber: 5, watchedAt: "2026-04-13T10:00:00.000Z" }]);
    assert.deepEqual(db.listUnmappedTautulliUsers(), []);
  } finally {
    cleanup();
  }
});

test("mapping cannot replace a user's existing Tautulli identity", () => {
  const { db, cleanup } = createDb();
  try {
    const [dave] = db.upsertUsers([
      { plexUserId: "plex-dave", plexAccountId: "4", tautulliUserId: null, username: "dave_plex", displayName: "Dave", avatarUrl: null },
    ]);
    db.mapTautulliUser(dave.id, "47", "Dave on Tautulli");
    assert.throws(() => db.mapTautulliUser(dave.id, "48", "Different Dave"), /Tautulli user mapping conflict/);
    assert.equal(db.getUser(dave.id)?.tautulliUserId, "47");
  } finally {
    cleanup();
  }
});

test("mapping rejects a Tautulli identity already assigned to another user", () => {
  const { db, cleanup } = createDb();
  try {
    const [alice, bob] = db.upsertUsers([
      { plexUserId: "plex-alice-conflict", plexAccountId: "47", tautulliUserId: null, username: "alice", displayName: "Alice", avatarUrl: null },
      { plexUserId: "plex-bob-conflict", plexAccountId: "48", tautulliUserId: null, username: "bob", displayName: "Bob", avatarUrl: null },
    ]);
    db.mapTautulliUser(alice.id, "tautulli-47", "Alice on Tautulli");
    assert.throws(() => db.mapTautulliUser(bob.id, "tautulli-47", "Alice on Tautulli"), /Tautulli user mapping conflict/);
    assert.equal(db.getUser(bob.id)?.tautulliUserId, null);
  } finally {
    cleanup();
  }
});

test("unmapped Tautulli users display the names from their newest event", () => {
  const { db, cleanup } = createDb();
  try {
    const older = "2026-04-01T10:00:00.000Z";
    const newer = "2026-04-02T10:00:00.000Z";
    db.insertWatchEvent({ source: "tautulli", sourceEventId: "older", userId: null, plexAccountId: null, username: "Zoe", sonarrSeriesId: null, showTitle: "The Expanse", seasonNumber: 1, episodeNumber: 1, watchedAt: older, rawPayload: { user_id: "47", user: "Old friendly name" } });
    db.insertWatchEvent({ source: "tautulli", sourceEventId: "newer", userId: null, plexAccountId: null, username: "Adam", sonarrSeriesId: null, showTitle: "The Expanse", seasonNumber: 1, episodeNumber: 2, watchedAt: newer, rawPayload: { user_id: "47", user: "New friendly name" } });

    assert.deepEqual(db.listUnmappedTautulliUsers(), [{
      tautulliUserId: "47", username: "Adam", friendlyName: "New friendly name", eventCount: 2, lastWatchedAt: newer,
    }]);
  } finally {
    cleanup();
  }
});

test("the cached Tautulli resolver preserves stable-ID and ambiguity safeguards", () => {
  const { db, cleanup } = createDb();
  try {
    const [alice] = db.upsertUsers([
      { plexUserId: "plex-alice", plexAccountId: "1", tautulliUserId: null, username: "alice", displayName: "Alice", avatarUrl: null },
      { plexUserId: "plex-bob", plexAccountId: "2", tautulliUserId: null, username: "kid", displayName: "Bob", avatarUrl: null },
      { plexUserId: "plex-carol", plexAccountId: "3", tautulliUserId: null, username: "KID", displayName: "Carol", avatarUrl: null },
    ]);
    db.mapTautulliUser(alice.id, "47", "Alice on Tautulli");
    const resolve = db.createTautulliUserResolver();

    assert.equal(resolve("47", "renamed", "renamed")?.id, alice.id);
    assert.equal(resolve(null, "KID", "Carol"), null);
    assert.equal(resolve(null, "nobody", "Alice")?.id, alice.id);
  } finally {
    cleanup();
  }
});

test("an ambiguous saved Tautulli username is never resolved through a weaker fallback", () => {
  const { db, cleanup } = createDb();
  try {
    const [alice, bob, carol] = db.upsertUsers([
      { plexUserId: "plex-alice", plexAccountId: "1", tautulliUserId: null, username: "alice", displayName: "Alice", avatarUrl: null },
      { plexUserId: "plex-bob", plexAccountId: "2", tautulliUserId: null, username: "bob", displayName: "Bob", avatarUrl: null },
      { plexUserId: "plex-carol", plexAccountId: "3", tautulliUserId: null, username: "carol", displayName: "Carol", avatarUrl: null },
    ]);
    db.updateUser(alice.id, { tautulliUsername: "Kid" });
    db.updateUser(bob.id, { tautulliUsername: "kid" });
    db.updateUser(carol.id, { tautulliUsername: "Carol's Tautulli" });

    // A friendly-name hit for Carol must not override the ambiguous stronger
    // saved-name signal for Kid — that could assign history to the wrong viewer.
    assert.equal(db.createTautulliUserResolver()(null, "KID", "Carol's Tautulli"), null);
  } finally {
    cleanup();
  }
});

test("Tautulli username backfill uses a managed user's friendly name when their username is blank", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-migration-test-"));
  const raw = new Database(path.join(dir, "pacearr.db"));
  try {
    // Version 18 is the pre-backfill state; version 19 performs the username backfill.
    runMigrations(raw, undefined, 18);
    const stamp = "2026-08-12T09:00:00.000Z";
    raw.prepare(`
      INSERT INTO users (plex_user_id, plex_account_id, username, display_name, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("plex-managed", "1", "managed", "Managed", 1, stamp, stamp);
    raw.prepare(`
      INSERT INTO watch_events (source, source_event_id, user_id, show_title, season_number, episode_number, watched_at, raw_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("tautulli", "managed-history", 1, "The Expanse", 1, 1, stamp, JSON.stringify({ user: "Managed Kid" }), stamp);

    // This is the exact old migration-19 state: managed-user history has no usable
    // event username, so version 19 leaves the editor field empty.
    runMigrations(raw, undefined, 19);
    assert.equal((raw.prepare("SELECT tautulli_username FROM users WHERE id = 1").get() as { tautulli_username: string | null }).tautulli_username, null);

    runMigrations(raw);
    assert.equal((raw.prepare("SELECT tautulli_username FROM users WHERE id = 1").get() as { tautulli_username: string | null }).tautulli_username, "Managed Kid");
  } finally {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 17 retains one duplicate Tautulli identity before adding its unique index", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacearr-migration-test-"));
  const raw = new Database(path.join(dir, "pacearr.db"));
  try {
    runMigrations(raw, undefined, 16);
    const stamp = "2026-08-12T09:00:00.000Z";
    const insert = raw.prepare(`
      INSERT INTO users (plex_user_id, plex_account_id, tautulli_user_id, username, display_name, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("plex-first", "1", "tautulli-42", "first", "First", 1, stamp, stamp);
    insert.run("plex-second", "2", "tautulli-42", "second", "Second", 1, stamp, stamp);
    raw.prepare(`
      INSERT INTO watch_events (source, source_event_id, user_id, show_title, season_number, episode_number, watched_at, raw_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("tautulli", "duplicate-user-history", 2, "The Expanse", 1, 1, stamp, "{}", stamp);

    runMigrations(raw, undefined, 17);
    const users = raw.prepare("SELECT plex_user_id, tautulli_user_id FROM users ORDER BY id").all() as Array<{ plex_user_id: string; tautulli_user_id: string | null }>;
    assert.deepEqual(users, [
      { plex_user_id: "plex-first", tautulli_user_id: "tautulli-42" },
      { plex_user_id: "plex-second", tautulli_user_id: null },
    ]);
    assert.equal((raw.prepare("SELECT user_id FROM watch_events WHERE source_event_id = ?").get("duplicate-user-history") as { user_id: number }).user_id, 2);
  } finally {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
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
