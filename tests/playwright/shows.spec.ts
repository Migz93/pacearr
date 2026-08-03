import { expect, test } from "@playwright/test";
import { openPage } from "./support";

test("shows tabs and filters render", async ({ page }) => {
  await openPage(page, "/shows", "Shows");
  for (const tab of ["Enrolled", "Recommendations", "Ignored", "Sonarr"]) {
    await expect(page.getByRole("tab", { name: tab, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("combobox", { name: "Sort shows" })).toBeVisible();
});

test("shows tab updates the URL", async ({ page }) => {
  await page.goto("/shows");
  await page.getByRole("tab", { name: "Recommendations", exact: true }).click();
  await expect(page).toHaveURL(/\/shows\?tab=recommendations$/);
});
