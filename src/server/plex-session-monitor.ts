import { EventSource, type ErrorEvent } from "eventsource";
import type { PlexSettingsInput } from "../shared/types.js";
import { buildPlexServerUrl } from "./integrations/plex.js";
import type { Logger } from "./logger.js";
import { PLEX_USER_AGENT } from "./version.js";

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;

export type PlexSessionMonitorStatus = {
  mode: "live" | "polling-fallback" | "unavailable";
  description: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function playbackStates(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const container = isRecord(payload.NotificationContainer) ? payload.NotificationContainer : null;
  const notifications = payload.PlaySessionStateNotification ?? container?.PlaySessionStateNotification;
  const entries = Array.isArray(notifications) ? notifications : [notifications];
  return entries.flatMap((entry) => isRecord(entry) && typeof entry.state === "string" ? [entry.state] : []);
}

export type PlexSessionMonitorOptions = {
  initialReconnectMs?: number;
  maxReconnectMs?: number;
  heartbeatTimeoutMs?: number;
};

export class PlexSessionMonitor {
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly initialReconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly heartbeatTimeoutMs: number;
  private reconnectDelayMs: number;
  private stopped = true;
  private status: PlexSessionMonitorStatus = { mode: "unavailable", description: "Live playback will start after Plex is configured." };

  constructor(
    private readonly getSettings: () => PlexSettingsInput | null,
    private readonly logger: Logger,
    private readonly onPlayback: () => void,
    options: PlexSessionMonitorOptions = {},
  ) {
    this.initialReconnectMs = options.initialReconnectMs ?? INITIAL_RECONNECT_MS;
    this.maxReconnectMs = options.maxReconnectMs ?? MAX_RECONNECT_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.reconnectDelayMs = this.initialReconnectMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  restart(): void {
    this.closeConnection();
    this.reconnectDelayMs = this.initialReconnectMs;
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
      this.scheduleReconnect();
      return;
    }
    let endpoint: URL;
    try {
      endpoint = buildPlexServerUrl(settings.serverUrl, ":/eventsource/notifications");
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("Plex server URL must use HTTP or HTTPS.");
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
          headers: { ...init.headers, "User-Agent": PLEX_USER_AGENT, "X-Plex-Token": settings.token },
        });
        if (new URL(response.url).origin !== endpoint.origin) throw new Error("Plex SSE request crossed origins.");
        return response;
      },
    });
    this.source.addEventListener("open", this.handleOpen);
    this.source.addEventListener("message", this.handleMessage);
    this.source.addEventListener("playing", this.handleMessage);
    this.source.addEventListener("ping", this.resetHeartbeat);
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
    this.reconnectDelayMs = this.initialReconnectMs;
    this.status = { mode: "live", description: "Live Plex playback detection is connected." };
    this.logger.info("Live Plex playback connection established");
    this.resetHeartbeat();
  };

  private handleMessage = (event: MessageEvent<string>): void => {
    this.resetHeartbeat();
    let payload: unknown;
    try { payload = JSON.parse(event.data); } catch {
      this.logger.debug("Ignoring malformed Plex SSE notification");
      return;
    }
    const states = playbackStates(payload);
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

  private resetHeartbeat = (): void => {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (this.source?.readyState !== EventSource.OPEN) return;
      this.logger.warn("Live Plex playback connection went idle; using polling fallback");
      this.disconnectAndReconnect();
    }, this.heartbeatTimeoutMs);
  };

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.maxReconnectMs, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.logger.info("Scheduled live Plex playback reconnect", { delayMs });
  }

  private closeConnection(): void {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.connectionTimer = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    if (!this.source) return;
    this.source.removeEventListener("open", this.handleOpen);
    this.source.removeEventListener("message", this.handleMessage);
    this.source.removeEventListener("playing", this.handleMessage);
    this.source.removeEventListener("ping", this.resetHeartbeat);
    this.source.removeEventListener("error", this.handleError);
    this.source.close();
    this.source = null;
  }
}
