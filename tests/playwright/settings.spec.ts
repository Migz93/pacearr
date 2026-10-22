import { expect, test } from "@playwright/test";
import { openPage } from "./support";

test("all settings tabs are visible", async ({ page }) => {
  await openPage(page, "/settings", "Settings");
  for (const tab of ["General", "Plex", "Sonarr", "Tautulli", "Logs", "Jobs", "About"]) {
    await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
  }
});

test("clicking settings tabs updates the URL", async ({ page }) => {
  await page.goto("/settings");
  for (const tab of ["Plex", "Sonarr", "Tautulli", "Logs", "Jobs", "About"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/settings\\?tab=${tab.toLowerCase()}$`));
  }
});

test("opening a one-hour job schedule preserves its 60-minute preset", async ({ page }) => {
  const settings = await page.request.get("/api/settings");
  await expect(settings).toBeOK();
  const { app } = (await settings.json()) as { app: { historyImportIntervalHours: number } };

  try {
    const updated = await page.request.patch("/api/settings/app", { data: { historyImportIntervalHours: 1 } });
    await expect(updated).toBeOK();

    await openPage(page, "/settings?tab=jobs", "Settings");
    const historyImport = page.getByText("History import", { exact: true }).locator("xpath=../..");
    await historyImport.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("combobox", { name: "New frequency" })).toHaveValue("60");
  } finally {
    const restored = await page.request.patch("/api/settings/app", { data: { historyImportIntervalHours: app.historyImportIntervalHours } });
    await expect.soft(restored).toBeOK();
  }
});

// Read-only against the live instance: every change is discarded, never saved.
test("dependent settings stay visible but follow their parent toggle", async ({ page }) => {
  await openPage(page, "/settings", "Settings");
  const parent = page.getByRole("checkbox", { name: "Early season prefetch", exact: true });
  const trigger = page.getByRole("spinbutton", { name: "Episodes remaining trigger" });
  const wasOn = await parent.isChecked();

  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled({ enabled: wasOn });

  await parent.click({ force: true });
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled({ enabled: !wasOn });
  await expect(page.getByText("You have unsaved changes")).toBeVisible();

  await page.getByRole("button", { name: "Discard" }).click();
  await expect(parent).toBeChecked({ checked: wasOn });
  await expect(page.getByText("You have unsaved changes")).toBeHidden();
});

test("the save bar only appears once something changes", async ({ page }) => {
  await openPage(page, "/settings", "Settings");
  const saveButton = page.getByRole("button", { name: "Save changes" });
  await expect(saveButton).toBeHidden();

  const activityWindow = page.getByRole("spinbutton", { name: "Viewer activity window" });
  const original = await activityWindow.inputValue();
  await activityWindow.fill(String(Number(original) + 1));
  await expect(saveButton).toBeVisible();

  await activityWindow.fill(original);
  await expect(saveButton).toBeHidden();
});

// An empty field fails client-side validation, so nothing is sent to the server.
test("a save error can be dismissed once the form is back at its saved values", async ({ page }) => {
  await openPage(page, "/settings", "Settings");
  const activityWindow = page.getByRole("spinbutton", { name: "Viewer activity window" });
  const original = await activityWindow.inputValue();

  await activityWindow.fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Viewer activity window must be a positive whole number of days.")).toBeVisible();

  await activityWindow.fill(original);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Viewer activity window must be a positive whole number of days.")).toBeHidden();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
});

// The save is intercepted and failed in the browser, so it never reaches the server.
test("a settings tab and tab switching are locked while its save is in flight", async ({ page }) => {
  let releaseSave = () => {};
  const saveHeld = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route("**/api/settings/app", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await saveHeld;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated save failure" }) });
  });

  await openPage(page, "/settings", "Settings");
  const activityWindow = page.getByRole("spinbutton", { name: "Viewer activity window" });
  const original = await activityWindow.inputValue();
  await activityWindow.fill(String(Number(original) + 1));
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(activityWindow).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Dry run", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Plex", exact: true })).toBeDisabled();
  releaseSave();

  await expect(page.getByText("Simulated save failure")).toBeVisible();
  await expect(activityWindow).toBeEnabled();
  await expect(page.getByRole("button", { name: "Plex", exact: true })).toBeEnabled();
  await activityWindow.fill(original);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Simulated save failure")).toBeHidden();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
});

// Both requests are intercepted in the browser, so nothing reaches the server.
test("a Plex save sends the artwork setting before the connection", async ({ page }) => {
  const order: string[] = [];
  await page.route("**/api/settings/app", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    order.push("artwork");
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/settings/plex", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    order.push("connection");
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Simulated connection failure" }) });
  });

  await openPage(page, "/settings?tab=plex", "Settings");
  await page.getByRole("checkbox", { name: "Rolling artwork", exact: true }).click({ force: true });
  const hostname = page.getByRole("textbox", { name: "Hostname or IP address" });
  await hostname.fill(`${await hostname.inputValue()}x`);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Simulated connection failure")).toBeVisible();
  expect(order).toEqual(["artwork", "connection"]);
});

// Both requests are intercepted in the browser, so nothing reaches the server.
test("a Sonarr save sends the connection before the tag setting", async ({ page }) => {
  const order: string[] = [];
  await page.route("**/api/settings/sonarr", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    order.push("connection");
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/settings/app", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    order.push("tags");
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated tags failure" }) });
  });

  await openPage(page, "/settings?tab=sonarr", "Settings");
  await page.getByRole("checkbox", { name: "Write tags to Sonarr", exact: true }).click({ force: true });
  const baseUrl = page.getByRole("textbox", { name: "Base URL" });
  await baseUrl.fill(`${await baseUrl.inputValue()}/`);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Simulated tags failure")).toBeVisible();
  expect(order).toEqual(["connection", "tags"]);
});

// The save and the reload after it are intercepted in the browser, so nothing reaches the server.
test("a save whose settings reload fails says it was saved and blocks saving until refresh", async ({ page }) => {
  let saved = false;
  await page.route("**/api/settings/app", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    saved = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/settings", async (route) => {
    if (!saved) return route.fallback();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Simulated reload failure" }) });
  });

  await openPage(page, "/settings", "Settings");
  const activityWindow = page.getByRole("spinbutton", { name: "Viewer activity window" });
  await activityWindow.fill(String(Number(await activityWindow.inputValue()) + 1));
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Saved, but the settings could not be reloaded: Simulated reload failure.")).toBeVisible();
  const staleBanner = page.getByText("Settings could not be reloaded after a save, so this page may be out of date. Refresh the page before saving again.");
  await expect(staleBanner).toBeVisible();

  // Discarding returns the form to the stale settings, but must not re-enable saving.
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(staleBanner).toBeVisible();
  await activityWindow.fill(String(Number(await activityWindow.inputValue()) + 1));
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

// Every request is intercepted in the browser, so nothing reaches the server.
test("discarding after a partly failed save shows what the server now holds", async ({ page }) => {
  const settingsResponse = await page.request.get("/api/settings");
  await expect(settingsResponse).toBeOK();
  const settings = await settingsResponse.json() as { app: { sonarrTagsEnabled: boolean }; sonarr: { baseUrl: string } | null };
  const newBaseUrl = `${settings.sonarr?.baseUrl ?? "http://sonarr:8989"}/`;

  let connectionSaved = false;
  await page.route("**/api/settings/sonarr", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    connectionSaved = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/settings/app", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated tags failure" }) });
  });
  // Once the connection "saved", the reload reports the new base URL, as the server would.
  await page.route("**/api/settings", async (route) => {
    if (!connectionSaved) return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...settings, sonarr: { ...settings.sonarr, baseUrl: newBaseUrl } }) });
  });

  await openPage(page, "/settings?tab=sonarr", "Settings");
  const tags = page.getByRole("checkbox", { name: "Write tags to Sonarr", exact: true });
  await tags.click({ force: true });
  const baseUrl = page.getByRole("textbox", { name: "Base URL" });
  await baseUrl.fill(newBaseUrl);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Simulated tags failure")).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(baseUrl).toHaveValue(newBaseUrl);
  await expect(tags).toBeChecked({ checked: settings.app.sonarrTagsEnabled });
  await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
});
