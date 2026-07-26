import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import type { LogEntry } from "../shared/types.js";

const LOG_RING_SIZE = 500;
const LOG_FILE_PREFIX = "pacearr-";
const LOG_FILE_SUFFIX = ".log";

export class Logger {
  private readonly ring: LogEntry[] = [];
  private readonly logger: winston.Logger;
  private readonly logDir: string;

  constructor(dataDir: string) {
    this.logDir = path.join(dataDir, "logs");
    fs.mkdirSync(this.logDir, { recursive: true });

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: "HH:mm:ss" }),
            winston.format.printf(({ level, message, timestamp, ...meta }) => {
              const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
              return `${timestamp} ${level}: ${message}${extra}`;
            })
          ),
        }),
        new DailyRotateFile({
          filename: path.join(this.logDir, "pacearr-%DATE%.log"),
          datePattern: "YYYY-MM-DD",
          maxFiles: "14d",
          maxSize: "10m",
          zippedArchive: true,
          createSymlink: true,
          symlinkName: "pacearr.log",
        }),
      ],
    });
  }

  private write(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(meta !== undefined ? { meta } : {}),
    };

    this.ring.push(entry);
    if (this.ring.length > LOG_RING_SIZE) this.ring.shift();

    if (meta !== undefined) {
      this.logger[level](message, meta as object);
    } else {
      this.logger[level](message);
    }
  }

  getRecentLogs(limit = 200): LogEntry[] {
    // The ring makes live entries immediately available. Reading retained JSON
    // files as well means Settings → Logs survives restarts and container updates.
    const persisted = this.readPersistedLogs();
    const merged = new Map<string, LogEntry>();
    for (const entry of [...persisted, ...this.ring]) {
      merged.set(`${entry.timestamp}\u0000${entry.level}\u0000${entry.message}\u0000${JSON.stringify(entry.meta)}`, entry);
    }
    return [...merged.values()]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-Math.max(1, limit));
  }

  private readPersistedLogs(): LogEntry[] {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter((file) => file.startsWith(LOG_FILE_PREFIX) && (file.endsWith(LOG_FILE_SUFFIX) || file.endsWith(`${LOG_FILE_SUFFIX}.gz`)))
        .sort()
        .slice(-14);
      const entries: LogEntry[] = [];
      for (const file of files) {
        const contents = fs.readFileSync(path.join(this.logDir, file));
        const text = file.endsWith(".gz") ? zlib.gunzipSync(contents).toString("utf8") : contents.toString("utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as Partial<LogEntry>;
            if (typeof parsed.timestamp === "string" && typeof parsed.message === "string" &&
              (parsed.level === "debug" || parsed.level === "info" || parsed.level === "warn" || parsed.level === "error")) {
              entries.push({ timestamp: parsed.timestamp, level: parsed.level, message: parsed.message, ...(parsed.meta !== undefined ? { meta: parsed.meta } : {}) });
            }
          } catch {
            // A partially written final line must not make the log viewer unavailable.
          }
        }
      }
      return entries;
    } catch {
      return [];
    }
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
