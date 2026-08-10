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

// Regression test: PATCH /api/users/:id used to wrap the request body's `enabled` field
// in Boolean(...) unconditionally, which turns a genuinely absent field into `false` —
// so a body that never mentioned `enabled` (an empty {}, or a stale caller that only sent
// a since-removed field) silently disabled the user instead of leaving them untouched.
// Restores the user's original state in a finally block regardless of outcome, since this
// runs against a live instance's real data.
test("PATCH-ing a user with no enabled field in the body leaves their enabled state unchanged", async ({ page }) => {
  await openPage(page, "/users", "Users");

  const listed = await page.request.get("/api/users");
  const { users } = (await listed.json()) as { users: Array<{ id: number; enabled: boolean }> };
  expect(users.length).toBeGreaterThan(0);
  const user = users[0]!;

  try {
    const patched = await page.request.patch(`/api/users/${user.id}`, { data: {} });
    expect(patched.ok()).toBeTruthy();
    const { user: after } = (await patched.json()) as { user: { enabled: boolean } };
    expect(after.enabled).toBe(user.enabled);
  } finally {
    await page.request.patch(`/api/users/${user.id}`, { data: { enabled: user.enabled } });
  }
});

// Regression test: the fix for the above (only include `enabled` when the body has it)
// used Boolean(body.enabled) to coerce whatever was present, so a truthy non-boolean —
// a string, an object — silently enabled the user rather than being rejected. The route
// now requires an actual boolean when the field is present at all.
test("PATCH-ing a user with a non-boolean enabled value is rejected, not coerced", async ({ page }) => {
  await openPage(page, "/users", "Users");

  const listed = await page.request.get("/api/users");
  const { users } = (await listed.json()) as { users: Array<{ id: number; enabled: boolean }> };
  expect(users.length).toBeGreaterThan(0);
  const user = users[0]!;

  const patched = await page.request.patch(`/api/users/${user.id}`, { data: { enabled: "not-a-boolean" } });
  expect(patched.status()).toBe(400);

  const after = await page.request.get("/api/users");
  const { users: usersAfter } = (await after.json()) as { users: Array<{ id: number; enabled: boolean }> };
  expect(usersAfter.find((u) => u.id === user.id)?.enabled).toBe(user.enabled);
});
