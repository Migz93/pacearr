import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import type { LogEntry } from "../shared/types.js";

const LOG_RING_SIZE = 500;

/**
 * Reduces arbitrary metadata to a plain, JSON-round-trippable value once, at the point
 * it's logged - rather than leaving the raw value in place and hoping every downstream
 * consumer that might later JSON.stringify it (humanFormat, mergeLogEntries's dedup key,
 * the eventual res.json() response) each remembers to guard against circular references
 * and BigInt independently. A previous fix only patched humanFormat; the same raw meta
 * was still reachable via the ring -> readRecentLogEntries -> mergeLogEntries, and would
 * have broken the Logs API response the same way. Sanitizing once in write(), before the
 * value enters the ring or reaches winston, means every consumer only ever sees an
 * already-safe value.
 */
function sanitizeMeta(value: unknown): unknown {
  // A WeakSet of every object seen anywhere in the tree would flag two sibling
  // properties that happen to reference the same object (e.g. { x: user, y: user }) as
  // circular, even though neither is actually a cycle - silently discarding the second
  // occurrence's real value. Track ancestry instead: parentOf lets isAncestor walk back
  // from the current holder to the root, so only an object that is genuinely one of its
  // own ancestors (a true cycle, direct or indirect) gets replaced.
  const parentOf = new WeakMap<object, unknown>();
  function isAncestor(candidate: object, holder: unknown): boolean {
    let current = holder;
    while (current && typeof current === "object") {
      if (current === candidate) return true;
      current = parentOf.get(current as object);
    }
    return false;
  }
  const json = JSON.stringify(value, function (this: unknown, _key, val: unknown) {
    if (typeof val === "bigint") return val.toString();
    if (typeof val === "object" && val !== null) {
      if (isAncestor(val, this)) return "[Circular]";
      parentOf.set(val, this);
    }
    return val;
  });
  // A root value with no JSON representation (a bare function or Symbol) makes
  // JSON.stringify return undefined rather than a string - JSON.parse(undefined) would
  // throw SyntaxError before winston ever sees the entry. Treat it the same as no meta at
  // all instead, since there's nothing meaningful to log.
  return json === undefined ? undefined : JSON.parse(json);
}

// Matches hubarr's log architecture exactly: a human-readable, pretty-printed file for
// manual inspection (7 days), and a separate machine-readable JSON file (3 days) that
// the app's own Logs viewer reads via currentLogFilePath below. Previously pacearr had
// one combined 14-day JSON file serving both purposes.
const humanFormat = winston.format.printf(({ level, message, timestamp, meta }) => {
  // Safe to use plain JSON.stringify here - meta arrives already sanitized by write()'s
  // sanitizeMeta() call, not the raw value passed to logger.info()/warn()/etc.
  // Checking truthiness (rather than presence) would treat a falsy-but-real scalar meta
  // (0, false, "", null) the same as no meta at all and silently drop it from this file.
  const hasMeta = meta !== undefined && (meta === null || typeof meta !== "object" || Object.keys(meta as object).length > 0);
  const extra = hasMeta ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} ${level}: ${message}${extra}`;
});

export class Logger {
  private readonly ring: LogEntry[] = [];
  private readonly logger: winston.Logger;
  private readonly logDir: string;

  constructor(dataDir: string) {
    this.logDir = path.join(dataDir, "logs");
    fs.mkdirSync(this.logDir, { recursive: true });

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || "info",
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            // Logger.write() supplies the ISO timestamp shared with the ring and files;
            // keep the console display compact without generating a second timestamp.
            winston.format((info) => {
              info.timestamp = typeof info.timestamp === "string" ? info.timestamp.slice(11, 19) : info.timestamp;
              return info;
            })(),
            winston.format.errors({ stack: true }),
            humanFormat
          ),
        }),
        new DailyRotateFile({
          filename: path.join(this.logDir, "pacearr-%DATE%.log"),
          datePattern: "YYYY-MM-DD",
          maxFiles: "7d",
          maxSize: "10m",
          zippedArchive: true,
          createSymlink: true,
          symlinkName: "pacearr.log",
          // No format.timestamp() here - write() supplies its own timestamp explicitly
          // (see below) so this file's entries match the ring's exactly, not a second,
          // independently-generated one.
          format: winston.format.combine(
            winston.format.errors({ stack: true }),
            humanFormat
          ),
        }),
        new DailyRotateFile({
          filename: path.join(this.logDir, ".machinelogs-%DATE%.json"),
          datePattern: "YYYY-MM-DD",
          maxFiles: "3d",
          maxSize: "10m",
          zippedArchive: true,
          createSymlink: true,
          symlinkName: ".machinelogs.json",
          format: winston.format.combine(
            winston.format.errors({ stack: true }),
            winston.format.json()
          ),
        }),
      ],
    });
  }

  private write(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    const timestamp = new Date().toISOString();
    // Sanitize once, before meta enters the ring or reaches winston - see sanitizeMeta's
    // comment for why patching individual downstream consumers isn't enough.
    const safeMeta = meta !== undefined ? sanitizeMeta(meta) : undefined;
    const entry: LogEntry = {
      timestamp,
      level,
      message,
      ...(safeMeta !== undefined ? { meta: safeMeta } : {}),
    };

    this.ring.push(entry);
    if (this.ring.length > LOG_RING_SIZE) this.ring.shift();

    // Winston's second argument is spread onto the top-level log object, not nested -
    // passing meta directly (rather than wrapped) would serialize it as top-level fields
    // instead of a "meta" key, which readTodaysLogEntries/mergeLogEntries wouldn't
    // recognize. Passing our own timestamp here too (instead of relying on
    // format.timestamp() in the file transports) guarantees the persisted file's
    // timestamp always matches the ring entry's exactly - two separate `new Date()` calls
    // can and do land in different milliseconds, which broke mergeLogEntries' dedup key
    // for any entry still present in both sources (confirmed ~16% mismatch rate).
    this.logger[level](message, safeMeta !== undefined ? { timestamp, meta: safeMeta } : { timestamp });
  }

  getRecentLogs(limit = 200): LogEntry[] {
    return this.ring.slice(-Math.max(1, limit));
  }

  /**
   * Ends the underlying winston stream so a test isn't left with an open file handle
   * before removing its fixture directory. Does NOT guarantee an in-flight write has
   * reached disk yet - winston's top-level "finish" event fires once its own stream
   * ends, not necessarily once every transport's write has actually flushed. A test that
   * needs to read back what it just logged should poll for the file to have content
   * rather than assume close() alone is sufficient.
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.logger.on("finish", () => resolve());
      this.logger.end();
    });
  }

  /**
   * The machine-readable transport always symlinks its active file to this fixed name,
   * regardless of date. Settings -> Logs reads it directly and combines it with the
   * in-memory ring (see readRecentLogEntries in app.ts) rather than treating one as a
   * fallback for the other, since either can hold history the other doesn't depending on
   * restart/rotation timing. Deliberately just today's file, not every retained rotated
   * file: reading and merging all of them, including gzip decompression for the older
   * ones, blocked the event loop on every concurrent request while Settings -> Logs was
   * open with auto-refresh. The separate human-readable pacearr.log is for manual
   * inspection only - the app itself never reads it.
   */
  get currentLogFilePath(): string {
    return path.join(this.logDir, ".machinelogs.json");
  }

  debug(message: string, meta?: unknown) {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown) {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown) {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown) {
    this.write("error", message, meta);
  }

}
