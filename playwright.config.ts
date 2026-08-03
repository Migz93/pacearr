import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.playwright" });

const baseURL = process.env.BASE_URL ?? "http://localhost:9302";

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
    trace: "on-first-retry",
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
