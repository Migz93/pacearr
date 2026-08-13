import { test as setup } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const authFile = "tests/playwright/.auth/storageState.json";
const baseURL = process.env.BASE_URL?.trim() || "http://localhost:9302";
type StorageState = { cookies: Array<{ name: string; value: string; domain?: string; secure?: boolean }> };

function validateBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !loopback) throw new Error("BASE_URL must use HTTPS unless it targets a loopback host.");
  return url;
}

setup("authenticate", async ({ request }) => {
  const baseUrl = validateBaseUrl(baseURL);
  const savedState = readStorageState();
  if (savedState) {
    const currentHost = baseUrl.hostname;
    const currentSecure = baseUrl.protocol === "https:";
    const savedCookie = savedState.cookies.find((cookie) => cookie.name === "pacearr_session");
    if (savedCookie?.domain === currentHost && savedCookie.secure === currentSecure) {
      const response = await request.get("/api/auth/session", { headers: { Cookie: buildCookieHeader(savedState) } });
      const session = await response.json() as { authenticated: boolean };
      if (session.authenticated) return;
    }
  }

  const cookie = process.env.SESSION_COOKIE?.trim();
  if (!cookie) {
    throw new Error(
      "\n\n  SESSION_COOKIE is not set.\n" +
      "  Copy the pacearr_session cookie value from your browser's DevTools\n" +
      "  into .env.playwright, then rerun the tests.\n",
    );
  }

  const response = await request.get("/api/auth/session", {
    headers: { Cookie: `pacearr_session=${encodeURIComponent(cookie)}` },
  });
  const session = await response.json() as { authenticated: boolean };
  if (!session.authenticated) {
    throw new Error("The SESSION_COOKIE value did not authenticate successfully.");
  }

  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  const url = baseUrl;
  const storageState = JSON.stringify({
    cookies: [{
      name: "pacearr_session",
      value: encodeURIComponent(cookie),
      domain: url.hostname,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Strict",
    }],
    origins: [],
  }, null, 2);
  const temporaryAuthFile = `${authFile}.${process.pid}.${Date.now()}.tmp`;
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(
      temporaryAuthFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fileDescriptor, storageState);
    fs.fchmodSync(fileDescriptor, 0o600);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryAuthFile, authFile);
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    try {
      fs.unlinkSync(temporaryAuthFile);
    } catch {
      // The temporary file was renamed successfully or never created.
    }
  }
});

function buildCookieHeader(state: StorageState): string {
  return state.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function readStorageState(): StorageState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(authFile, "utf-8"));
    if (!isStorageState(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isStorageState(value: unknown): value is StorageState {
  if (!value || typeof value !== "object" || !("cookies" in value) || !Array.isArray(value.cookies)) return false;
  return value.cookies.every((cookie) => {
    if (!cookie || typeof cookie !== "object") return false;
    const candidate = cookie as { name?: unknown; value?: unknown; domain?: unknown; secure?: unknown };
    return typeof candidate.name === "string" &&
      typeof candidate.value === "string" &&
      (candidate.domain === undefined || typeof candidate.domain === "string") &&
      (candidate.secure === undefined || typeof candidate.secure === "boolean");
  });
}
