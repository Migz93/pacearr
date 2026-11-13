import assert from "node:assert/strict";
import test from "node:test";
import { createProgressLog } from "../../src/server/progress-log.js";

function setup(total: number) {
  let clock = 0;
  const lines: Array<{ message: string; meta: unknown }> = [];
  const logger = { info: (message: string, meta?: unknown) => { lines.push({ message, meta }); } };
  const progress = createProgressLog(logger, "Import progress", total, { source: "tautulli" }, { intervalMs: 30_000, now: () => clock });
  return { progress, lines, advance: (ms: number) => { clock += ms; } };
}

test("progress logging stays quiet for a loop that finishes within the interval", () => {
  const { progress, lines, advance } = setup(100);
  for (let i = 0; i < 100; i++) {
    advance(290);
    progress.tick();
  }
  assert.deepEqual(lines, []);
});

test("progress logging reports once per interval with the running count and total", () => {
  const { progress, lines, advance } = setup(100);
  // 1s per item: lines at items 30, 60 and 90, never more than one per interval.
  for (let i = 0; i < 100; i++) {
    advance(1_000);
    progress.tick();
  }
  assert.deepEqual(lines, [
    { message: "Import progress", meta: { source: "tautulli", processed: 30, total: 100 } },
    { message: "Import progress", meta: { source: "tautulli", processed: 60, total: 100 } },
    { message: "Import progress", meta: { source: "tautulli", processed: 90, total: 100 } },
  ]);
});

test("progress logging measures the next interval from the last line, not the item that crossed it", () => {
  const { progress, lines, advance } = setup(10);
  advance(45_000);
  progress.tick();
  advance(20_000);
  progress.tick();
  advance(10_000);
  progress.tick();
  assert.deepEqual(lines.map((line) => (line.meta as { processed: number }).processed), [1, 3]);
});

test("progress logging counts several items per tick and leaves out an unknown total", () => {
  let clock = 0;
  const lines: unknown[] = [];
  const progress = createProgressLog({ info: (_message: string, meta?: unknown) => { lines.push(meta); } }, "Fetch progress", null, {}, { intervalMs: 30_000, now: () => clock });
  for (let page = 0; page < 3; page++) {
    clock += 20_000;
    progress.tick(1_000);
  }
  assert.deepEqual(lines, [{ processed: 2_000 }]);
});
