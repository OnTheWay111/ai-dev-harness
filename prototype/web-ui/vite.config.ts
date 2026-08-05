import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const e2eHttps = process.env.HARNESS_E2E_HTTPS === "true";
  const p12Contract = process.env.HARNESS_P12_CONTRACT_ADAPTERS === "enabled";
  const basicSsl = e2eHttps
    ? (await import("@vitejs/plugin-basic-ssl")).default()
    : null;

  return {
    server: {
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
      ...(e2eHttps ? { https: {} } : {}),
    },
    plugins: [
      ...(basicSsl ? [basicSsl] : []),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          ...localBindingConfig,
          ...(e2eHttps ? {
            vars: {
              WORKBENCH_DATA_SOURCE: process.env.WORKBENCH_DATA_SOURCE,
              OIDC_ISSUER: process.env.OIDC_ISSUER,
              OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
              OIDC_REDIRECT_URI: process.env.OIDC_REDIRECT_URI,
              OIDC_COOKIE_SECRET: process.env.OIDC_COOKIE_SECRET,
              OIDC_ALLOWED_RETURN_TO_PATHS:
                process.env.OIDC_ALLOWED_RETURN_TO_PATHS,
              HARNESS_ALLOWED_ORIGINS: process.env.HARNESS_ALLOWED_ORIGINS,
              ...(p12Contract ? {
                DATABASE_URL: process.env.DATABASE_URL,
                WORKBENCH_SCOPE_ID: process.env.WORKBENCH_SCOPE_ID,
                HARNESS_P12_CONTRACT_ADAPTERS:
                  process.env.HARNESS_P12_CONTRACT_ADAPTERS,
                P12_POSTGRES_BRIDGE_URL:
                  process.env.P12_POSTGRES_BRIDGE_URL,
                P12_POSTGRES_BRIDGE_TOKEN:
                  process.env.P12_POSTGRES_BRIDGE_TOKEN,
                AUTODEV_QUEUE_IMPORT_URL:
                  process.env.AUTODEV_QUEUE_IMPORT_URL,
                AUTODEV_QUEUE_IMPORT_TOKEN:
                  process.env.AUTODEV_QUEUE_IMPORT_TOKEN,
              } : {}),
            },
          } : {}),
        },
      }),
    ],
  };
});
