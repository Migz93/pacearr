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
test("a save error clears once the form is back at its saved values", async ({ page }) => {
  await openPage(page, "/settings", "Settings");
  const activityWindow = page.getByRole("spinbutton", { name: "Viewer activity window" });
  const original = await activityWindow.inputValue();

  await activityWindow.fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Viewer activity window must be a positive whole number of days.")).toBeVisible();

  await activityWindow.fill(original);
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
  await expect(page.getByText("Simulated save failure")).toBeHidden();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
});
