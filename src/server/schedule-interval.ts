// A one-year ceiling keeps persisted schedules within JavaScript's Date range while
// still allowing the longest recurring task Pacearr exposes (monthly reconciliation).
export const MAX_SCHEDULE_INTERVAL_MINUTES = 365 * 24 * 60;
export const MAX_SCHEDULE_INTERVAL_HOURS = MAX_SCHEDULE_INTERVAL_MINUTES / 60;
export const MAX_SCHEDULE_INTERVAL_DAYS = MAX_SCHEDULE_INTERVAL_HOURS / 24;

function normaliseScheduleInterval(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Math.min(maximum, Math.max(1, Math.floor(Number.isFinite(parsed) ? parsed : fallback)));
}

export function normaliseScheduleIntervalMinutes(value: unknown, fallbackMinutes: number): number {
  return normaliseScheduleInterval(value, fallbackMinutes, MAX_SCHEDULE_INTERVAL_MINUTES);
}

export function normaliseScheduleIntervalHours(value: unknown, fallbackHours: number): number {
  return normaliseScheduleInterval(value, fallbackHours, MAX_SCHEDULE_INTERVAL_HOURS);
}

export function normaliseScheduleIntervalDays(value: unknown, fallbackDays: number): number {
  return normaliseScheduleInterval(value, fallbackDays, MAX_SCHEDULE_INTERVAL_DAYS);
}

export function parseScheduleIntervalMinutes(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(MAX_SCHEDULE_INTERVAL_MINUTES, Math.max(1, Math.floor(parsed)));
}

export function scheduleIntervalValueInUnit(intervalMinutes: number, unitMinutes: number): number | null {
  return intervalMinutes % unitMinutes === 0 ? intervalMinutes / unitMinutes : null;
}
