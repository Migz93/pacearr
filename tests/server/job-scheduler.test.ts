import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JobScheduler } from "../../src/server/job-scheduler.js";

const HOUR_MS = 60 * 60 * 1000;

// Disables every job when the test ends, so a failed assertion cannot leave a
// long-interval timer keeping the test process alive.
function disableJobsAfterTest(t: TestContext, scheduler: JobScheduler) {
  t.after(() => {
    for (const job of scheduler.listJobs()) scheduler.updateJob(job.id, { enabled: false });
  });
  return scheduler;
}

function schedulerWithLastRun(t: TestContext, lastRunAt: Record<string, string | null>, options?: ConstructorParameters<typeof JobScheduler>[0]) {
  const scheduler = disableJobsAfterTest(t, new JobScheduler(options));
  scheduler.setPersistence({
    load: (id) => ({ lastRunAt: lastRunAt[id] ?? null, lastRunStatus: lastRunAt[id] ? "success" : null }),
    save: () => {},
  });
  return scheduler;
}

function nextRunMs(scheduler: JobScheduler, id: string) {
  const job = scheduler.listJobs().find((entry) => entry.id === id);
  assert.ok(job?.nextRunAt, `${id} has a next run`);
  return Date.parse(job.nextRunAt);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for job run.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a job registered partway through its interval runs one interval after its last run", (t) => {
  const lastRunAt = new Date(Date.now() - 23 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun(t, { "history-import": lastRunAt });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });

  assert.equal(nextRunMs(scheduler, "history-import"), Date.parse(lastRunAt) + 24 * HOUR_MS);
});

test("an overdue job runs shortly after registration", async (t) => {
  const scheduler = schedulerWithLastRun(
    t,
    { "history-import": new Date(Date.now() - 30 * HOUR_MS).toISOString() },
    { catchUpDelayMs: 10, catchUpSpacingMs: 10 },
  );
  const contexts: boolean[] = [];
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async ({ scheduled }) => { contexts.push(scheduled); } });

  await waitFor(() => contexts.length === 1);
  assert.deepEqual(contexts, [true]);
  assert.ok(nextRunMs(scheduler, "history-import") > Date.now() + 23 * HOUR_MS, "the following run is a full interval away");
});

test("overdue jobs are staggered rather than started together", (t) => {
  const longAgo = new Date(Date.now() - 30 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun(t, { a: longAgo, b: longAgo }, { catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.registerRecurringJob({ id: "a", intervalMs: 24 * HOUR_MS, task: async () => {} });
  scheduler.registerRecurringJob({ id: "b", intervalMs: 24 * HOUR_MS, task: async () => {} });

  assert.equal(nextRunMs(scheduler, "b") - nextRunMs(scheduler, "a"), 45_000);
});

test("updating a job without changing its interval or enabled state keeps its next run", async (t) => {
  const scheduler = schedulerWithLastRun(t, { "history-import": new Date(Date.now() - HOUR_MS).toISOString() });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });
  const before = scheduler.listJobs()[0].nextRunAt;

  await new Promise((resolve) => setTimeout(resolve, 5));
  scheduler.updateJob("history-import", { intervalMs: 24 * HOUR_MS });
  scheduler.updateJob("history-import", { enabled: true });

  assert.equal(scheduler.listJobs()[0].nextRunAt, before);
});

test("changing a job's interval measures the new interval from its last run", (t) => {
  const lastRunAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun(t, { "history-import": lastRunAt });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });

  scheduler.updateJob("history-import", { intervalMs: 12 * HOUR_MS });
  assert.equal(nextRunMs(scheduler, "history-import"), Date.parse(lastRunAt) + 12 * HOUR_MS);
  scheduler.updateJob("history-import", { intervalMs: 24 * HOUR_MS });
  assert.equal(nextRunMs(scheduler, "history-import"), Date.parse(lastRunAt) + 24 * HOUR_MS);
});

