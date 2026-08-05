import { defineConfig } from "@playwright/test";

const baseURL = "https://localhost:4175";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "p12-*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    browserName: "chromium",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host localhost --port 4175",
    url: `${baseURL}/health/live`,
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
    timeout: 120_000,
    env: {
      ...process.env,
      HARNESS_E2E_HTTPS: "true",
      HARNESS_ALLOWED_ORIGINS: baseURL,
      OIDC_REDIRECT_URI: `${baseURL}/auth/callback`,
    },
  },
});
