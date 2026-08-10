import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import type { AppSettings, JobInfo, LogEntry, PlexConfigPayload, PlexConnectionOption, SessionUser, UserRecord } from "../shared/types.js";
import { isHistoryCategory } from "../shared/history.js";
import { createSessionId, signedValue } from "./auth.js";
import type { RuntimeConfig } from "./config.js";
import { DEFAULT_APP_SETTINGS, MAX_SAFE_RETENTION_DAYS, PacearrDatabase } from "./db/index.js";
import { PlexIntegration } from "./integrations/plex.js";
import { SonarrIntegration } from "./integrations/sonarr.js";
import { TautulliIntegration } from "./integrations/tautulli.js";
import { ImageCacheService } from "./image-cache.js";
import { JobScheduler } from "./job-scheduler.js";
import { Logger } from "./logger.js";
import { normaliseScheduleIntervalHours, normaliseScheduleIntervalMinutes, parseScheduleIntervalMinutes } from "./schedule-interval.js";
import { PacearrServices } from "./services.js";
import { APP_VERSION, BUILD_CHANNEL, BUILD_COMMIT } from "./version.js";

declare module "express-serve-static-core" {
  interface Request {
    sessionUser?: SessionUser | null;
  }
}

function parseCookies(rawCookie = "") {
  return rawCookie.split(";").map((part) => part.trim()).filter(Boolean).reduce<Map<string, string>>((acc, pair) => {
    const index = pair.indexOf("=");
    if (index !== -1) acc.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
    return acc;
  }, new Map());
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

/**
 * Reads today's active log file directly rather than merging every retained rotated
 * file: the log viewer only needs a bounded, restart-surviving source for whatever the
 * in-memory ring hasn't kept, not the app's full retention history. Returns an empty
 * array (not the ring's job to fill in for this function) if the file is missing,
 * unreadable, or just freshly rotated — normal right after the very first log write of
 * a fresh install, or just after midnight's daily rotation.
 */
function readTodaysLogEntries(logger: Logger): LogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logger.currentLogFilePath, "utf8");
  } catch {
    return [];
  }
  const entries: LogEntry[] = [];
  for (const line of raw.split("\n")) {
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
  return entries;
}

/**
 * Combines today's file with the in-memory ring rather than treating one as a fallback
 * for the other: right after a restart the ring is empty and the file carries recent
 * history, but right after midnight's rotation it's the reverse — the fresh file is
 * still near-empty while the ring still holds the tail end of yesterday's entries (that
 * file is already rotated away and not re-read, by design). Bounded to two small
 * sources — one day's plain-text file plus up to 500 ring entries, no gzip, no scanning
 * prior days — so merging stays cheap.
 */
export function readRecentLogEntries(logger: Logger): LogEntry[] {
  return mergeLogEntries(readTodaysLogEntries(logger), logger.getRecentLogs(500));
}

/**
 * Deduplicates and chronologically sorts entries from multiple sources (today's log file,
 * the in-memory ring). timestamp+message alone isn't a safe dedup key: a synchronous loop
 * can log the same message text for several different items within the same millisecond
 * (e.g. reconcileRollingShows's per-show skip log), varying only in meta — collapsing
 * those would silently drop all but one. Includes level and meta in the key for that
 * reason, matching what this replaced before the ring/file merge existed.
 */
export function mergeLogEntries(...sources: LogEntry[][]): LogEntry[] {
  const merged = new Map<string, LogEntry>();
  for (const source of sources) {
    for (const entry of source) {
      merged.set(`${entry.timestamp} ${entry.level} ${entry.message} ${JSON.stringify(entry.meta)}`, entry);
    }
  }
  return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  return value.trim();
}

function parseServerUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
      useSsl: parsed.protocol === "https:",
    };
  } catch {
    return {};
  }
}

function buildPlexSettingsFromPayload(token: string, payload: PlexConfigPayload | { serverUrl?: string; machineIdentifier?: string }) {
  if ("mode" in payload && payload.mode === "manual") {
    const hostname = requiredString(payload.hostname, "hostname");
    const port = Math.min(65535, Math.max(1, Math.floor(Number(payload.port) || 32400)));
    const protocol = payload.useSsl ? "https" : "http";
    return {
      serverUrl: `${protocol}://${hostname}:${port}`,
      machineIdentifier: "",
      token,
    };
  }

  return {
    serverUrl: requiredString(payload.serverUrl, "serverUrl"),
    machineIdentifier: typeof payload.machineIdentifier === "string" ? payload.machineIdentifier.trim() : "",
    token,
  };
}

