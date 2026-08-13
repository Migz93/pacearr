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
  expect(settings.ok()).toBeTruthy();
  const { app } = (await settings.json()) as { app: { historyImportIntervalHours: number } };

  try {
    const updated = await page.request.patch("/api/settings/app", { data: { historyImportIntervalHours: 1 } });
    expect(updated.ok()).toBeTruthy();

    await openPage(page, "/settings?tab=jobs", "Settings");
    const historyImport = page.getByText("History import", { exact: true }).locator("xpath=../..");
    await historyImport.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("combobox", { name: "New frequency" })).toHaveValue("60");
  } finally {
    const restored = await page.request.patch("/api/settings/app", { data: { historyImportIntervalHours: app.historyImportIntervalHours } });
    expect.soft(restored.ok()).toBeTruthy();
  }
});
