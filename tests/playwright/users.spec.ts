import { expect, test } from "@playwright/test";
import { openPage } from "./support";

// Regression test: POST /api/users/discover used to return the raw discovery shape
// (UserRecord), missing activeShowCount and lastWatchedAt. The Users page reads both
// straight off the discover response without a reload, so a viewer who was keeping a
// show expanded would drop out of the Active section and read "No active shows" until
// the next full page load. Checked at the API level rather than by clicking Refresh in
// the UI, since the shape is what broke, not any rendering.
test("discovering users returns the same per-user activity fields as the users list", async ({ page }) => {
  await openPage(page, "/users", "Users");

  const discovered = await page.request.post("/api/users/discover");
  expect(discovered.ok()).toBeTruthy();
  const { users } = (await discovered.json()) as { users: unknown[] };
  expect(users.length).toBeGreaterThan(0);
  for (const user of users) {
    expect(user).toHaveProperty("activeShowCount");
    expect(user).toHaveProperty("lastWatchedAt");
    expect(typeof (user as { activeShowCount: unknown }).activeShowCount).toBe("number");
  }
});
