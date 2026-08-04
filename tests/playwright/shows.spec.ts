import { expect, test } from "@playwright/test";
import { openPage } from "./support";

test("shows tabs and filters render", async ({ page }) => {
  await openPage(page, "/shows", "Shows");
  for (const tab of ["Enrolled", "Recommendations", "Sonarr"]) {
    await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
  }
  // Shows.tsx appends a live " (N)" count to the Ignored button once
  // ignoredCount > 0, so match with or without that suffix rather than
  // pinning the assertion to whatever the count happens to be right now.
  await expect(page.getByRole("button", { name: /^Ignored( \(\d+\))?$/ })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Sort shows" })).toBeVisible();
});

test("shows tab updates the URL", async ({ page }) => {
  await page.goto("/shows");
  await page.getByRole("button", { name: "Recommendations", exact: true }).click();
  await expect(page).toHaveURL(/\/shows\?tab=recommendations$/);
});
