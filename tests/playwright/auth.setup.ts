import { test as setup } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const authFile = "tests/playwright/.auth/storageState.json";
const baseURL = process.env.BASE_URL?.trim() || "http://localhost:9302";

setup("authenticate", async ({ request }) => {
  if (readStorageState()) {
    const currentHost = new URL(baseURL).hostname;
    const currentSecure = new URL(baseURL).protocol === "https:";
    const savedDomain = getSavedCookieDomain();
    if (savedDomain === currentHost && getSavedCookieSecure() === currentSecure) {
      const response = await request.get("/api/auth/session", { headers: { Cookie: buildCookieHeader() } });
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
  const url = new URL(baseURL);
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
  const fileDescriptor = fs.openSync(
    authFile,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fileDescriptor, storageState);
    fs.fchmodSync(fileDescriptor, 0o600);
  } finally {
    fs.closeSync(fileDescriptor);
  }
});

function buildCookieHeader(): string {
  const state = readStorageState();
  if (!state) return "";
  return state.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function getSavedCookieDomain(): string | null {
  const state = readStorageState();
  if (!state) return null;
  return state.cookies[0]?.domain ?? null;
}

function getSavedCookieSecure(): boolean | null {
  const state = readStorageState();
  if (!state) return null;
  return state.cookies[0]?.secure ?? null;
}

function readStorageState(): { cookies: Array<{ name: string; value: string; domain?: string; secure?: boolean }> } | null {
  try {
    return JSON.parse(fs.readFileSync(authFile, "utf-8")) as { cookies: Array<{ name: string; value: string; domain?: string; secure?: boolean }> };
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return null;
    throw caught;
  }
}
