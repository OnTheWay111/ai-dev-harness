import {
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";

import {
  AlertEvaluator,
  P11_ALERT_RULES,
} from "../app/observability/alerting.ts";
import { createObservabilityContext } from
  "../app/observability/context.ts";
import {
  PostgresOperationalSignalCollector,
  recordOperationalMetrics,
} from "../app/observability/operational-signals.ts";
import { StructuredTelemetry } from
  "../app/observability/telemetry.ts";
import { resolvePostgresConnection } from
  "../app/workbench/server/postgres-environment.ts";

const { Pool } = pg;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function interval(): number {
  const value = Number(process.env.ALERT_MONITOR_INTERVAL_MS ?? "15000");
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error("ALERT_MONITOR_INTERVAL_MS must be between 1000 and 300000");
  }
  return value;
}

function ratio(name: string): number {
  const value = Number(process.env[name] ?? "0");
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function suppressions(): readonly string[] {
  return (process.env.ALERT_SUPPRESSIONS ?? "").split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  if (process.env.ARTIFACT_OBJECT_STORE !== "s3") {
    throw new Error("Alert monitor requires ARTIFACT_OBJECT_STORE=s3");
  }
  const database = resolvePostgresConnection(process.env, "app");
  const pool = new Pool({ connectionString: database.databaseUrl, max: 2 });
  const s3 = new S3Client({
    region: required("ARTIFACT_S3_REGION"),
    endpoint: process.env.ARTIFACT_S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: process.env.ARTIFACT_S3_FORCE_PATH_STYLE === "true",
  });
  const bucket = required("ARTIFACT_S3_BUCKET");
  const collector = new PostgresOperationalSignalCollector({
    pool,
    objectStoreProbe: {
      async check() {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
      },
    },
    sseErrorRate: () => ratio("HARNESS_SSE_ERROR_RATE"),
    suppressions,
  });
  const evaluator = new AlertEvaluator(P11_ALERT_RULES);
  const telemetry = new StructuredTelemetry();
  const context = createObservabilityContext({
    process: "scheduler",
    requestId: `alert-monitor-${process.pid}`,
  });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    while (!stopping) {
      const signals = await collector.collect();
      recordOperationalMetrics(telemetry, signals);
      for (const transition of evaluator.evaluate(signals)) {
        telemetry.event(
          `alert.${transition.state}`,
          context,
          { ...transition },
          transition.state === "firing" ? "error" : "info",
        );
      }
      if (process.env.ALERT_MONITOR_ONCE === "true") break;
      await new Promise<void>((resolve) => setTimeout(resolve, interval()));
    }
  } finally {
    await pool.end();
    s3.destroy();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "alert monitor failed";
  console.error(JSON.stringify({
    schema_version: "harness.process-error.v1",
    process: "alert-monitor",
    message: message.replace(/(?:postgres(?:ql)?):\/\/[^\s\"]+/gi,
      "[REDACTED_CONNECTION_URL]"),
  }));
  process.exitCode = 1;
});
