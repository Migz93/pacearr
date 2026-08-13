import { clientLogger } from "./logger";

declare const __APP_VERSION__: string;

interface PlexPin {
  id: number;
  code: string;
}

function clientId() {
  const key = "pacearr-plex-client-id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(key, id);
  return id;
}

function encodeParams(data: Record<string, string>) {
  return Object.entries(data).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PIN_REQUEST_TIMEOUT_MS = 15_000;
const POLL_REQUEST_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function isAbortError(caught: unknown): boolean {
  return caught instanceof Error && caught.name === "AbortError";
}

export class PlexOAuth {
  private headers?: Record<string, string>;
  private pin?: PlexPin;
  private popup?: Window | null;

  preparePopup() {
    const width = 600;
    const height = 700;
    const left = (window.screenLeft ?? window.screenX) + window.innerWidth / 2 - width / 2;
    const top = (window.screenTop ?? window.screenY) + window.innerHeight / 2 - height / 2;
    this.popup = window.open("/login/plex/loading", "Plex Auth", `scrollbars=yes,width=${width},height=${height},top=${top},left=${left}`);
    clientLogger.debug("Plex OAuth popup prepared", { opened: Boolean(this.popup && !this.popup.closed) });
    this.popup?.focus();
  }

  async login(): Promise<string> {
    if (!this.popup || this.popup.closed) {
      clientLogger.warn("Plex OAuth popup was unavailable before login started");
      throw new Error("Plex login popup could not be opened.");
    }
    // Give mobile browsers a moment to commit the user-opened same-origin popup
    // before redirecting it to the cross-origin Plex auth page.
    await wait(1500);
    this.headers = {
      Accept: "application/json",
      "X-Plex-Product": "Pacearr",
      "X-Plex-Version": __APP_VERSION__,
      "X-Plex-Client-Identifier": clientId(),
      "X-Plex-Model": "Plex OAuth",
      "X-Plex-Platform": "Web",
      "X-Plex-Language": "en",
    };
    let pinResponse: Response;
    try {
      pinResponse = await fetchWithTimeout("https://plex.tv/api/v2/pins?strong=true", { method: "POST", headers: this.headers }, PIN_REQUEST_TIMEOUT_MS);
    } catch (caught) {
      clientLogger.error("Plex OAuth PIN request could not be completed", {
        errorType: caught instanceof Error ? caught.name : typeof caught,
      });
      throw caught;
    }
    if (!pinResponse.ok) {
      clientLogger.warn("Plex OAuth PIN request failed", { status: pinResponse.status, statusText: pinResponse.statusText });
      throw new Error(`Failed to get Plex PIN: ${pinResponse.status}`);
    }
    try {
      this.pin = await pinResponse.json() as PlexPin;
    } catch (caught) {
      clientLogger.error("Plex OAuth PIN response could not be parsed", {
        stage: "pin_creation",
        errorType: caught instanceof Error ? caught.name : typeof caught,
      });
      throw caught;
    }
    const params = {
      clientID: this.headers["X-Plex-Client-Identifier"],
      "context[device][product]": "Pacearr",
      "context[device][version]": __APP_VERSION__,
      "context[device][platform]": "Web",
      "context[device][layout]": "desktop",
      code: this.pin.code,
      forwardUrl: `${window.location.origin}/login/plex/done`,
    };
    this.popup.location.href = `https://app.plex.tv/auth/#!?${encodeParams(params)}`;
    return this.poll();
  }

  private async poll(): Promise<string> {
    if (!this.pin || !this.headers) {
      clientLogger.error("Plex OAuth polling started without required state", {
        hasPin: Boolean(this.pin),
        hasHeaders: Boolean(this.headers),
      });
      throw new Error("Plex OAuth state was not initialized.");
    }
    // The user may close the popup manually before the token arrives (or, now that the
    // popup closes itself once Plex confirms auth, the close can simply be observed before
    // this loop's next tick). Allow a few extra polls after detecting closure before giving
    // up, in case the Plex API response is slightly delayed. Grace polls don't consume the
    // main attempts budget, so a popup closing near attempt 180 still gets the full grace
    // period instead of being cut off by the outer timeout.
    let gracePollsLeft = 5;
    for (let attempts = 0; attempts < 180; attempts++) {
      let response: Response;
      try {
        response = await fetchWithTimeout(`https://plex.tv/api/v2/pins/${this.pin.id}`, { headers: this.headers }, POLL_REQUEST_TIMEOUT_MS);
      } catch (caught) {
        if (isAbortError(caught)) {
          clientLogger.warn("Plex OAuth PIN polling request timed out; retrying");
          await wait(1000);
          continue;
        }
        clientLogger.error("Plex OAuth PIN polling could not be completed", {
          errorType: caught instanceof Error ? caught.name : typeof caught,
        });
        throw caught;
      }
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          clientLogger.warn("Plex OAuth PIN polling returned a transient error; retrying", { status: response.status });
          await wait(1000);
          continue;
        }
        clientLogger.warn("Plex OAuth PIN polling failed", { status: response.status, statusText: response.statusText });
        throw new Error(`Failed to poll Plex PIN: ${response.status}`);
      }
      let data: { authToken?: string | null };
      try {
        data = await response.json() as { authToken?: string | null };
      } catch (caught) {
        clientLogger.error("Plex OAuth PIN response could not be parsed", {
          stage: "pin_polling",
          errorType: caught instanceof Error ? caught.name : typeof caught,
        });
        throw caught;
      }
      if (data.authToken) {
        this.popup?.close();
        return data.authToken;
      }
      if (this.popup?.closed) {
        if (gracePollsLeft <= 0) {
          clientLogger.warn("Plex OAuth popup closed before authorization completed");
          throw new Error("Plex login popup was closed before authorization completed.");
        }
        clientLogger.debug("Plex OAuth popup closed; retrying authorization poll", { gracePollsLeft });
        gracePollsLeft -= 1;
        attempts -= 1;
      }
      await wait(1000);
    }
    clientLogger.warn("Plex OAuth authorization timed out");
    throw new Error("Timed out waiting for Plex authorization.");
  }
}
