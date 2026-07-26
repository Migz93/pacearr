import assert from "node:assert/strict";
import test from "node:test";
import { calculateRollingPlan } from "../../src/server/services.js";
import type { SonarrEpisode, SonarrSeries } from "../../src/shared/types.js";

const series = {
  id: 6007,
  title: "New Amsterdam (2018)",
  monitored: true,
  monitorNewItems: "none",
  seasons: [1, 2, 3, 4, 5].map((seasonNumber) => ({ seasonNumber, monitored: true })),
} as SonarrSeries;

const episodes = [1, 2, 3, 4, 5].flatMap((seasonNumber) =>
  [1, 2, 3].map((episodeNumber) => ({
    id: seasonNumber * 100 + episodeNumber,
    seasonNumber,
    episodeNumber,
    monitored: true,
    hasFile: episodeNumber > 1,
    episodeFileId: seasonNumber * 1000 + episodeNumber,
  } as SonarrEpisode))
);

test("rolling plan retains active viewer seasons and resets only other seasons to pilots", () => {
  const plan = calculateRollingPlan(series, episodes, [3, 2], true);

  assert.deepEqual(plan.retainedSeasons, [2, 3]);
  assert.deepEqual(plan.seasonMonitoringToEnable, []);
  assert.deepEqual(plan.seasonMonitoringToDisable.map((season) => season.seasonNumber), [1, 4, 5]);
  assert.deepEqual(plan.episodesToMonitor, []);
  assert.deepEqual(
    plan.episodesToUnmonitor.map((episode) => [episode.seasonNumber, episode.episodeNumber]),
    [[1, 2], [1, 3], [4, 2], [4, 3], [5, 2], [5, 3]]
  );
  assert.deepEqual(plan.pilotSearches.map((episode) => episode.seasonNumber), [1, 4, 5]);
  assert.deepEqual(plan.seasonSearches, [2, 3]);
  assert.equal(plan.filesToDelete.length, 6);
  assert.equal(plan.filesToDelete.some((id) => id >= 2000 && id < 4000), false);
});
