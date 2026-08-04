import {
  checkWorkbenchReadiness,
} from "../../workbench/server/workbench-readiness.ts";

function requestId(): string {
  return `req_${crypto.randomUUID()}`;
}

export async function GET(): Promise<Response> {
  const readiness = await checkWorkbenchReadiness(process.env);
  const headers = { "cache-control": "no-store" };
  if (readiness.ready) {
    return Response.json(
      {
        status: "ready",
        source: readiness.source,
        checks: readiness.checks,
      },
      { status: 200, headers },
    );
  }
  return Response.json(
    {
      status: "not_ready",
      source: readiness.source,
      checks: readiness.checks,
      error: {
        code: "service_unavailable",
        message: "Service is not ready",
      },
      requestId: requestId(),
    },
    { status: 503, headers },
  );
}
