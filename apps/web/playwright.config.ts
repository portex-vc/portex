import { defineConfig, devices } from "@playwright/test";
import { WEB_URL } from "./e2e/env";

/**
 * E2E against a fully local stack started by e2e/global-setup.ts:
 * anvil :18550 · backend :18791 · frontend :13100. One worker only — every flow
 * warps chain time, so specs must run serially.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 10 * 60 * 1000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: WEB_URL,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    actionTimeout: 20_000,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
