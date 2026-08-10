import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { JobScheduler } from "../../src/server/job-scheduler.js";
import { PlexSessionMonitor } from "../../src/server/plex-session-monitor.js";
import type { Logger } from "../../src/server/logger.js";

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test SSE server did not expose a port.");
  return address.port;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for SSE event.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Plex SSE playback notifications trigger a session check without Plex", async () => {
  const streams: import("node:http").ServerResponse[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.url, "/:/eventsource/notifications");
    assert.equal(req.headers["x-plex-token"], "test-token");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    streams.push(res);
  });
  const port = await listen(server);
  let triggers = 0;
  const monitor = new PlexSessionMonitor(
    () => ({ serverUrl: `http://127.0.0.1:${port}`, machineIdentifier: "plex", token: "test-token" }),
    silentLogger(),
    () => { triggers++; },
  );
  try {
    monitor.start();
    await waitFor(() => monitor.getStatus().mode === "live");
    streams[0]?.write(`event: playing\ndata: ${JSON.stringify({ PlaySessionStateNotification: { state: "playing" } })}\n\n`);
    await waitFor(() => triggers === 1);
    streams[0]?.write(`data: ${JSON.stringify({ NotificationContainer: { PlaySessionStateNotification: [{ state: "playing" }] } })}\n\n`);
    await waitFor(() => triggers === 2);
    streams[0]?.write("event: playing\ndata: null\n\n");
    streams[0]?.write(`event: playing\ndata: ${JSON.stringify({ PlaySessionStateNotification: [null] })}\n\n`);
    streams[0]?.write(`event: playing\ndata: ${JSON.stringify({ PlaySessionStateNotification: { state: "playing" } })}\n\n`);
    await waitFor(() => triggers === 3);
    assert.equal(monitor.getStatus().mode, "live");
  } finally {
    monitor.stop();
    streams[0]?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Plex SSE connection failures leave polling fallback active", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("Plex is unavailable");
  });
  const port = await listen(server);
  const monitor = new PlexSessionMonitor(
    () => ({ serverUrl: `http://127.0.0.1:${port}`, machineIdentifier: "plex", token: "test-token" }),
    silentLogger(),
    () => assert.fail("A failed SSE connection must not trigger a session check."),
    { initialReconnectMs: 10 },
  );
  try {
    monitor.start();
    await waitFor(() => requests >= 2);
    await waitFor(() => monitor.getStatus().mode === "polling-fallback");
    assert.match(monitor.getStatus().description, /polling fallback/i);
  } finally {
    monitor.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("an idle live Plex SSE connection falls back to polling", async () => {
  const streams: import("node:http").ServerResponse[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    streams.push(res);
  });
  const port = await listen(server);
  const monitor = new PlexSessionMonitor(
    () => ({ serverUrl: `http://127.0.0.1:${port}`, machineIdentifier: "plex", token: "test-token" }),
    silentLogger(),
    () => assert.fail("An idle stream must not trigger a session check."),
    { heartbeatTimeoutMs: 20, initialReconnectMs: 100 },
  );
  try {
    monitor.start();
    await waitFor(() => monitor.getStatus().mode === "live");
    await waitFor(() => monitor.getStatus().mode === "polling-fallback");
  } finally {
    monitor.stop();
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a monitor started before Plex configuration reconnects after it becomes available", async () => {
  const streams: import("node:http").ServerResponse[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    streams.push(res);
  });
  const port = await listen(server);
  let configured = false;
  const monitor = new PlexSessionMonitor(
    () => configured ? { serverUrl: `http://127.0.0.1:${port}`, machineIdentifier: "plex", token: "test-token" } : null,
    silentLogger(),
    () => assert.fail("Connecting does not itself trigger a session check."),
    { initialReconnectMs: 10 },
  );
  try {
    monitor.start();
    assert.equal(monitor.getStatus().mode, "unavailable");
    configured = true;
    await waitFor(() => monitor.getStatus().mode === "live");
  } finally {
    monitor.stop();
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("scheduler coalesces a trigger while the same job is running", async () => {
  const scheduler = new JobScheduler();
  let runs = 0;
  let releaseFirstRun!: () => void;
  const firstRun = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
  scheduler.registerRecurringJob({
    id: "session-check",
    intervalMs: 60_000,
    task: async () => { runs++; await firstRun; },
  });
  const running = scheduler.runNowAndWait("session-check");
  await waitFor(() => runs === 1);
  assert.equal(scheduler.runNow("session-check"), false);
  assert.equal(await scheduler.runNowAndWait("session-check"), false);
  assert.equal(runs, 1);
  releaseFirstRun();
  assert.equal(await running, true);
  scheduler.updateJob("session-check", { enabled: false });
});

test("scheduler identifies whether a job run is scheduled", async () => {
  const scheduler = new JobScheduler();
  let scheduled: boolean | null = null;
  scheduler.registerRecurringJob({
    id: "session-check",
    intervalMs: 60_000,
    task: async (context) => { scheduled = context.scheduled; },
  });
  assert.equal(await scheduler.runNowAndWait("session-check"), true);
  assert.equal(scheduled, false);
  scheduler.updateJob("session-check", { enabled: false });
});

test("a scheduled collision keeps the next recurring run armed", async () => {
  const scheduler = new JobScheduler();
  const contexts: boolean[] = [];
  let releaseFirstRun!: () => void;
  const firstRun = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
  scheduler.registerRecurringJob({
    id: "session-check",
    intervalMs: 15,
    task: async ({ scheduled }) => {
      contexts.push(scheduled);
      if (contexts.length === 1) await firstRun;
    },
  });
  const manual = scheduler.runNowAndWait("session-check");
  await waitFor(() => contexts.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 35));
  releaseFirstRun();
  await manual;
  await waitFor(() => contexts.length === 2);
  assert.deepEqual(contexts, [false, true]);
  scheduler.updateJob("session-check", { enabled: false });
});
