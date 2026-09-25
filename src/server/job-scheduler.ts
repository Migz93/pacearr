import type { JobInfo } from "../shared/types.js";
import type { Logger } from "./logger.js";

// Node clamps longer delays to 1ms, which would make a monthly job run in a loop.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// Overdue jobs wait briefly and start one at a time, rather than all at once at boot.
const DEFAULT_CATCH_UP_DELAY_MS = 30_000;
const DEFAULT_CATCH_UP_SPACING_MS = 30_000;

type ScheduledJob = {
  id: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  activeRuns: number;
  pendingManualRun: boolean;
  // Set when a run was skipped because setup is incomplete. Such a run is not
  // recorded, and the job is rescheduled by resumeAfterSetup().
  waitingForSetup: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
  // The next run is due one interval after this (the last run start or scheduled
  // tick), so restarts and settings saves cannot keep postponing a long interval.
  anchorMs: number | null;
  catchUpAtMs: number | null;
  intervalMs: number;
  task: (context: JobRunContext) => Promise<void>;
};

export type JobRunContext = { scheduled: boolean };

export class JobScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly catchUpDelayMs: number;
  private readonly catchUpSpacingMs: number;
  private logger?: Logger;
  private isReady: () => boolean = () => true;
  private loadPersistedState?: (id: string) => { lastRunAt: string | null; lastRunStatus: "success" | "error" | null } | null | undefined;
  private savePersistedState?: (id: string, state: { lastRunAt: string | null; lastRunStatus: "success" | "error" | null }) => void;

  constructor(options: { catchUpDelayMs?: number; catchUpSpacingMs?: number } = {}) {
    this.catchUpDelayMs = options.catchUpDelayMs ?? DEFAULT_CATCH_UP_DELAY_MS;
    this.catchUpSpacingMs = options.catchUpSpacingMs ?? DEFAULT_CATCH_UP_SPACING_MS;
  }

  setLogger(logger: Logger): void {
    this.logger = logger;
    this.logger.debug("Job scheduler logger attached");
  }

  setPersistence(options: {
    load: (id: string) => { lastRunAt: string | null; lastRunStatus: "success" | "error" | null } | null | undefined;
    save: (id: string, state: { lastRunAt: string | null; lastRunStatus: "success" | "error" | null }) => void;
  }) {
    this.loadPersistedState = options.load;
    this.savePersistedState = options.save;
  }

  /** Jobs only run once this reports setup as complete. */
  setReadiness(isReady: () => boolean) {
    this.isReady = isReady;
  }

  /**
   * Reschedules every job skipped while setup was incomplete. Each catches up as
   * an overdue job does, from its last recorded run.
   */
  resumeAfterSetup() {
    if (!this.isReady()) return;
    for (const job of this.jobs.values()) {
      if (!job.waitingForSetup) continue;
      job.waitingForSetup = false;
      this.reschedule(job);
      this.logger?.info("Scheduled job resumed after setup", { id: job.id, nextRunAt: job.nextRunAt });
    }
  }

  registerRecurringJob(options: { id: string; intervalMs: number; enabled?: boolean; task: (context: JobRunContext) => Promise<void> }) {
    const persisted = this.loadPersistedState?.(options.id);
    // lastRunAt only advances on success, so it cannot say when a failed run
    // happened. A job whose last run failed is treated as overdue and retried
    // shortly after boot instead.
    const lastRunMs = persisted?.lastRunAt && persisted.lastRunStatus !== "error" ? Date.parse(persisted.lastRunAt) : NaN;
    const job: ScheduledJob = {
      id: options.id,
      enabled: options.enabled ?? true,
      nextRunAt: null,
      lastRunAt: persisted?.lastRunAt ?? null,
      lastRunStatus: persisted?.lastRunStatus ?? null,
      activeRuns: 0,
      pendingManualRun: false,
      waitingForSetup: false,
      timeout: null,
      anchorMs: Number.isFinite(lastRunMs) ? lastRunMs : null,
      catchUpAtMs: null,
      intervalMs: options.intervalMs,
      task: options.task,
    };
    this.jobs.set(job.id, job);
    this.reschedule(job);
    this.logger?.info("Scheduled job registered", { id: job.id, enabled: job.enabled, intervalMs: job.intervalMs, lastRunAt: job.lastRunAt, nextRunAt: job.nextRunAt });
  }

  updateJob(id: string, patch: { intervalMs?: number; enabled?: boolean }) {
    const job = this.jobs.get(id);
    if (!job) return;
    // Settings saves update every job, so leave an unchanged job's timer alone.
    const intervalChanged = patch.intervalMs !== undefined && patch.intervalMs !== job.intervalMs;
    const enabledChanged = patch.enabled !== undefined && patch.enabled !== job.enabled;
    if (!intervalChanged && !enabledChanged) return;
    if (patch.intervalMs !== undefined) job.intervalMs = patch.intervalMs;
    if (patch.enabled !== undefined) {
      job.enabled = patch.enabled;
      if (!job.enabled) job.pendingManualRun = false;
    }
    this.reschedule(job);
    this.logger?.info("Scheduled job updated", { id: job.id, intervalMs: job.intervalMs, enabled: job.enabled, nextRunAt: job.nextRunAt });
  }

  /**
   * keepSchedule leaves the recurring timer untouched. Event-driven triggers use it
   * so they cannot postpone a polling fallback that must still fire on its cadence.
   */
  runNow(id: string, options: { keepSchedule?: boolean } = {}) {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return false;
    if (job.activeRuns > 0) {
      this.logger?.debug("Skipped overlapping manual job run", { id, activeRuns: job.activeRuns });
      return false;
    }
    this.logger?.info("Scheduled job triggered manually", { id });
    void this.execute(job, false, options.keepSchedule);
    return true;
  }

  /**
   * Starts a manual run now, or retains exactly one manual follow-up when a run is
   * already active. Dependencies use this when their result must be processed after a
   * current calculation finishes, rather than silently dropping that newer result.
   */
  runNowOrQueue(id: string) {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return false;
    if (job.activeRuns === 0) return this.runNow(id);
    if (job.pendingManualRun) return false;
    job.pendingManualRun = true;
    this.logger?.info("Queued manual job run after active run", { id, activeRuns: job.activeRuns });
    return true;
  }

  async runNowAndWait(id: string) {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return null;
    return this.execute(job, false);
  }

  listJobs(): JobInfo[] {
    return Array.from(this.jobs.values()).map((job) => ({
      id: job.id,
      enabled: job.enabled,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
      lastRunStatus: job.lastRunStatus,
      running: job.activeRuns > 0,
    }));
  }

  private reschedule(job: ScheduledJob) {
    if (job.timeout) clearTimeout(job.timeout);
    job.timeout = null;
    if (!job.enabled) {
      job.catchUpAtMs = null;
      job.nextRunAt = null;
      return;
    }
    const now = Date.now();
    // Capping at one interval from now keeps a lastRunAt from a clock that has since
    // moved backwards from delaying the job by more than a single interval.
    let targetMs = job.anchorMs === null ? now : Math.min(job.anchorMs + job.intervalMs, now + job.intervalMs);
    if (targetMs <= now) {
      // A catch-up slot stays reserved until the job runs or is disabled, even
      // while an interval edit makes it temporarily not due, so repeated edits
      // cannot keep reserving later slots and push this job's catch-up further out.
      if (job.catchUpAtMs !== null && job.catchUpAtMs > now) {
        targetMs = job.catchUpAtMs;
      } else {
        targetMs = this.nextCatchUpSlot(now);
      }
      job.catchUpAtMs = targetMs;
    }
    job.nextRunAt = new Date(targetMs).toISOString();
    this.waitUntil(job, targetMs);
  }

  // The earliest time a spacing away from every catch-up still reserved. Derived from
  // the reservations rather than a running counter, so a slot released by a manual
  // run or a disabled job is reused instead of delaying later jobs.
  private nextCatchUpSlot(now: number): number {
    const reserved = Array.from(this.jobs.values(), (job) => job.catchUpAtMs)
      .filter((atMs): atMs is number => atMs !== null && atMs > now)
      .sort((a, b) => a - b);
    let slotMs = now + this.catchUpDelayMs;
    for (const atMs of reserved) {
      if (slotMs + this.catchUpSpacingMs <= atMs) break;
      if (slotMs < atMs + this.catchUpSpacingMs) slotMs = atMs + this.catchUpSpacingMs;
    }
    return slotMs;
  }

  private waitUntil(job: ScheduledJob, targetMs: number) {
    const remainingMs = Math.max(0, targetMs - Date.now());
    job.timeout = setTimeout(() => {
      if (!job.enabled) return;
      // Keep the original target so long schedules retain their intended cadence.
      if (targetMs > Date.now()) {
        this.waitUntil(job, targetMs);
        return;
      }
      void this.execute(job, true);
    }, Math.min(remainingMs, MAX_TIMEOUT_MS));
  }

  private async execute(job: ScheduledJob, scheduled: boolean, keepSchedule = false) {
    if (!this.isReady()) {
      // Nothing ran, so nothing is recorded: counting this as the job's last run
      // would postpone its first real run by a full interval once setup completes.
      // A fired timer is not re-armed; resumeAfterSetup() reschedules the job.
      if (scheduled) {
        job.timeout = null;
        job.catchUpAtMs = null;
        job.nextRunAt = null;
      }
      // A requested run is still owed, so the job is due as soon as setup completes.
      if (!scheduled && !keepSchedule) job.anchorMs = null;
      job.waitingForSetup = true;
      this.logger?.debug("Skipped job run; setup is incomplete", { id: job.id, scheduled });
      return false;
    }
    job.waitingForSetup = false;
    // Schedule the next tick before deciding whether this one overlaps. Otherwise a
    // single collision would leave a recurring job with no timer at all.
    if (scheduled) {
      job.anchorMs = Date.now();
      job.catchUpAtMs = null;
      this.reschedule(job);
    }
    if (job.activeRuns > 0) {
      this.logger?.debug("Skipped overlapping scheduled job run", { id: job.id, scheduled, activeRuns: job.activeRuns });
      return false;
    }
    job.activeRuns += 1;
    if (!scheduled && !keepSchedule) {
      // A manual, queued, or startup run counts as the job's latest run, so the next
      // scheduled run (including a pending catch-up) is a full interval after it.
      job.anchorMs = Date.now();
      job.catchUpAtMs = null;
      this.reschedule(job);
    }
    this.logger?.info("Scheduled job started", { id: job.id, scheduled, activeRuns: job.activeRuns });
    try {
      await job.task({ scheduled });
      job.lastRunAt = new Date().toISOString();
      job.lastRunStatus = "success";
      this.savePersistedState?.(job.id, { lastRunAt: job.lastRunAt, lastRunStatus: job.lastRunStatus });
      this.logger?.info("Scheduled job complete", { id: job.id, scheduled });
      return true;
    } catch (error) {
      // Jobs retry at their administrator-configured interval. A separate exponential
      // backoff would obscure that schedule and can be adjusted explicitly in Settings.
      job.lastRunStatus = "error";
      this.savePersistedState?.(job.id, { lastRunAt: job.lastRunAt, lastRunStatus: job.lastRunStatus });
      this.logger?.error("Job failed", { id: job.id, error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      job.activeRuns = Math.max(0, job.activeRuns - 1);
      if (job.activeRuns === 0 && job.enabled && job.pendingManualRun) {
        job.pendingManualRun = false;
        this.logger?.info("Running queued manual job", { id: job.id });
        void this.execute(job, false);
      }
    }
  }
}
