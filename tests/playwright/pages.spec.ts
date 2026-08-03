import { expect, test } from "@playwright/test";
import { openPage } from "./support";

test("dashboard loads without browser errors", async ({ page }) => {
  await openPage(page, "/dashboard", "Dashboard");
});

test("shows loads without browser errors", async ({ page }) => {
  await openPage(page, "/shows", "Shows");
});

test("users loads without browser errors", async ({ page }) => {
  await openPage(page, "/users", "Users");
});

test("history loads without browser errors", async ({ page }) => {
  await openPage(page, "/history", "History");
});

test("settings loads without browser errors", async ({ page }) => {
  await openPage(page, "/settings", "Settings");
});

test("sidebar navigation links are present", async ({ page }) => {
  await page.goto("/dashboard");
  const navigation = page.getByRole("navigation");
  await expect(navigation.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Shows" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Users" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "History" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Settings" })).toBeVisible();
});

test("unauthenticated requests redirect to login", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`${baseURL}/dashboard`);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await context.close();
});
