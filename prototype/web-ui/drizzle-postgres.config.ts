import { defineConfig } from "drizzle-kit";

import {
  resolvePostgresConnection,
} from "./app/workbench/server/postgres-environment.ts";

const databaseUrl = process.env.HARNESS_DEPLOYMENT_ENV !== undefined
  ? resolvePostgresConnection(process.env, "migrator").databaseUrl
  : process.env.MIGRATION_DATABASE_URL?.trim();

export default defineConfig({
  out: "./drizzle-postgres",
  schema: "./db/postgres-schema.ts",
  dialect: "postgresql",
  ...(databaseUrl
    ? {
        dbCredentials: {
          url: databaseUrl,
        },
      }
    : {}),
});
