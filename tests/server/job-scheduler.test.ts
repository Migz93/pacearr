import assert from "node:assert/strict";
import test from "node:test";
import { JobScheduler } from "../../src/server/job-scheduler.js";

const HOUR_MS = 60 * 60 * 1000;

function schedulerWithLastRun(lastRunAt: Record<string, string | null>, options?: ConstructorParameters<typeof JobScheduler>[0]) {
  const scheduler = new JobScheduler(options);
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

test("a job registered partway through its interval runs one interval after its last run", () => {
  const lastRunAt = new Date(Date.now() - 23 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun({ "history-import": lastRunAt });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });

  assert.equal(nextRunMs(scheduler, "history-import"), Date.parse(lastRunAt) + 24 * HOUR_MS);
  scheduler.updateJob("history-import", { enabled: false });
});

test("an overdue job runs shortly after registration", async () => {
  const scheduler = schedulerWithLastRun(
    { "history-import": new Date(Date.now() - 30 * HOUR_MS).toISOString() },
    { catchUpDelayMs: 10, catchUpSpacingMs: 10 },
  );
  const contexts: boolean[] = [];
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async ({ scheduled }) => { contexts.push(scheduled); } });

  await waitFor(() => contexts.length === 1);
  assert.deepEqual(contexts, [true]);
  assert.ok(nextRunMs(scheduler, "history-import") > Date.now() + 23 * HOUR_MS, "the following run is a full interval away");
  scheduler.updateJob("history-import", { enabled: false });
});

test("overdue jobs are staggered rather than started together", () => {
  const longAgo = new Date(Date.now() - 30 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun({ a: longAgo, b: longAgo }, { catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.registerRecurringJob({ id: "a", intervalMs: 24 * HOUR_MS, task: async () => {} });
  scheduler.registerRecurringJob({ id: "b", intervalMs: 24 * HOUR_MS, task: async () => {} });

  assert.equal(nextRunMs(scheduler, "b") - nextRunMs(scheduler, "a"), 45_000);
  scheduler.updateJob("a", { enabled: false });
  scheduler.updateJob("b", { enabled: false });
});

test("updating a job without changing its interval or enabled state keeps its next run", async () => {
  const scheduler = schedulerWithLastRun({ "history-import": new Date(Date.now() - HOUR_MS).toISOString() });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });
  const before = scheduler.listJobs()[0].nextRunAt;

  await new Promise((resolve) => setTimeout(resolve, 5));
  scheduler.updateJob("history-import", { intervalMs: 24 * HOUR_MS });
  scheduler.updateJob("history-import", { enabled: true });

  assert.equal(scheduler.listJobs()[0].nextRunAt, before);
  scheduler.updateJob("history-import", { enabled: false });
});

test("changing a job's interval measures the new interval from its last run", () => {
  const lastRunAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun({ "history-import": lastRunAt });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });

  scheduler.updateJob("history-import", { intervalMs: 12 * HOUR_MS });
  assert.equal(nextRunMs(scheduler, "history-import"), Date.parse(lastRunAt) + 12 * HOUR_MS);
  scheduler.updateJob("history-import", { intervalMs: 24 * HOUR_MS });
  assert.equal(nextRunMs(scheduler, "history-import"), Date.parse(lastRunAt) + 24 * HOUR_MS);
  scheduler.updateJob("history-import", { enabled: false });
});

