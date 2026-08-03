import { expect, test } from "@playwright/test";
import { openPage } from "./support";

test("history filters and page size render", async ({ page }) => {
  await openPage(page, "/history", "History");
  for (const level of ["All levels", "Info", "Warning", "Error"]) {
    await expect(page.getByRole("button", { name: level, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("combobox", { name: "Rows per page" })).toBeVisible();
});

test("history level filter updates the URL", async ({ page }) => {
  await page.goto("/history");
  await page.getByRole("button", { name: "Warning", exact: true }).click();
  await expect(page).toHaveURL(/\/history\?level=warn$/);
});
