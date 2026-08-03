type ClientLogMeta = Record<string, unknown>;

function write(level: "debug" | "warn" | "error", message: string, meta?: ClientLogMeta): void {
  const method = console[level];
  if (meta === undefined) {
    method(`[Pacearr] ${message}`);
    return;
  }
  method(`[Pacearr] ${message}`, meta);
}

export const clientLogger = {
  debug(message: string, meta?: ClientLogMeta) {
    write("debug", message, meta);
  },
  warn(message: string, meta?: ClientLogMeta) {
    write("warn", message, meta);
  },
  error(message: string, meta?: ClientLogMeta) {
    write("error", message, meta);
  },
};
