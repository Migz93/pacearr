import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import type { LogEntry } from "../shared/types.js";

const LOG_RING_SIZE = 500;

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
    return this.ring.slice(-Math.max(1, limit));
  }

  /**
   * The rotating file transport always symlinks its active file to this fixed name,
   * regardless of date. Settings -> Logs reads it directly and combines it with the
   * in-memory ring (see readRecentLogEntries in app.ts) rather than treating one as a
   * fallback for the other, since either can hold history the other doesn't depending on
   * restart/rotation timing. Deliberately just today's file, not every retained rotated
   * file: reading and merging all of them, including gzip decompression for the older
   * ones, blocked the event loop on every concurrent request while Settings -> Logs was
   * open with auto-refresh.
   */
  get currentLogFilePath(): string {
    return path.join(this.logDir, "pacearr.log");
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