const JOB_LABELS: Record<string, { name: string; intervalDescription: (settings: AppSettings) => string; nextRunLabel?: string }> = {
  "session-check": {
    name: "Plex session fallback check",
    intervalDescription: (settings) => `Fallback every ${settings.sessionPollIntervalMinutes} minute${settings.sessionPollIntervalMinutes !== 1 ? "s" : ""}`,
  },
  "history-import": {
    name: "History import",
    intervalDescription: (settings) => `Every ${settings.historyImportIntervalHours} hour${settings.historyImportIntervalHours !== 1 ? "s" : ""}`,
  },
  "full-history-reconcile": {
    name: "Full history reconciliation",
    intervalDescription: () => "Every 30 days",
  },
  "rolling-reconcile": {
    name: "Rolling reconciliation",
    intervalDescription: () => "Every 6 hours",
  },
  "recommendation-refresh": {
    name: "Sonarr library refresh",
    intervalDescription: () => "Every 6 hours",
  },
};

export function createApp(config: RuntimeConfig, scheduler?: JobScheduler) {
  const logger = new Logger(config.dataDir);
  const db = new PacearrDatabase(config, logger);
  const imageCache = new ImageCacheService(config.dataDir, logger);
  const services = new PacearrServices(db, logger, imageCache, config.dataDir);
  const app = express();
  const sessionSecret = db.getSessionSecret();

  if (db.getAppSettings().trustProxy) app.set("trust proxy", 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        // The About page reads the public release feed directly from GitHub.
        "connect-src": ["'self'", "https://plex.tv", "https://api.github.com"],
        "img-src": ["'self'", "data:"],
        "upgrade-insecure-requests": null,
      },
    },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    hsts: false,
  }));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (req) => req.path.startsWith("/images/") || req.path.startsWith("/assets/") || req.path === "/favicon.ico",
  }));
  app.use(express.json({ limit: "2mb" }));

  app.use((req, _res, next) => {
    const raw = parseCookies(req.headers.cookie).get(config.sessionCookieName);
    if (!raw) {
      req.sessionUser = null;
      next();
      return;
    }
    const [sessionId, signature] = raw.split(".");
    if (!sessionId || !signature || signedValue(sessionSecret, sessionId) !== signature) {
      req.sessionUser = null;
      next();
      return;
    }
    req.sessionUser = db.getSession(sessionId);
    next();
  });

  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!req.sessionUser) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    next();
  }

  function setSessionCookie(res: Response, sessionId: string) {
    const signed = `${sessionId}.${signedValue(sessionSecret, sessionId)}`;
    res.setHeader("Set-Cookie", `${config.sessionCookieName}=${encodeURIComponent(signed)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`);
  }

  app.get("/api/bootstrap/status", (req, res) => {
    res.json(db.getBootstrapStatus(Boolean(req.sessionUser)));
  });

  app.get("/api/auth/session", (req, res) => {
    res.json({ authenticated: Boolean(req.sessionUser), user: req.sessionUser ?? null });
  });

  app.post("/api/auth/plex", asyncRoute(async (req, res) => {
    const token = requiredString((req.body as { authToken?: string }).authToken, "authToken");
    const account = await PlexIntegration.fetchAccountByToken(token);
    const existingOwner = db.getPlexOwner();
    if (existingOwner && existingOwner.plexId !== account.plexId) {
      res.status(403).json({ error: "Only the configured Plex owner can sign in." });
      return;
    }
    // Match the sidebar's image policy: session data must point at a local
    // cached image rather than exposing the browser to an external Plex URL.
    const cachedAvatarUrl = await imageCache.ensureAvatarCached(account.plexId, account.avatarUrl);
    db.savePlexOwner({ ...account, avatarUrl: cachedAvatarUrl });
    const sessionId = createSessionId();
    db.createSession(sessionId, account.plexId, new Date(Date.now() + config.sessionTtlMs).toISOString());
    setSessionCookie(res, sessionId);
    logger.info("Plex owner signed in", { plexId: account.plexId, username: account.username });
    res.json({ ok: true, user: { plexId: account.plexId, username: account.username, displayName: account.displayName, email: account.email, avatarUrl: cachedAvatarUrl } });
  }));

  app.post("/api/auth/logout", requireAuth, (req, res) => {
    const raw = parseCookies(req.headers.cookie).get(config.sessionCookieName);
    const sessionId = raw?.split(".")[0];
    if (sessionId) db.deleteSession(sessionId);
    res.setHeader("Set-Cookie", `${config.sessionCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
    logger.info("User signed out", { plexId: req.sessionUser?.plexId ?? null });
  });

  app.post("/api/plex/discover", requireAuth, asyncRoute(async (req, res) => {
    const token = requiredString((req.body as { token?: string }).token ?? db.getPlexOwner()?.plexToken, "token");
    const servers = await PlexIntegration.discoverServers(token);
    logger.info("Plex server discovery completed", { servers: servers.length });
    res.json({ servers });
  }));

  app.get("/api/setup/plex/servers", requireAuth, asyncRoute(async (_req, res) => {
    const token = requiredString(db.getPlexOwner()?.plexToken, "Plex owner token");
    const servers = await PlexIntegration.discoverServers(token);
    const options: PlexConnectionOption[] = [];
    for (const server of servers) {
      for (const connection of server.connections) {
        try {
          const parsed = new URL(connection.uri);
          options.push({
            name: server.name,
            uri: connection.uri,
            machineIdentifier: server.machineIdentifier,
            address: parsed.hostname,
            port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
            protocol: parsed.protocol === "https:" ? "https" : "http",
            local: connection.local,
          });
        } catch {
          logger.warn("Skipping invalid Plex server URI from discovery", { uri: connection.uri });
        }
      }
    }
    res.json(options);
  }));

  app.post("/api/settings/plex/test", requireAuth, asyncRoute(async (req, res) => {
    const owner = db.getPlexOwner();
    if (!owner) throw new Error("Plex owner is not configured.");
    const settings = buildPlexSettingsFromPayload(owner.plexToken, req.body as PlexConfigPayload);
    const result = await new PlexIntegration(settings, logger).testConnection();
    res.status(result.ok ? 200 : 400).json(result.ok ? { ok: true, message: result.message } : result);
  }));

  app.post("/api/settings/plex", requireAuth, asyncRoute(async (req, res) => {
    const owner = db.getPlexOwner();
    if (!owner) throw new Error("Plex owner is not configured.");
    const previousSettings = db.getPlexSettings();
    const settings = buildPlexSettingsFromPayload(owner.plexToken, req.body as PlexConfigPayload);
    const result = await new PlexIntegration(settings, logger).testConnection();
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    if (!settings.machineIdentifier) {
      settings.machineIdentifier = result.message.match(/\(([^)]+)\)/)?.[1] ?? "";
    }
    db.savePlexSettings(settings);
    if (previousSettings?.serverUrl !== settings.serverUrl || previousSettings?.token !== settings.token) services.restartPlexSessionMonitor();
    logger.info("Plex settings saved", { serverUrl: settings.serverUrl, machineIdentifier: settings.machineIdentifier || null });
    await services.discoverPlexUsers();
    res.json({ ok: true, plex: db.getPlexSettingsView(), users: await services.listUsers() });
  }));

  app.post("/api/settings/sonarr/test", requireAuth, asyncRoute(async (req, res) => {
    const existing = db.getSonarrSettings();
    const settings = {
      baseUrl: requiredString(req.body.baseUrl, "baseUrl"),
      apiKey: requiredString(req.body.apiKey || existing?.apiKey, "apiKey"),
    };
    res.json(await new SonarrIntegration(settings, logger).testConnection());
  }));

  app.post("/api/settings/sonarr", requireAuth, asyncRoute(async (req, res) => {
    const existing = db.getSonarrSettings();
    const settings = {
      baseUrl: requiredString(req.body.baseUrl, "baseUrl"),
      apiKey: requiredString(req.body.apiKey || existing?.apiKey, "apiKey"),
    };
    const result = await new SonarrIntegration(settings, logger).testConnection();
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    db.saveSonarrSettings(settings);
    logger.info("Sonarr settings saved", { baseUrl: settings.baseUrl });
    scheduler?.runNow("recommendation-refresh");
    res.json({ ok: true, sonarr: db.getSonarrSettingsView() });
  }));

  app.post("/api/settings/tautulli/test", requireAuth, asyncRoute(async (req, res) => {
    const existing = db.getTautulliSettings();
    const settings = {
      enabled: true,
      baseUrl: requiredString(req.body.baseUrl, "baseUrl"),
      apiKey: requiredString(req.body.apiKey || existing.apiKey, "apiKey"),
    };
    res.json(await new TautulliIntegration(settings, logger).testConnection());
  }));

  app.post("/api/settings/tautulli", requireAuth, (req, res) => {
    const body = req.body as { enabled?: boolean; baseUrl?: string; apiKey?: string };
    const existing = db.getTautulliSettings();
    const tautulliSettings = {
      enabled: Boolean(body.enabled),
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : "",
      apiKey: typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : existing.apiKey,
    };
    db.saveTautulliSettings(tautulliSettings);
    logger.info("Tautulli settings saved", { enabled: tautulliSettings.enabled, configured: Boolean(tautulliSettings.baseUrl && tautulliSettings.apiKey) });
    res.json({ ok: true, tautulli: db.getTautulliSettingsView() });
  });

  app.patch("/api/settings/app", requireAuth, (req, res) => {
    const body = req.body as Partial<AppSettings>;
    const patch: Partial<AppSettings> = {};
    if (body.dryRun !== undefined) patch.dryRun = Boolean(body.dryRun);
    if (body.artworkEnabled !== undefined) patch.artworkEnabled = Boolean(body.artworkEnabled);
    if (body.viewerActivityWindowDays !== undefined) patch.viewerActivityWindowDays = Math.max(1, Math.floor(Number(body.viewerActivityWindowDays) || 30));
    if (body.historyRetentionDays !== undefined) {
      const retentionDays = Number(body.historyRetentionDays);
      patch.historyRetentionDays = Math.min(MAX_SAFE_RETENTION_DAYS, Math.max(1, Math.floor(Number.isFinite(retentionDays) ? retentionDays : DEFAULT_APP_SETTINGS.historyRetentionDays)));
    }
    if (body.sessionPollIntervalMinutes !== undefined) {
      patch.sessionPollIntervalMinutes = normaliseScheduleIntervalMinutes(body.sessionPollIntervalMinutes, DEFAULT_APP_SETTINGS.sessionPollIntervalMinutes);
    }
    if (body.historyImportIntervalHours !== undefined) {
      patch.historyImportIntervalHours = normaliseScheduleIntervalHours(body.historyImportIntervalHours, DEFAULT_APP_SETTINGS.historyImportIntervalHours);
    }
    if (body.progressiveCleanupEnabled !== undefined) patch.progressiveCleanupEnabled = Boolean(body.progressiveCleanupEnabled);
    if (body.progressiveCleanupDelayDays !== undefined) {
      const delayDays = Number(body.progressiveCleanupDelayDays);
      patch.progressiveCleanupDelayDays = Math.max(0, Math.floor(Number.isFinite(delayDays) ? delayDays : DEFAULT_APP_SETTINGS.progressiveCleanupDelayDays));
    }
    if (body.recommendationMinimumSavingsGb !== undefined) {
      patch.recommendationMinimumSavingsGb = Math.max(0, Number(body.recommendationMinimumSavingsGb) || 0);
    }
    if (body.trustProxy !== undefined) patch.trustProxy = Boolean(body.trustProxy);
    if (body.onboardingComplete !== undefined) patch.onboardingComplete = Boolean(body.onboardingComplete);
    if (body.earlyPrefetchEnabled !== undefined) {
      if (typeof body.earlyPrefetchEnabled !== "boolean") {
        res.status(400).json({ error: "earlyPrefetchEnabled must be a boolean." });
        return;
      }
      patch.earlyPrefetchEnabled = body.earlyPrefetchEnabled;
    }
    if (body.earlyPrefetchTriggerEpisodesRemaining !== undefined) {
      const trigger = Number(body.earlyPrefetchTriggerEpisodesRemaining);
      patch.earlyPrefetchTriggerEpisodesRemaining = Math.max(1, Math.floor(Number.isFinite(trigger) ? trigger : DEFAULT_APP_SETTINGS.earlyPrefetchTriggerEpisodesRemaining));
    }
    if (body.earlyPrefetchEpisodeCount !== undefined) {
      const count = Number(body.earlyPrefetchEpisodeCount);
      patch.earlyPrefetchEpisodeCount = Math.max(1, Math.floor(Number.isFinite(count) ? count : DEFAULT_APP_SETTINGS.earlyPrefetchEpisodeCount));
    }
    const previousSettings = db.getAppSettings();
    const appSettings = db.updateAppSettings(patch);
    logger.info("Application settings updated", { changed: Object.keys(patch), dryRun: appSettings.dryRun });
    scheduler?.updateJob("session-check", { intervalMs: appSettings.sessionPollIntervalMinutes * 60 * 1000 });
    scheduler?.updateJob("history-import", { intervalMs: appSettings.historyImportIntervalHours * 60 * 60 * 1000 });
    if (previousSettings.dryRun && !appSettings.dryRun) {
      logger.info("Dry run disabled; scheduling immediate rolling monitoring reconciliation");
      scheduler?.runNow("rolling-reconcile");
    }
    res.json({ app: appSettings });
  });

  app.get("/api/settings", requireAuth, (req, res) => {
    const plex = db.getPlexSettingsView();
    const parsedPlex = plex ? parseServerUrl(plex.serverUrl) : {};
    res.json({
      app: db.getAppSettings(),
      plex: plex ? { ...plex, ...parsedPlex } : null,
      sonarr: db.getSonarrSettingsView(),
      tautulli: db.getTautulliSettingsView(),
      jobs: scheduler?.listJobs() ?? [],
    });
  });

  app.use("/api/settings/logs", rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }));
  app.get("/api/settings/logs", requireAuth, (req, res) => {
    const rawPage = Number(req.query.page ?? 1);
    const rawPageSize = Number(req.query.pageSize ?? 25);
    const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
    const pageSize = Math.min(100, Math.max(1, Number.isFinite(rawPageSize) ? rawPageSize : 25));
    const levels = ["debug", "info", "warn", "error"] as const;
    const filter = levels.includes(req.query.filter as typeof levels[number]) ? req.query.filter as typeof levels[number] : "debug";
    const allowed = new Set(levels.slice(levels.indexOf(filter)));
    const search = typeof req.query.search === "string" ? req.query.search.toLowerCase().slice(0, 200) : "";
    const entries = readRecentLogEntries(logger);
    const filtered = entries
      .filter((entry) => allowed.has(entry.level))
      .filter((entry) => !search || entry.message.toLowerCase().includes(search) || JSON.stringify(entry.meta ?? "").toLowerCase().includes(search))
      .reverse();
    const start = (page - 1) * pageSize;
    res.json({
      results: filtered.slice(start, start + pageSize),
      pageInfo: {
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(filtered.length / pageSize)),
        total: filtered.length,
      },
    });
  });

  app.get("/api/settings/jobs", requireAuth, (_req, res) => {
    const settings = db.getAppSettings();
    const jobs: JobInfo[] = (scheduler?.listJobs() ?? []).map((job) => {
      const label = JOB_LABELS[job.id];
      const sessionMonitorStatus = job.id === "session-check" ? services.getPlexSessionMonitorStatus() : null;
      return {
        ...job,
        name: label?.name ?? job.id,
        intervalDescription: label?.intervalDescription(settings) ?? "Manual",
        nextRunLabel: label?.nextRunLabel,
        isRunning: job.running,
        ...(sessionMonitorStatus ? {
          statusMode: sessionMonitorStatus.mode,
          statusDescription: sessionMonitorStatus.description,
        } : {}),
      };
    });
    res.json(jobs);
  });

  app.post("/api/settings/jobs/:id/run", requireAuth, (req, res) => {
    res.json({ triggered: scheduler?.runNow(String(req.params.id)) ?? false });
  });

  app.patch("/api/settings/jobs/:id", requireAuth, (req, res) => {
    const intervalMinutes = parseScheduleIntervalMinutes((req.body as { intervalMinutes?: number }).intervalMinutes);
    if (intervalMinutes === null) {
      res.status(400).json({ error: "intervalMinutes is required." });
      return;
    }
    if (req.params.id === "session-check") {
      const appSettings = db.updateAppSettings({ sessionPollIntervalMinutes: intervalMinutes });
      scheduler?.updateJob("session-check", { intervalMs: appSettings.sessionPollIntervalMinutes * 60 * 1000 });
      res.json({ updated: true });
      return;
    }
    if (req.params.id === "history-import") {
      const hours = Math.max(1, Math.floor(intervalMinutes / 60));
      const appSettings = db.updateAppSettings({ historyImportIntervalHours: hours });
      scheduler?.updateJob("history-import", { intervalMs: appSettings.historyImportIntervalHours * 60 * 60 * 1000 });
      res.json({ updated: true });
      return;
    }
    res.status(400).json({ error: "This job schedule cannot be edited." });
  });

  app.get("/api/dashboard", requireAuth, asyncRoute(async (_req, res) => {
    res.json(await services.buildDashboard(scheduler?.listJobs() ?? []));
  }));

  app.get("/api/users", requireAuth, asyncRoute(async (_req, res) => {
    res.json({ users: await services.listUsers() });
  }));
  app.post("/api/users/discover", requireAuth, asyncRoute(async (_req, res) => {
    const discovered = await services.discoverPlexUsers();
    logger.info("Plex user discovery requested", { users: discovered.length });
    // discoverPlexUsers returns the raw UserRecord shape; the client needs the
    // UserListItem shape (activeShowCount, lastWatchedAt) it renders. Re-fetch through
    // listUsers rather than adding those fields to discovery's own return, so there is
    // one place that computes per-user activity.
    res.json({ users: await services.listUsers() });
  }));
  app.get("/api/users/:id/shows", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id must be a positive integer." });
      return;
    }
    res.json({ shows: services.listShowsDrivenByUser(id) });
  });
  app.patch("/api/users/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id must be a positive integer." });
      return;
    }
    // Coercing an absent field with Boolean(undefined) would send `enabled: false` to
    // updateUser on every call, including a body that never mentioned it — silently
    // disabling the user instead of leaving them as they were. Only pass `enabled`
    // through when the request actually included it, so updateUser's own
    // patch.enabled ?? current.enabled can do its job. And Boolean(value) on a value
    // that IS present would accept any truthy non-boolean ("no", {}, ...) as true, so a
    // present field must be an actual boolean rather than merely coerced.
    const body = req.body as { enabled?: unknown };
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean." });
      return;
    }
    if (!db.getUser(id)) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    const patch: Partial<Pick<UserRecord, "enabled">> = body.enabled !== undefined ? { enabled: body.enabled } : {};
    const user = db.updateUser(id, patch);
    logger.info("User settings updated", { userId: user.id, enabled: user.enabled });
    res.json({ user });
  });

  app.get("/api/shows", requireAuth, asyncRoute(async (req, res) => {
    const refreshing = scheduler?.listJobs().some((job) => job.id === "recommendation-refresh" && job.running) ?? false;
    if (!db.getSonarrLibraryCache() && !refreshing) scheduler?.runNow("recommendation-refresh");
    res.json({
      shows: services.listShows({
        enrolledOnly: req.query.enrolled === "true",
        query: typeof req.query.query === "string" ? req.query.query : undefined,
      }),
      generatedAt: db.getSonarrLibraryCache()?.generatedAt ?? null,
      refreshing: refreshing || !db.getSonarrLibraryCache(),
    });
  }));
  app.post("/api/shows/refresh", requireAuth, (_req, res) => {
    const alreadyRunning = scheduler?.listJobs().some((job) => job.id === "recommendation-refresh" && job.running) ?? false;
    res.json({ triggered: alreadyRunning ? false : scheduler?.runNow("recommendation-refresh") ?? false });
  });
  app.get("/api/shows/:seriesId", requireAuth, asyncRoute(async (req, res) => {
    res.json(await services.getShowDetail(Number(req.params.seriesId)));
  }));
  app.post("/api/shows/:seriesId/enroll", requireAuth, asyncRoute(async (req, res) => {
    const options = {
      applyBaseline: req.body.applyBaseline !== false,
      importHistory: req.body.importHistory !== false,
    };
    const enrollment = await services.beginEnrollment(Number(req.params.seriesId), options);
    res.json({ ok: true, message: `Enrolled ${enrollment.rolling.title}. Setup continues in the background.`, rollingShowId: enrollment.rolling.id });
    void services.completeEnrollment(enrollment.series, enrollment.rolling, enrollment.operation, options).catch((error) => {
      logger.error("Enrollment setup failed after show was enrolled", {
        seriesId: enrollment.series.id,
        rollingShowId: enrollment.rolling.id,
        title: enrollment.rolling.title,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }));
  app.get("/api/recommendations", requireAuth, asyncRoute(async (req, res) => {
    const refreshing = scheduler?.listJobs().some((job) => job.id === "recommendation-refresh" && job.running) ?? false;
    if (!db.getRecommendationCache() && !refreshing) scheduler?.runNow("recommendation-refresh");
    res.json(services.listRecommendations(req.query.includeIgnored === "true", refreshing || !db.getRecommendationCache()));
  }));
  app.post("/api/recommendations/refresh", requireAuth, (_req, res) => {
    const alreadyRunning = scheduler?.listJobs().some((job) => job.id === "recommendation-refresh" && job.running) ?? false;
    res.json({ triggered: alreadyRunning ? false : scheduler?.runNow("recommendation-refresh") ?? false });
  });
  app.post("/api/recommendations/:seriesId/ignore", requireAuth, (req, res) => {
    const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title) return res.status(400).json({ error: "A show title is required." });
    services.ignoreRecommendation(Number(req.params.seriesId), title);
    res.json({ ok: true });
  });
  app.delete("/api/recommendations/:seriesId/ignore", requireAuth, (req, res) => {
    services.unignoreRecommendation(Number(req.params.seriesId));
    res.json({ ok: true });
  });
  app.post("/api/rolling-shows/:id/reset", requireAuth, asyncRoute(async (req, res) => {
    res.json(await services.resetShow(Number(req.params.id)));
  }));
  app.delete("/api/rolling-shows/:id", requireAuth, asyncRoute(async (req, res) => {
    const result = await services.removeShow(Number(req.params.id));
    if (result.ok) scheduler?.runNow("recommendation-refresh");
    res.json(result);
  }));

  // Manual job triggers live at /api/settings/jobs/:id/run, which is what Settings → Jobs
  // calls. The parallel /api/jobs/* endpoints that used to back the Dashboard's quick
  // actions are gone with those buttons — they had no remaining callers, and two routes
  // for one action is how they drift apart.

  app.get("/api/history", requireAuth, (req, res) => {
    const requestedPage = Math.floor(Number(req.query.page));
    const requestedPageSize = Math.floor(Number(req.query.pageSize));
    const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
    const pageSize = Number.isFinite(requestedPageSize) ? Math.min(100, Math.max(1, requestedPageSize)) : 10;
    const requestedLevel = String(req.query.level ?? "all");
    // No code path writes an error-level history event — every addHistory call uses info
    // or warn — so "error" is deliberately not an accepted level here either.
    const level = requestedLevel === "info" || requestedLevel === "warn" ? requestedLevel : undefined;
    const category = isHistoryCategory(req.query.category) ? req.query.category : undefined;
    const { results, total } = db.listHistoryPaginated({ page, pageSize, level, category });

    res.json({
      results,
      pageInfo: {
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(total / pageSize)),
        total,
      },
    });
  });
  app.get("/api/settings/about", requireAuth, (_req, res) => res.json({
    version: APP_VERSION,
    buildChannel: BUILD_CHANNEL,
    commitSha: BUILD_COMMIT,
    nodeVersion: process.version,
    platform: process.platform,
    dataDir: config.dataDir,
    tz: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  const clientDir = path.resolve(process.cwd(), "dist/client");
  app.use("/images", express.static(imageCache.publicDir, { maxAge: "30d", immutable: true }));
  app.use("/images", (_req, res) => res.sendStatus(404));
  // Vite content-hashes every filename under /assets, so a build's output never collides
  // with a previous one — safe to cache for as long as a browser will keep it. Everything
  // else in dist/client (notably index.html, which names the current asset hashes and must
  // always revalidate) keeps the conservative default below.
  app.use("/assets", express.static(path.join(clientDir, "assets"), { maxAge: "1y", immutable: true }));
  app.use(express.static(clientDir, { maxAge: "1h" }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(clientDir, "index.html")));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const id = crypto.randomUUID();
    logger.error("Request failed", { id, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    res.status(500).json({ error: error instanceof Error ? error.message : String(error), id });
  });

  return { app, db, logger, services };
}
