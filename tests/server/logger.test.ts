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
    await logger.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("currentLogFilePath points at the machine-readable transport's fixed symlink name", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  try {
    const logger = new Logger(dataDir);
    assert.equal(logger.currentLogFilePath, path.join(dataDir, "logs", ".machinelogs.json"));
    await logger.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return { timestamp: "2026-08-04T10:00:00.000Z", level: "info", message: "Message", ...overrides };
}

/**
 * winston's write to a DailyRotateFile transport is asynchronous, and its top-level
 * "finish" event (what Logger.close() waits on) doesn't reliably fire only after that
 * write has actually reached disk - confirmed empirically (10/10 failures) reading the
 * file immediately after close() resolves. Polling for content is slower to write but
 * doesn't depend on winston/stream internals that don't guarantee this ordering.
 */
async function waitForFileContent(filePath: string, timeoutMs = 2000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      if (content.trim()) return content;
    } catch {
      // File may not exist yet.
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${filePath} to have content`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    await logger.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("logged metadata survives the full write/read round trip through the persisted file", async () => {
  // Regression test: winston's second log argument is spread onto the top-level info
  // object, not nested. Passing meta directly (rather than wrapping it as { meta })
  // serialized it as top-level JSON fields that readTodaysLogEntries' `parsed.meta`
  // check could never see - every entry recovered from the persisted file (as opposed
  // to the in-memory ring) silently lost its metadata entirely.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  try {
    const logger = new Logger(dataDir);
    logger.info("Scheduled job started", { id: "session-check", scheduled: true });
    await waitForFileContent(logger.currentLogFilePath);

    const raw = fs.readFileSync(logger.currentLogFilePath, "utf8");
    const parsed = JSON.parse(raw.trim().split("\n").pop()!);
    assert.deepEqual(parsed.meta, { id: "session-check", scheduled: true });
    assert.equal(parsed.id, undefined, "metadata must not also leak onto top-level fields");

    await logger.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the ring entry's timestamp matches the persisted file's timestamp for the same log call", async () => {
  // Regression test: winston.format.timestamp() generates a fresh timestamp
  // independently of the one write() already stored in the ring entry - two separate
  // `new Date()` calls a few microseconds apart, which land in different milliseconds
  // often enough in practice (confirmed ~16% of calls) that mergeLogEntries' dedup key
  // failed to recognize the ring and file copies of the same entry as identical, so it
  // could appear twice in the Logs viewer for as long as it remained in both sources.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  try {
    const logger = new Logger(dataDir);
    logger.info("Timestamp consistency check");
    const [ringEntry] = logger.getRecentLogs(1);

    await waitForFileContent(logger.currentLogFilePath);
    const raw = fs.readFileSync(logger.currentLogFilePath, "utf8");
    const parsed = JSON.parse(raw.trim().split("\n").pop()!);

    assert.equal(parsed.timestamp, ringEntry!.timestamp);
    await logger.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("logging circular or BigInt metadata does not throw", async () => {
  // Regression test: the human-readable transport's format used plain JSON.stringify on
  // meta, which throws synchronously - at the logger.info() call site itself, not just
  // inside winston's formatter - for a circular reference or a BigInt value. Confirmed
  // this crashed the calling code entirely (winston.format.json(), used by the
  // machine-readable transport, already handled both safely on its own).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  try {
    const logger = new Logger(dataDir);
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    assert.doesNotThrow(() => logger.info("Circular metadata", circular));
    assert.doesNotThrow(() => logger.info("BigInt metadata", { rowId: 123n }));

    await waitForFileContent(logger.currentLogFilePath);
    const lines = fs.readFileSync(logger.currentLogFilePath, "utf8").trim().split("\n");
    assert.deepEqual(JSON.parse(lines[0]!).meta, { a: 1, self: "[Circular]" });
    assert.deepEqual(JSON.parse(lines[1]!).meta, { rowId: "123" });

    await logger.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
