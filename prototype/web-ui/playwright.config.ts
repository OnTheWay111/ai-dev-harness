import { defineConfig } from "@playwright/test";

const baseURL = "https://localhost:4174";
const cookieSecret = Buffer.alloc(32, 7).toString("base64url");

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    browserName: "chromium",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host localhost --port 4174",
    url: `${baseURL}/health/live`,
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
    timeout: 120_000,
    env: {
      ...process.env,
      WORKBENCH_DATA_SOURCE: "demo",
      HARNESS_E2E_HTTPS: "true",
      OIDC_ISSUER: "https://p5-e2e-issuer.invalid",
      OIDC_CLIENT_ID: "p5-browser-client",
      OIDC_REDIRECT_URI: `${baseURL}/auth/callback`,
      OIDC_COOKIE_SECRET: cookieSecret,
      OIDC_ALLOWED_RETURN_TO_PATHS: "/,/releases",
      HARNESS_ALLOWED_ORIGINS: baseURL,
    },
  },
});
