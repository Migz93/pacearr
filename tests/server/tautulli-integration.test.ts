import assert from "node:assert/strict";
import test from "node:test";
import { TautulliIntegration } from "../../src/server/integrations/tautulli.js";
import type { Logger } from "../../src/server/logger.js";

test("getHistory maps Tautulli's username and user fields independently, not collapsed into one", async () => {
  const originalFetch = globalThis.fetch;
  // Regression for #75: Tautulli's `user` (admin-editable friendly name) and `username`
  // (real Plex username) used to be collapsed into a single field with `??`, discarding
  // whichever one lost. This asserts getHistory keeps both distinct all the way out.
  globalThis.fetch = (async () => new Response(JSON.stringify({
    response: {
      result: "success",
      data: {
        data: [{
          reference_id: "ref-1",
          user_id: 42,
          username: "dave_plex",
          user: "Big Chief Dave",
          grandparent_title: "The Expanse",
          parent_media_index: 2,
          media_index: 5,
          date: 1700000000,
          rating_key: "999",
          grandparent_rating_key: "111",
        }, {
          reference_id: "ref-2",
          user_id: 43,
          user: "Managed viewer",
          grandparent_title: "The Expanse",
          parent_media_index: 2,
          media_index: 6,
          date: 1700000001,
          rating_key: "1000",
          grandparent_rating_key: "111",
        }],
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const tautulli = new TautulliIntegration({ enabled: true, baseUrl: "http://tautulli:8181", apiKey: "secret" }, logger);
    const history = await tautulli.getHistory();
    assert.equal(history.length, 2);
    const record = history[0]!;
    assert.equal(record.username, "dave_plex");
    assert.equal(record.friendlyName, "Big Chief Dave");
    assert.equal(history[1]!.username, null);
    assert.equal(history[1]!.friendlyName, "Managed viewer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
