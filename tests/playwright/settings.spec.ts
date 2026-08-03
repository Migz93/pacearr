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
