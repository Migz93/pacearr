import fs from "node:fs";
import path from "node:path";

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION = readVersion();
export const BUILD_CHANNEL = process.env.BUILD_CHANNEL || "custom";
export const BUILD_COMMIT = process.env.COMMIT_SHA || "local";
export const PLEX_USER_AGENT = `Pacearr/${APP_VERSION}`;
