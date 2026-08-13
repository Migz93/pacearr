import { expect, test } from "@playwright/test";
import { openPage } from "./support";

test("history filters and page size render", async ({ page }) => {
  await openPage(page, "/history", "History");
  // No code path writes an error-level history event, so there is deliberately no
  // Error level button here.
  for (const level of ["All levels", "Info", "Warning"]) {
    await expect(page.getByRole("button", { name: level, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Error", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Rows per page" })).toBeVisible();
});

test("history type filter is a fixed set of categories, not one button per action", async ({ page }) => {
  await openPage(page, "/history", "History");
  const categories = ["All types", "Monitoring", "Cleanup", "Shows", "Sync"];
  for (const category of categories) {
    await expect(page.getByRole("button", { name: category, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("group", { name: "Event type" }).getByRole("button")).toHaveCount(categories.length);
});

test("history category filter updates the URL", async ({ page }) => {
  await openPage(page, "/history", "History");
  await page.getByRole("button", { name: "Cleanup", exact: true }).click();
  await expect(page).toHaveURL(/\/history\?category=cleanup$/);
});

test("history level filter updates the URL", async ({ page }) => {
  await openPage(page, "/history", "History");
  await page.getByRole("button", { name: "Warning", exact: true }).click();
  await expect(page).toHaveURL(/\/history\?level=warn$/);
});