test("a manual run satisfies a pending catch-up instead of repeating it", async (t) => {
  const scheduler = schedulerWithLastRun(
    t,
    { "rolling-reconcile": new Date(Date.now() - 30 * HOUR_MS).toISOString() },
    { catchUpDelayMs: 20, catchUpSpacingMs: 20 },
  );
  const contexts: boolean[] = [];
  scheduler.registerRecurringJob({ id: "rolling-reconcile", intervalMs: 6 * HOUR_MS, task: async ({ scheduled }) => { contexts.push(scheduled); } });

  assert.equal(await scheduler.runNowAndWait("rolling-reconcile"), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(contexts, [false]);
  assert.ok(nextRunMs(scheduler, "rolling-reconcile") > Date.now() + 5 * HOUR_MS);
});

test("a manual run moves a job's next scheduled run a full interval after it", async (t) => {
  const scheduler = schedulerWithLastRun(t, { "sonarr-library-refresh": new Date(Date.now() - HOUR_MS).toISOString() });
  scheduler.registerRecurringJob({ id: "sonarr-library-refresh", intervalMs: 2 * HOUR_MS, task: async () => {} });
  const startedAt = Date.now();

  assert.equal(await scheduler.runNowAndWait("sonarr-library-refresh"), true);
  assert.ok(nextRunMs(scheduler, "sonarr-library-refresh") >= startedAt + 2 * HOUR_MS);
});

test("an event-driven run can leave the recurring schedule untouched", async (t) => {
  const scheduler = schedulerWithLastRun(t, { "session-check": new Date(Date.now() - 10 * 60_000).toISOString() });
  let runs = 0;
  scheduler.registerRecurringJob({ id: "session-check", intervalMs: 15 * 60_000, task: async () => { runs += 1; } });
  const before = scheduler.listJobs()[0].nextRunAt;

  assert.equal(scheduler.runNow("session-check", { keepSchedule: true }), true);
  await waitFor(() => runs === 1);
  assert.equal(scheduler.listJobs()[0].nextRunAt, before);
});

test("repeated interval edits keep an overdue job's catch-up slot", (t) => {
  const longAgo = new Date(Date.now() - 30 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun(t, { "history-import": longAgo }, { catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });
  const catchUpAt = nextRunMs(scheduler, "history-import");

  for (let edit = 0; edit < 5; edit += 1) {
    scheduler.updateJob("history-import", { intervalMs: HOUR_MS });
    scheduler.updateJob("history-import", { intervalMs: 24 * HOUR_MS });
  }
  assert.equal(nextRunMs(scheduler, "history-import"), catchUpAt);
});

test("interval edits that make an overdue job temporarily not due keep its catch-up slot", (t) => {
  const lastRunAt = new Date(Date.now() - 30 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun(t, { "history-import": lastRunAt }, { catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });
  const catchUpAt = nextRunMs(scheduler, "history-import");

  for (let edit = 0; edit < 5; edit += 1) {
    scheduler.updateJob("history-import", { intervalMs: 48 * HOUR_MS });
    assert.equal(nextRunMs(scheduler, "history-import"), Date.parse(lastRunAt) + 48 * HOUR_MS);
    scheduler.updateJob("history-import", { intervalMs: 24 * HOUR_MS });
  }
  assert.equal(nextRunMs(scheduler, "history-import"), catchUpAt);
});

test("disabling an overdue job releases its catch-up slot for the next overdue job", (t) => {
  const longAgo = new Date(Date.now() - 30 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun(t, { a: longAgo, b: longAgo }, { catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.registerRecurringJob({ id: "a", intervalMs: 24 * HOUR_MS, task: async () => {} });
  scheduler.registerRecurringJob({ id: "b", intervalMs: 24 * HOUR_MS, enabled: false, task: async () => {} });

  for (let toggle = 0; toggle < 5; toggle += 1) {
    scheduler.updateJob("a", { enabled: false });
    scheduler.updateJob("a", { enabled: true });
  }
  scheduler.updateJob("a", { enabled: false });
  scheduler.updateJob("b", { enabled: true });

  assert.ok(nextRunMs(scheduler, "b") <= Date.now() + 60_000, "b takes the first slot, not one behind a's released reservations");
});

test("a manual run releases the job's catch-up slot for the next overdue job", (t) => {
  const longAgo = new Date(Date.now() - 30 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun(t, { a: longAgo, b: longAgo }, { catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.registerRecurringJob({ id: "a", intervalMs: 24 * HOUR_MS, task: async () => {} });
  scheduler.registerRecurringJob({ id: "b", intervalMs: 24 * HOUR_MS, enabled: false, task: async () => {} });

  assert.equal(scheduler.runNow("a"), true);
  scheduler.updateJob("b", { enabled: true });

  assert.ok(nextRunMs(scheduler, "b") <= Date.now() + 60_000, "b takes the first slot, not the one after a's satisfied catch-up");
});

test("a released catch-up slot ahead of another reservation is reused", (t) => {
  const longAgo = new Date(Date.now() - 30 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun(t, { a: longAgo, b: longAgo, c: longAgo }, { catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.registerRecurringJob({ id: "a", intervalMs: 24 * HOUR_MS, task: async () => {} });
  scheduler.registerRecurringJob({ id: "b", intervalMs: 24 * HOUR_MS, task: async () => {} });
  scheduler.registerRecurringJob({ id: "c", intervalMs: 24 * HOUR_MS, enabled: false, task: async () => {} });
  const aAt = nextRunMs(scheduler, "a");
  const bAt = nextRunMs(scheduler, "b");

  scheduler.updateJob("a", { enabled: false });
  scheduler.updateJob("c", { enabled: true });

  assert.equal(nextRunMs(scheduler, "b"), bAt);
  assert.ok(nextRunMs(scheduler, "c") <= aAt + 1_000, "c takes a's released slot rather than queueing after b");
  assert.ok(bAt - nextRunMs(scheduler, "c") >= 45_000, "c still keeps the spacing from b");
});

test("a run skipped while setup is incomplete is not recorded, and the job catches up once setup completes", async (t) => {
  const saved: string[] = [];
  const scheduler = disableJobsAfterTest(t, new JobScheduler({ catchUpDelayMs: 10, catchUpSpacingMs: 10 }));
  scheduler.setPersistence({ load: () => null, save: (id) => { saved.push(id); } });
  let ready = false;
  scheduler.setReadiness(() => ready);
  let runs = 0;
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => { runs += 1; } });

  await waitFor(() => scheduler.listJobs()[0]!.nextRunAt === null);
  assert.equal(runs, 0);
  assert.deepEqual(saved, [], "a skipped run is not persisted as the job's last run");

  scheduler.resumeAfterSetup();
  assert.equal(scheduler.listJobs()[0]!.nextRunAt, null, "resuming before setup completes does nothing");

  ready = true;
  scheduler.resumeAfterSetup();
  await waitFor(() => runs === 1);
  assert.deepEqual(saved, ["history-import"]);
  assert.ok(nextRunMs(scheduler, "history-import") > Date.now() + 23 * HOUR_MS, "the following run is a full interval away");
});

test("a run requested before setup completes runs once setup does, even when not otherwise due", async (t) => {
  const recent = new Date(Date.now() - HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun(t, { "history-import": recent }, { catchUpDelayMs: 10, catchUpSpacingMs: 10 });
  let ready = false;
  scheduler.setReadiness(() => ready);
  let runs = 0;
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => { runs += 1; } });

  scheduler.runNowOrQueue("history-import");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs, 0);

  ready = true;
  scheduler.resumeAfterSetup();
  await waitFor(() => runs === 1);
});

test("a job whose last run failed before a restart catches up even when its last success is recent", (t) => {
  const scheduler = disableJobsAfterTest(t, new JobScheduler({ catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 }));
  scheduler.setPersistence({
    load: () => ({ lastRunAt: new Date(Date.now() - HOUR_MS).toISOString(), lastRunStatus: "error" }),
    save: () => {},
  });
  const registeredAt = Date.now();
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });

  assert.ok(nextRunMs(scheduler, "history-import") <= registeredAt + 2 * 60_000);
});

test("a failed catch-up run waits a full interval before retrying", async (t) => {
  const scheduler = schedulerWithLastRun(
    t,
    { "history-import": new Date(Date.now() - 30 * HOUR_MS).toISOString() },
    { catchUpDelayMs: 10, catchUpSpacingMs: 10 },
  );
  let runs = 0;
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => { runs += 1; throw new Error("source unavailable"); } });

  await waitFor(() => scheduler.listJobs()[0].lastRunStatus === "error");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runs, 1);
  assert.ok(nextRunMs(scheduler, "history-import") > Date.now() + 23 * HOUR_MS);
});
