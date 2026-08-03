import { expect, type Page } from "@playwright/test";

export async function openPage(page: Page, path: string, heading: string): Promise<void> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("The Cross-Origin-Opener-Policy header has been ignored")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(path);
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(consoleErrors, `Unexpected browser console errors on ${path}`).toEqual([]);
  expect(pageErrors, `Unexpected page errors on ${path}`).toEqual([]);
}
