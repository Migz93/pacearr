import type { Logger } from "./logger.js";

export const PROGRESS_LOG_INTERVAL_MS = 30_000;

export interface ProgressLog {
  /** Counts one finished item, logging progress if the interval has passed since the last line. */
  tick(): void;
}

/**
 * Reports how far a long loop has got. Progress is only checked when an item finishes,
 * never on a timer, so nothing is logged once the loop stops, and a loop that finishes
 * within one interval logs nothing at all.
 */
export function createProgressLog(
  logger: Pick<Logger, "info">,
  message: string,
  total: number,
  fields: Record<string, unknown> = {},
  options: { intervalMs?: number; now?: () => number } = {}
): ProgressLog {
  const intervalMs = options.intervalMs ?? PROGRESS_LOG_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let processed = 0;
  let lastLoggedAt = now();
  return {
    tick() {
      processed++;
      const current = now();
      if (current - lastLoggedAt < intervalMs) return;
      lastLoggedAt = current;
      logger.info(message, { ...fields, processed, total });
    },
  };
}
