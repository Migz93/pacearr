import type { JobInfo } from "../shared/types.js";
import type { Logger } from "./logger.js";

// Node clamps longer delays to 1ms, which would make a monthly job run in a loop.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

type ScheduledJob = {
  id: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  activeRuns: number;
  pendingManualRun: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
  intervalMs: number;
  task: (context: JobRunContext) => Promise<void>;
};

export type JobRunContext = { scheduled: boolean };

export class JobScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private logger?: Logger;
  private loadPersistedState?: (id: string) => { lastRunAt: string | null; lastRunStatus: "success" | "error" | null } | null | undefined;
  private savePersistedState?: (id: string, state: { lastRunAt: string | null; lastRunStatus: "success" | "error" | null }) => void;

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

  registerRecurringJob(options: { id: string; intervalMs: number; enabled?: boolean; task: (context: JobRunContext) => Promise<void> }) {
    const persisted = this.loadPersistedState?.(options.id);
    const job: ScheduledJob = {
      id: options.id,
      enabled: options.enabled ?? true,
      nextRunAt: null,
      lastRunAt: persisted?.lastRunAt ?? null,
      lastRunStatus: persisted?.lastRunStatus ?? null,
      activeRuns: 0,
      pendingManualRun: false,
      timeout: null,
      intervalMs: options.intervalMs,
      task: options.task,
    };
    this.jobs.set(job.id, job);
    this.reschedule(job);
    this.logger?.info("Scheduled job registered", { id: job.id, enabled: job.enabled, intervalMs: job.intervalMs, lastRunAt: job.lastRunAt });
  }

  updateJob(id: string, patch: { intervalMs?: number; enabled?: boolean }) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (patch.intervalMs !== undefined) job.intervalMs = patch.intervalMs;
    if (patch.enabled !== undefined) {
      job.enabled = patch.enabled;
      if (!job.enabled) job.pendingManualRun = false;
    }
    this.reschedule(job);
    this.logger?.info("Scheduled job updated", { id: job.id, intervalMs: job.intervalMs, enabled: job.enabled });
  }

  runNow(id: string) {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return false;
    if (job.activeRuns > 0) {
      this.logger?.debug("Skipped overlapping manual job run", { id, activeRuns: job.activeRuns });
      return false;
    }
    this.logger?.info("Scheduled job triggered manually", { id });
    void this.execute(job, false);
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
      job.nextRunAt = null;
      return;
    }
    const next = new Date(Date.now() + job.intervalMs);
    job.nextRunAt = next.toISOString();
    this.waitUntil(job, next.getTime());
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

  private async execute(job: ScheduledJob, scheduled: boolean) {
    // Schedule the next tick before deciding whether this one overlaps. Otherwise a
    // single collision would leave a recurring job with no timer at all.
    if (scheduled) this.reschedule(job);
    if (job.activeRuns > 0) {
      this.logger?.debug("Skipped overlapping scheduled job run", { id: job.id, scheduled, activeRuns: job.activeRuns });
      return false;
    }
    job.activeRuns += 1;
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
