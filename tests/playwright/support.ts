import { expect, type ConsoleMessage, type Page } from "@playwright/test";

export async function openPage(page: Page, path: string, heading: string): Promise<void> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error" && !message.text().startsWith("The Cross-Origin-Opener-Policy header has been ignored")) {
      consoleErrors.push(message.text());
    }
  };
  const onPageError = (error: Error) => pageErrors.push(error.message);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  try {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    expect(consoleErrors, `Unexpected browser console errors on ${path}`).toEqual([]);
    expect(pageErrors, `Unexpected page errors on ${path}`).toEqual([]);
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}
