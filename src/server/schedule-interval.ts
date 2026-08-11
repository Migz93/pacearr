// A one-year ceiling keeps persisted schedules within JavaScript's Date range while
// still allowing the longest recurring task Pacearr exposes (monthly reconciliation).
export const MAX_SCHEDULE_INTERVAL_MINUTES = 365 * 24 * 60;
export const MAX_SCHEDULE_INTERVAL_HOURS = MAX_SCHEDULE_INTERVAL_MINUTES / 60;
export const MAX_SCHEDULE_INTERVAL_DAYS = MAX_SCHEDULE_INTERVAL_HOURS / 24;

export function normaliseScheduleIntervalMinutes(value: unknown, fallbackMinutes: number): number {
  const parsed = Number(value);
  const minutes = Number.isFinite(parsed) ? parsed : fallbackMinutes;
  return Math.min(MAX_SCHEDULE_INTERVAL_MINUTES, Math.max(1, Math.floor(minutes)));
}

export function normaliseScheduleIntervalHours(value: unknown, fallbackHours: number): number {
  const parsed = Number(value);
  const hours = Number.isFinite(parsed) ? parsed : fallbackHours;
  return Math.min(MAX_SCHEDULE_INTERVAL_HOURS, Math.max(1, Math.floor(hours)));
}

export function normaliseScheduleIntervalDays(value: unknown, fallbackDays: number): number {
  const parsed = Number(value);
  const days = Number.isFinite(parsed) ? parsed : fallbackDays;
  return Math.min(MAX_SCHEDULE_INTERVAL_DAYS, Math.max(1, Math.floor(days)));
}

export function parseScheduleIntervalMinutes(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(MAX_SCHEDULE_INTERVAL_MINUTES, Math.max(1, Math.floor(parsed)));
}

export function scheduleIntervalValueInUnit(intervalMinutes: number, unitMinutes: number): number | null {
  return intervalMinutes % unitMinutes === 0 ? intervalMinutes / unitMinutes : null;
}
