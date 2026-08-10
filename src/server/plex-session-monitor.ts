import { EventSource, type ErrorEvent } from "eventsource";
import type { PlexSettingsInput } from "../shared/types.js";
import type { Logger } from "./logger.js";

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 30_000;

export type PlexSessionMonitorStatus = {
  mode: "live" | "polling-fallback" | "unavailable";
  description: string;
};

type NotificationEnvelope = {
  NotificationContainer?: {
    PlaySessionStateNotification?: { state?: string } | Array<{ state?: string }>;
  };
};

export class PlexSessionMonitor {
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private stopped = true;
  private status: PlexSessionMonitorStatus = { mode: "unavailable", description: "Live playback will start after Plex is configured." };

  constructor(
    private readonly getSettings: () => PlexSettingsInput | null,
    private readonly logger: Logger,
    private readonly onPlayback: () => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  restart(): void {
    this.closeConnection();
    this.reconnectDelayMs = INITIAL_RECONNECT_MS;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.closeConnection();
  }

  getStatus(): PlexSessionMonitorStatus {
    return this.status;
  }

  private connect(): void {
    if (this.stopped || this.source) return;
    const settings = this.getSettings();
    if (!settings) {
      this.status = { mode: "unavailable", description: "Live playback will start after Plex is configured." };
      return;
    }
    let endpoint: URL;
    try {
      const base = new URL(settings.serverUrl.endsWith("/") ? settings.serverUrl : `${settings.serverUrl}/`);
      if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("Plex server URL must use HTTP or HTTPS.");
      endpoint = new URL(":/eventsource/notifications", base);
    } catch (error) {
      this.status = { mode: "polling-fallback", description: "Live Plex playback is unavailable; using polling fallback." };
      this.logger.warn("Plex SSE endpoint is invalid; using polling fallback", { error: error instanceof Error ? error.message : String(error) });
      this.scheduleReconnect();
      return;
    }
    this.status = { mode: "polling-fallback", description: "Live Plex playback is reconnecting; using polling fallback." };
    this.logger.info("Opening live Plex playback connection", { origin: endpoint.origin });
    this.source = new EventSource(endpoint, {
      fetch: async (input, init) => {
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          headers: { ...init.headers, "User-Agent": "Pacearr", "X-Plex-Token": settings.token },
        });
        if (new URL(response.url).origin !== endpoint.origin) throw new Error("Plex SSE request crossed origins.");
        return response;
      },
    });
    this.source.addEventListener("open", this.handleOpen);
    this.source.addEventListener("message", this.handleMessage);
    this.source.addEventListener("error", this.handleError);
    this.connectionTimer = setTimeout(() => {
      if (this.source?.readyState === EventSource.CONNECTING) {
        this.logger.warn("Live Plex playback connection timed out; using polling fallback");
        this.disconnectAndReconnect();
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  private handleOpen = (): void => {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    this.reconnectDelayMs = INITIAL_RECONNECT_MS;
    this.status = { mode: "live", description: "Live Plex playback detection is connected." };
    this.logger.info("Live Plex playback connection established");
  };

  private handleMessage = (event: MessageEvent<string>): void => {
    let payload: NotificationEnvelope;
    try { payload = JSON.parse(event.data) as NotificationEnvelope; } catch {
      this.logger.debug("Ignoring malformed Plex SSE notification");
      return;
    }
    const notifications = payload.NotificationContainer?.PlaySessionStateNotification;
    const states = (Array.isArray(notifications) ? notifications : notifications ? [notifications] : []).map((notification) => notification.state);
    if (states.some((state) => state === "playing" || state === "buffering")) {
      this.logger.debug("Live Plex playback notification received", { states });
      this.onPlayback();
    }
  };

  private handleError = (event: ErrorEvent): void => {
    if (this.stopped) return;
    this.logger.warn("Live Plex playback connection dropped; using polling fallback", { code: event.code ?? null, error: event.message ?? null });
    this.disconnectAndReconnect();
  };

  private disconnectAndReconnect(): void {
    this.closeConnection();
    this.status = { mode: "polling-fallback", description: "Live Plex playback is reconnecting; using polling fallback." };
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(MAX_RECONNECT_MS, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.logger.info("Scheduled live Plex playback reconnect", { delayMs });
  }

  private closeConnection(): void {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connectionTimer = null;
    this.reconnectTimer = null;
    if (!this.source) return;
    this.source.removeEventListener("open", this.handleOpen);
    this.source.removeEventListener("message", this.handleMessage);
    this.source.removeEventListener("error", this.handleError);
    this.source.close();
    this.source = null;
  }
}
