import assert from "node:assert/strict";
import test from "node:test";
import { SonarrIntegration } from "../../src/server/integrations/sonarr.js";
import type { Logger } from "../../src/server/logger.js";

test("dry-run Sonarr integration never sends mutation requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  const warnings: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const logger = { warn: (_message: string, meta: unknown) => { warnings.push(meta); } } as unknown as Logger;
  const sonarr = new SonarrIntegration({ baseUrl: "http://sonarr:8989", apiKey: "secret" }, logger, true);

  try {
    await sonarr.updateSeriesMonitoring(1, { monitored: true, monitorNewItems: "none" });
    await sonarr.updateSeasonMonitoring(1, 2, false);
    await sonarr.updateEpisodesMonitoring([{ id: 10, monitored: false }]);
    await sonarr.searchEpisodes([10]);
    await sonarr.searchSeason(1, 2);
    await sonarr.deleteEpisodeFiles([99]);

    assert.deepEqual(requests, []);
    assert.equal(warnings.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
