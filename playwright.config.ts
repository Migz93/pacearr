import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

// quiet: true suppresses dotenv's own promotional "tip" banner (e.g. it
// advertises a third-party auth product) that it otherwise prints on load.
config({ path: ".env.playwright", quiet: true });

const baseURL = process.env.BASE_URL?.trim() || "http://localhost:9302";

export default defineConfig({
  testDir: "./tests/playwright",
  outputDir: "./tests/test-results",
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "tests/playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "auth-setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/playwright/.auth/storageState.json",
      },
      dependencies: ["auth-setup"],
    },
  ],
});