test("a manual run satisfies a pending catch-up instead of repeating it", async () => {
  const scheduler = schedulerWithLastRun(
    { "rolling-reconcile": new Date(Date.now() - 30 * HOUR_MS).toISOString() },
    { catchUpDelayMs: 20, catchUpSpacingMs: 20 },
  );
  const contexts: boolean[] = [];
  scheduler.registerRecurringJob({ id: "rolling-reconcile", intervalMs: 6 * HOUR_MS, task: async ({ scheduled }) => { contexts.push(scheduled); } });

  assert.equal(await scheduler.runNowAndWait("rolling-reconcile"), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(contexts, [false]);
  assert.ok(nextRunMs(scheduler, "rolling-reconcile") > Date.now() + 5 * HOUR_MS);
  scheduler.updateJob("rolling-reconcile", { enabled: false });
});

test("a manual run moves a job's next scheduled run a full interval after it", async () => {
  const scheduler = schedulerWithLastRun({ "sonarr-library-refresh": new Date(Date.now() - HOUR_MS).toISOString() });
  scheduler.registerRecurringJob({ id: "sonarr-library-refresh", intervalMs: 2 * HOUR_MS, task: async () => {} });
  const startedAt = Date.now();

  assert.equal(await scheduler.runNowAndWait("sonarr-library-refresh"), true);
  assert.ok(nextRunMs(scheduler, "sonarr-library-refresh") >= startedAt + 2 * HOUR_MS);
  scheduler.updateJob("sonarr-library-refresh", { enabled: false });
});

test("an event-driven run can leave the recurring schedule untouched", async () => {
  const scheduler = schedulerWithLastRun({ "session-check": new Date(Date.now() - 10 * 60_000).toISOString() });
  let runs = 0;
  scheduler.registerRecurringJob({ id: "session-check", intervalMs: 15 * 60_000, task: async () => { runs += 1; } });
  const before = scheduler.listJobs()[0].nextRunAt;

  assert.equal(scheduler.runNow("session-check", { keepSchedule: true }), true);
  await waitFor(() => runs === 1);
  assert.equal(scheduler.listJobs()[0].nextRunAt, before);
  scheduler.updateJob("session-check", { enabled: false });
});

test("repeated interval edits keep an overdue job's catch-up slot", () => {
  const longAgo = new Date(Date.now() - 30 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun({ "history-import": longAgo }, { catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });
  const catchUpAt = nextRunMs(scheduler, "history-import");

  for (let edit = 0; edit < 5; edit += 1) {
    scheduler.updateJob("history-import", { intervalMs: HOUR_MS });
    scheduler.updateJob("history-import", { intervalMs: 24 * HOUR_MS });
  }
  assert.equal(nextRunMs(scheduler, "history-import"), catchUpAt);
  scheduler.updateJob("history-import", { enabled: false });
});

test("interval edits that make an overdue job temporarily not due keep its catch-up slot", () => {
  const lastRunAt = new Date(Date.now() - 30 * HOUR_MS).toISOString();
  const scheduler = schedulerWithLastRun({ "history-import": lastRunAt }, { catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });
  const catchUpAt = nextRunMs(scheduler, "history-import");

  for (let edit = 0; edit < 5; edit += 1) {
    scheduler.updateJob("history-import", { intervalMs: 48 * HOUR_MS });
    assert.equal(nextRunMs(scheduler, "history-import"), Date.parse(lastRunAt) + 48 * HOUR_MS);
    scheduler.updateJob("history-import", { intervalMs: 24 * HOUR_MS });
  }
  assert.equal(nextRunMs(scheduler, "history-import"), catchUpAt);
  scheduler.updateJob("history-import", { enabled: false });
});

test("a job whose last run failed before a restart catches up even when its last success is recent", () => {
  const scheduler = new JobScheduler({ catchUpDelayMs: 60_000, catchUpSpacingMs: 45_000 });
  scheduler.setPersistence({
    load: () => ({ lastRunAt: new Date(Date.now() - HOUR_MS).toISOString(), lastRunStatus: "error" }),
    save: () => {},
  });
  const registeredAt = Date.now();
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => {} });

  assert.ok(nextRunMs(scheduler, "history-import") <= registeredAt + 2 * 60_000);
  scheduler.updateJob("history-import", { enabled: false });
});

test("a failed catch-up run waits a full interval before retrying", async () => {
  const scheduler = schedulerWithLastRun(
    { "history-import": new Date(Date.now() - 30 * HOUR_MS).toISOString() },
    { catchUpDelayMs: 10, catchUpSpacingMs: 10 },
  );
  let runs = 0;
  scheduler.registerRecurringJob({ id: "history-import", intervalMs: 24 * HOUR_MS, task: async () => { runs += 1; throw new Error("source unavailable"); } });

  await waitFor(() => scheduler.listJobs()[0].lastRunStatus === "error");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runs, 1);
  assert.ok(nextRunMs(scheduler, "history-import") > Date.now() + 23 * HOUR_MS);
  scheduler.updateJob("history-import", { enabled: false });
});
