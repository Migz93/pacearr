import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SCHEDULE_INTERVAL_DAYS, MAX_SCHEDULE_INTERVAL_HOURS, MAX_SCHEDULE_INTERVAL_MINUTES, normaliseScheduleIntervalDays, normaliseScheduleIntervalHours, normaliseScheduleIntervalMinutes, parseScheduleIntervalMinutes, scheduleIntervalValueInUnit } from "../../src/server/schedule-interval.js";

test("schedule intervals clamp oversized finite values before persistence or scheduling", () => {
  assert.equal(normaliseScheduleIntervalMinutes(1e308, 15), MAX_SCHEDULE_INTERVAL_MINUTES);
  assert.equal(normaliseScheduleIntervalHours(1e15, 24), MAX_SCHEDULE_INTERVAL_HOURS);
  assert.equal(normaliseScheduleIntervalDays(1e15, 30), MAX_SCHEDULE_INTERVAL_DAYS);
  assert.equal(parseScheduleIntervalMinutes(Number.MAX_SAFE_INTEGER), MAX_SCHEDULE_INTERVAL_MINUTES);
});

test("schedule interval parsing keeps invalid settings safe and rejects invalid direct edits", () => {
  assert.equal(normaliseScheduleIntervalMinutes("Infinity", 15), 15);
  assert.equal(normaliseScheduleIntervalHours("Infinity", 24), 24);
  assert.equal(normaliseScheduleIntervalDays("Infinity", 30), 30);
  assert.equal(parseScheduleIntervalMinutes("Infinity"), null);
  for (const value of [Number.NaN, 0, -1]) {
    assert.equal(normaliseScheduleIntervalMinutes(value, 15), Number.isNaN(value) ? 15 : 1);
    assert.equal(normaliseScheduleIntervalHours(value, 24), Number.isNaN(value) ? 24 : 1);
    assert.equal(normaliseScheduleIntervalDays(value, 30), Number.isNaN(value) ? 30 : 1);
    assert.equal(parseScheduleIntervalMinutes(value), null);
  }
});

test("job schedule intervals must align with the job's configured unit", () => {
  assert.equal(scheduleIntervalValueInUnit(15, 1), 15);
  assert.equal(scheduleIntervalValueInUnit(60, 60), 1);
  assert.equal(scheduleIntervalValueInUnit(24 * 60, 24 * 60), 1);
  assert.equal(scheduleIntervalValueInUnit(90, 60), null);
  assert.equal(scheduleIntervalValueInUnit(24 * 60 - 1, 24 * 60), null);
});
