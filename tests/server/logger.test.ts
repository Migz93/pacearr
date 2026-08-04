import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Logger } from "../../src/server/logger.js";

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
