import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Logger } from "../../src/server/logger.js";
import { mergeLogEntries, readRecentLogEntries } from "../../src/server/app.js";
import type { LogEntry } from "../../src/shared/types.js";

test("getRecentLogs only reflects the in-memory ring, not retained rotated files", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  const logDir = path.join(dataDir, "logs");
  fs.mkdirSync(logDir);
  // Simulates log history retained from before a restart. Merging and reading every
  // retained file (including gzip decompression) on every logs request used to block
  // the event loop for all concurrent requests; getRecentLogs must not touch these at all
  // now — that bounded, restart-surviving fallback lives in app.ts's route handler instead.
  fs.writeFileSync(path.join(logDir, "pacearr-2026-07-01.log"), `${JSON.stringify({ timestamp: "2026-07-01T12:00:00.000Z", level: "info", message: "Retained entry" })}\n`);

  try {
    const logger = new Logger(dataDir);
    logger.info("Live entry");
    const messages = logger.getRecentLogs(10).map((entry) => entry.message);
    assert.deepEqual(messages, ["Live entry"]);
    // Winston's rotating transport opens its target lazily. Give that open and
    // write a chance to settle before removing the fixture directory.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("currentLogFilePath points at the rotating transport's fixed symlink name", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  try {
    const logger = new Logger(dataDir);
    assert.equal(logger.currentLogFilePath, path.join(dataDir, "logs", "pacearr.log"));
    // Winston's rotating transport opens its target lazily. Give that open a
    // chance to settle before removing the fixture directory.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return { timestamp: "2026-08-04T10:00:00.000Z", level: "info", message: "Message", ...overrides };
}

test("mergeLogEntries drops exact duplicates but keeps same-millisecond entries that differ only in meta", () => {
  // Regression test: a dedup key of just timestamp+message previously collapsed these
  // into one, silently dropping two of three - reconcileRollingShows's synchronous
  // per-show skip-logging loop can log the identical message for several shows within
  // the same millisecond, varying only in meta.
  const exactDuplicate = entry({ meta: { rollingShowId: 1 } });
  const distinctByMeta1 = entry({ message: "Skipped reconciliation while another show operation is running", meta: { rollingShowId: 1 } });
  const distinctByMeta2 = entry({ message: "Skipped reconciliation while another show operation is running", meta: { rollingShowId: 2 } });
  const distinctByMeta3 = entry({ message: "Skipped reconciliation while another show operation is running", meta: { rollingShowId: 3 } });

  const merged = mergeLogEntries([exactDuplicate, distinctByMeta1, distinctByMeta2], [exactDuplicate, distinctByMeta3]);

  assert.equal(merged.length, 4);
  assert.equal(merged.filter((item) => item.message === "Message").length, 1);
  assert.deepEqual(
    merged.filter((item) => item.message.startsWith("Skipped")).map((item) => item.meta),
    [{ rollingShowId: 1 }, { rollingShowId: 2 }, { rollingShowId: 3 }]
  );
});

test("mergeLogEntries sorts the combined result chronologically", () => {
  const later = entry({ timestamp: "2026-08-04T10:00:02.000Z", message: "Later" });
  const earliest = entry({ timestamp: "2026-08-04T10:00:00.000Z", message: "Earliest" });
  const middle = entry({ timestamp: "2026-08-04T10:00:01.000Z", message: "Middle" });

  const merged = mergeLogEntries([later, earliest], [middle]);

  assert.deepEqual(merged.map((item) => item.message), ["Earliest", "Middle", "Later"]);
});

test("readRecentLogEntries combines today's log file with the in-memory ring", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  try {
    const logger = new Logger(dataDir);
    // Simulates history from before this process started (e.g. a restart) - only in the
    // file, never reaches the ring.
    fs.writeFileSync(logger.currentLogFilePath, `${JSON.stringify(entry({ message: "File-only entry" }))}\n`);
    logger.info("Ring-only entry");

    const messages = readRecentLogEntries(logger).map((item) => item.message);
    assert.deepEqual(messages.sort(), ["File-only entry", "Ring-only entry"]);
    // Winston's rotating transport opens its target lazily. Give that open and
    // write a chance to settle before removing the fixture directory.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
