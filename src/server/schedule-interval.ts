// A one-year ceiling keeps persisted schedules within JavaScript's Date range while
// still allowing the longest recurring task Pacearr exposes (monthly reconciliation).
export const MAX_SCHEDULE_INTERVAL_MINUTES = 365 * 24 * 60;

export function normaliseScheduleIntervalMinutes(value: unknown, fallbackMinutes: number): number {
  const parsed = Number(value);
  const minutes = Number.isFinite(parsed) ? parsed : fallbackMinutes;
  return Math.min(MAX_SCHEDULE_INTERVAL_MINUTES, Math.max(1, Math.floor(minutes)));
}

export function parseScheduleIntervalMinutes(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(MAX_SCHEDULE_INTERVAL_MINUTES, Math.max(1, Math.floor(parsed)));
}
