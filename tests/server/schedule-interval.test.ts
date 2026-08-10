import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SCHEDULE_INTERVAL_MINUTES, normaliseScheduleIntervalMinutes, parseScheduleIntervalMinutes } from "../../src/server/schedule-interval.js";

test("schedule intervals clamp oversized finite values before persistence or scheduling", () => {
  assert.equal(normaliseScheduleIntervalMinutes(1e308, 15), MAX_SCHEDULE_INTERVAL_MINUTES);
  assert.equal(parseScheduleIntervalMinutes(Number.MAX_SAFE_INTEGER), MAX_SCHEDULE_INTERVAL_MINUTES);
});

test("schedule interval parsing keeps invalid settings safe and rejects invalid direct edits", () => {
  assert.equal(normaliseScheduleIntervalMinutes("Infinity", 15), 15);
  assert.equal(parseScheduleIntervalMinutes("Infinity"), null);
});
