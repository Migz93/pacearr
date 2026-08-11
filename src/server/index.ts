import { createApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { JobScheduler } from "./job-scheduler.js";

const config = loadRuntimeConfig();
const scheduler = new JobScheduler();
const { app, db, logger, services } = createApp(config, scheduler);

scheduler.setLogger(logger);
scheduler.setPersistence({
  load: (id) => db.getJobRunState(id),
  save: (id, state) => db.saveJobRunState(id, state),
});

function isReady() {
  const status = db.getBootstrapStatus(false);
  return status.configurationValid;
}

function requiresSetup(task: (context: { scheduled: boolean }) => Promise<void>) {
  return async (context: { scheduled: boolean }) => {
    if (!isReady()) {
      logger.debug("Skipping scheduled task; setup is incomplete");
      return;
    }
    await task(context);
  };
}

const settings = db.getAppSettings();
scheduler.registerRecurringJob({
  id: "session-check",
  intervalMs: settings.sessionPollIntervalMinutes * 60 * 1000,
  task: requiresSetup(async ({ scheduled }) => {
    if (scheduled && services.isPlexSessionMonitorLive()) {
      logger.debug("Skipping polling session check while live Plex playback is connected");
      return;
    }
    await services.checkSessions();
  }),
});
services.startPlexSessionMonitor(() => { scheduler.runNow("session-check"); });
scheduler.registerRecurringJob({
  id: "history-import",
  intervalMs: settings.historyImportIntervalHours * 60 * 60 * 1000,
  task: requiresSetup(() => services.importHistory().then(() => undefined)),
});
scheduler.registerRecurringJob({
  id: "full-history-reconcile",
  // A full source read is intentionally infrequent; normal imports remain incremental.
  intervalMs: settings.fullHistoryReconcileIntervalDays * 24 * 60 * 60 * 1000,
  task: requiresSetup(() => services.reconcileFullHistory().then(() => undefined)),
});
scheduler.registerRecurringJob({
  id: "rolling-reconcile",
  intervalMs: settings.rollingReconcileIntervalHours * 60 * 60 * 1000,
  task: requiresSetup(() => services.reconcileRollingShows().then(() => undefined)),
});
scheduler.registerRecurringJob({
  id: "sonarr-library-refresh",
  intervalMs: settings.sonarrLibraryRefreshIntervalHours * 60 * 60 * 1000,
  task: requiresSetup(async ({ scheduled }) => {
    await services.refreshSonarrLibrary();
    // An administrator-triggered library refresh is also an explicit request for fresh
    // recommendations. Recurring runs stay independent so each configured interval wins.
    if (!scheduled) scheduler.runNow("recommendation-refresh");
  }),
});
// Recommendation calculation only reads the library cache; sonarr-library-refresh owns
// the whole-library Sonarr request, and each recurring cadence remains independent.
scheduler.registerRecurringJob({
  id: "recommendation-refresh",
  intervalMs: settings.recommendationRefreshIntervalHours * 60 * 60 * 1000,
  task: requiresSetup(() => services.refreshRecommendations()),
});
if (isReady() && (!db.getSonarrLibraryCache() || !db.getRecommendationCache())) {
  logger.info("Sonarr library or recommendation cache is empty; scheduling initial refresh");
  scheduler.runNow(db.getSonarrLibraryCache() ? "recommendation-refresh" : "sonarr-library-refresh");
}
if (isReady() && !settings.dryRun) {
  logger.info("Live mode detected at startup; scheduling rolling monitoring reconciliation");
  scheduler.runNow("rolling-reconcile");
}

app.listen(config.port, () => {
  logger.info("Pacearr listening", { url: `http://0.0.0.0:${config.port}`, port: config.port });
});
