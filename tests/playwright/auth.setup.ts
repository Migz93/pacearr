import { test as setup } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const authFile = "tests/playwright/.auth/storageState.json";
const baseURL = process.env.BASE_URL?.trim() || "http://localhost:9302";

setup("authenticate", async ({ request }) => {
  if (fs.existsSync(authFile)) {
    fs.chmodSync(authFile, 0o600);
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
  fs.writeFileSync(authFile, JSON.stringify({
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
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(authFile, 0o600);
});

function buildCookieHeader(): string {
  if (!fs.existsSync(authFile)) return "";
  const state = JSON.parse(fs.readFileSync(authFile, "utf-8")) as { cookies: Array<{ name: string; value: string }> };
  return state.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function getSavedCookieDomain(): string | null {
  if (!fs.existsSync(authFile)) return null;
  const state = JSON.parse(fs.readFileSync(authFile, "utf-8")) as { cookies: Array<{ domain?: string }> };
  return state.cookies[0]?.domain ?? null;
}

function getSavedCookieSecure(): boolean | null {
  if (!fs.existsSync(authFile)) return null;
  const state = JSON.parse(fs.readFileSync(authFile, "utf-8")) as { cookies: Array<{ secure?: boolean }> };
  return state.cookies[0]?.secure ?? null;
}
