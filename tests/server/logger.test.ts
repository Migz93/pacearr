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

  const logger = new Logger(dataDir);
  try {
    logger.info("Live entry");
    await Promise.all([
      waitForFileContent(logger.currentLogFilePath),
      waitForFileContent(path.join(dataDir, "logs", "pacearr.log")),
    ]);
    const messages = logger.getRecentLogs(10).map((entry) => entry.message);
    assert.deepEqual(messages, ["Live entry"]);
  } finally {
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("currentLogFilePath points at the machine-readable transport's fixed symlink name", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  const logger = new Logger(dataDir);
  try {
    // DailyRotateFile opens both output streams asynchronously. Make each one perform
    // its first write before teardown, otherwise a fresh logger with no writes can leave
    // an open attempt queued after rmSync removes this test's temporary directory.
    logger.info("Logger path initialization");
    await Promise.all([
      waitForFileContent(logger.currentLogFilePath),
      waitForFileContent(path.join(dataDir, "logs", "pacearr.log")),
    ]);
    assert.equal(logger.currentLogFilePath, path.join(dataDir, "logs", ".machinelogs.json"));
  } finally {
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("close is idempotent", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  const logger = new Logger(dataDir);
  try {
    logger.info("Closing twice");
    await Promise.all([
      waitForFileContent(logger.currentLogFilePath),
      waitForFileContent(path.join(dataDir, "logs", "pacearr.log")),
    ]);
    await Promise.all([logger.close(), logger.close()]);
    await logger.close();
  } finally {
    await logger.close();
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
async function waitForFileContent(filePath: string, timeoutMs = 2000, predicate: (content: string) => boolean = (content) => content.trim().length > 0): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      if (predicate(content)) return content;
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
  const logger = new Logger(dataDir);
  try {
    // Simulates history from before this process started (e.g. a restart) - only in the
    // file, never reaches the ring.
    fs.writeFileSync(logger.currentLogFilePath, `${JSON.stringify(entry({ message: "File-only entry" }))}\n`);
    logger.info("Ring-only entry");

    const messages = readRecentLogEntries(logger).map((item) => item.message);
    assert.deepEqual(messages.sort(), ["File-only entry", "Ring-only entry"]);
  } finally {
    // Can't wait on logger.currentLogFilePath itself here - this test already wrote
    // a plain file at that path above, and file-stream-rotator only (re)creates the
    // symlink when lstat on that path throws ENOENT or finds an existing symlink, so it
    // silently leaves our pre-existing plain file alone forever. The human-readable
    // symlink is never touched by this test, so waiting on it actually reflects winston's
    // real flush.
    await waitForFileContent(path.join(dataDir, "logs", "pacearr.log"));
    await logger.close();
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
  const logger = new Logger(dataDir);
  try {
    logger.info("Scheduled job started", { id: "session-check", scheduled: true });
    await Promise.all([
      waitForFileContent(logger.currentLogFilePath),
      waitForFileContent(path.join(dataDir, "logs", "pacearr.log")),
    ]);

    const raw = fs.readFileSync(logger.currentLogFilePath, "utf8");
    const parsed = JSON.parse(raw.trim().split("\n").pop()!);
    assert.deepEqual(parsed.meta, { id: "session-check", scheduled: true });
    assert.equal(parsed.id, undefined, "metadata must not also leak onto top-level fields");
  } finally {
    await logger.close();
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
  const logger = new Logger(dataDir);
  try {
    logger.info("Timestamp consistency check");
    const [ringEntry] = logger.getRecentLogs(1);

    await Promise.all([
      waitForFileContent(logger.currentLogFilePath),
      waitForFileContent(path.join(dataDir, "logs", "pacearr.log")),
    ]);
    const raw = fs.readFileSync(logger.currentLogFilePath, "utf8");
    const parsed = JSON.parse(raw.trim().split("\n").pop()!);

    assert.equal(parsed.timestamp, ringEntry!.timestamp);
  } finally {
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("logging circular or BigInt metadata does not throw, in the ring, the persisted file, or the Logs API's own merge", async () => {
  // Regression test: a first fix only sanitized humanFormat's own JSON.stringify(meta)
  // call, but write() still stored the raw circular/BigInt value in the ring entry
  // itself. That raw value was still reachable via readRecentLogEntries ->
  // mergeLogEntries (used by the actual /api/settings/logs route), which does its own
  // unguarded JSON.stringify(entry.meta) for the dedup key - so the log call itself
  // wouldn't crash, but the next request to load Settings -> Logs would. Sanitizing once
  // in write(), before meta enters the ring, closes that gap for every consumer at once.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  const logger = new Logger(dataDir);
  try {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    assert.doesNotThrow(() => logger.info("Circular metadata", circular));
    assert.doesNotThrow(() => logger.info("BigInt metadata", { rowId: 123n }));

    const [circularEntry, bigintEntry] = logger.getRecentLogs(2);
    assert.deepEqual(circularEntry!.meta, { a: 1, self: "[Circular]" });
    assert.deepEqual(bigintEntry!.meta, { rowId: "123" });

    assert.doesNotThrow(() => readRecentLogEntries(logger));

    await Promise.all([
      waitForFileContent(logger.currentLogFilePath, 2000, (content) => content.trim().split("\n").length >= 2),
      waitForFileContent(path.join(dataDir, "logs", "pacearr.log"), 2000, (content) => content.trim().split("\n").length >= 2),
    ]);
    const lines = fs.readFileSync(logger.currentLogFilePath, "utf8").trim().split("\n");
    assert.deepEqual(JSON.parse(lines[0]!).meta, { a: 1, self: "[Circular]" });
    assert.deepEqual(JSON.parse(lines[1]!).meta, { rowId: "123" });
  } finally {
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("logging metadata that throws during serialization does not interrupt application work", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  const logger = new Logger(dataDir);
  try {
    const throwingGetter = { get value() { throw new Error("getter failed"); } };
    const throwingToJson = { toJSON() { throw new Error("toJSON failed"); } };
    assert.doesNotThrow(() => logger.info("Throwing getter metadata", throwingGetter));
    assert.doesNotThrow(() => logger.info("Throwing toJSON metadata", throwingToJson));
    assert.deepEqual(logger.getRecentLogs(2).map((entry) => entry.meta), [undefined, undefined]);
    // Both transports open and write asynchronously. Let their first writes complete
    // before teardown so rmSync cannot race a transport still creating its log file.
    await Promise.all([
      waitForFileContent(logger.currentLogFilePath, 2000, (content) => content.trim().split("\n").length >= 2),
      waitForFileContent(path.join(dataDir, "logs", "pacearr.log"), 2000, (content) => content.trim().split("\n").length >= 2),
    ]);
  } finally {
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("logging the same object referenced twice preserves both, rather than marking the repeat as circular", async () => {
  // Regression test: an earlier version of sanitizeMeta tracked every object it had ever
  // seen in a single WeakSet, so two sibling properties referencing the same object
  // (e.g. { previous: user, current: user }, not an actual cycle) had the second
  // occurrence silently replaced with "[Circular]", discarding its real value. Ancestry
  // must be tracked instead - only an object that is genuinely its own ancestor (a true
  // cycle) should be replaced.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  const logger = new Logger(dataDir);
  try {
    const shared = { id: 42, name: "Shared" };
    logger.info("Shared reference metadata", { previous: shared, current: shared });

    const [ringEntry] = logger.getRecentLogs(1);
    assert.deepEqual(ringEntry!.meta, { previous: { id: 42, name: "Shared" }, current: { id: 42, name: "Shared" } });

    await Promise.all([
      waitForFileContent(logger.currentLogFilePath),
      waitForFileContent(path.join(dataDir, "logs", "pacearr.log")),
    ]);
    const raw = fs.readFileSync(logger.currentLogFilePath, "utf8");
    const parsed = JSON.parse(raw.trim().split("\n").pop()!);
    assert.deepEqual(parsed.meta, { previous: { id: 42, name: "Shared" }, current: { id: 42, name: "Shared" } });
  } finally {
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("logging a root metadata value with no JSON representation does not throw and omits metadata", async () => {
  // Regression test: JSON.stringify returns undefined (not a string) for a bare function
  // or Symbol at the root, so JSON.parse(undefined) would throw SyntaxError before
  // winston ever saw the entry. sanitizeMeta must recognize that and treat it the same as
  // no meta being passed at all, rather than crashing the log call.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  const logger = new Logger(dataDir);
  try {
    assert.doesNotThrow(() => logger.info("Function metadata", () => {}));
    assert.doesNotThrow(() => logger.info("Symbol metadata", Symbol("nope")));

    const [functionEntry, symbolEntry] = logger.getRecentLogs(2);
    assert.equal(functionEntry!.meta, undefined);
    assert.equal(symbolEntry!.meta, undefined);

    // Wait for both async writes to reach disk before close()/rmSync() below, or the
    // second write can still be in flight when the temp dir is removed - see the
    // waitForFileContent docstring above.
    await Promise.all([
      waitForFileContent(logger.currentLogFilePath, 2000, (content) => content.trim().split("\n").length >= 2),
      waitForFileContent(path.join(dataDir, "logs", "pacearr.log"), 2000, (content) => content.trim().split("\n").length >= 2),
    ]);
  } finally {
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the human-readable log retains falsy scalar metadata instead of treating it as absent", async () => {
  // Regression test: humanFormat checked `meta && Object.keys(meta).length`, which treats
  // a real but falsy scalar meta (0, false, "", null) the same as "no meta" and silently
  // drops it from pacearr.log. The ring, machine-readable JSON file, and Logs API are
  // unaffected since only this printf format has the truthiness check.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  const logger = new Logger(dataDir);
  const humanLogPath = path.join(dataDir, "logs", "pacearr.log");
  try {
    logger.info("Zero metadata", 0);
    logger.info("False metadata", false);
    logger.info("Empty string metadata", "");
    logger.info("Null metadata", null);

    const expectedLines = ["Zero metadata 0", "False metadata false", 'Empty string metadata ""', "Null metadata null"];
    // waitForFileContent's default predicate returns as soon as the file has any content -
    // with four separate async writes queued, that's only guaranteed to be the first of
    // them. Wait for all four lines specifically before reading.
    await Promise.all([
      waitForFileContent(logger.currentLogFilePath, 2000, (content) => content.trim().split("\n").length >= expectedLines.length),
      waitForFileContent(humanLogPath, 2000, (content) => expectedLines.every((line) => content.includes(line))),
    ]);
    const lines = fs.readFileSync(humanLogPath, "utf8").trim().split("\n");
    for (const expected of expectedLines) assert.ok(lines.some((line) => line.endsWith(expected)));
  } finally {
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
