import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { Logger } from "../../src/server/logger.js";

test("recent logs include retained rotated files after a restart", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacearr-logger-"));
  const logDir = path.join(dataDir, "logs");
  fs.mkdirSync(logDir);
  const oldEntry = { timestamp: "2026-07-01T12:00:00.000Z", level: "info", message: "Retained entry", meta: { job: "history-import" } };
  const compressedEntry = { timestamp: "2026-07-02T12:00:00.000Z", level: "warn", message: "Compressed retained entry" };
  fs.writeFileSync(path.join(logDir, "pacearr-2026-07-01.log"), `${JSON.stringify(oldEntry)}\n`);
  fs.writeFileSync(path.join(logDir, "pacearr-2026-07-02.log.gz"), zlib.gzipSync(`${JSON.stringify(compressedEntry)}\n`));

  try {
    const logger = new Logger(dataDir);
    logger.info("Live entry");
    const messages = logger.getRecentLogs(10).map((entry) => entry.message);
    assert.deepEqual(messages, ["Retained entry", "Compressed retained entry", "Live entry"]);
    // Winston's rotating transport opens its target lazily. Give that open and
    // write a chance to settle before removing the fixture directory.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
