import type { Logger } from "./logger.js";

export const PROGRESS_LOG_INTERVAL_MS = 30_000;

export interface ProgressLog {
  /** Counts finished items (one by default), logging progress if the interval has passed since the last line. */
  tick(count?: number): void;
}

/**
 * Reports how far a long loop has got. Progress is only checked when an item finishes,
 * never on a timer, so nothing is logged once the loop stops, and a loop that finishes
 * within one interval logs nothing at all.
 */
export function createProgressLog(
  logger: Pick<Logger, "info">,
  message: string,
  total: number | null,
  fields: Record<string, unknown> = {},
  options: { intervalMs?: number; now?: () => number } = {}
): ProgressLog {
  const intervalMs = options.intervalMs ?? PROGRESS_LOG_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let processed = 0;
  let lastLoggedAt = now();
  return {
    tick(count = 1) {
      processed += count;
      const current = now();
      if (current - lastLoggedAt < intervalMs) return;
      lastLoggedAt = current;
      // A null total is a loop that cannot know its length up front, such as a paged read.
      logger.info(message, total === null ? { ...fields, processed } : { ...fields, processed, total });
    },
  };
}
