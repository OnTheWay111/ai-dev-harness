import { getTaskApiHandlers } from
  "../../../../workbench/server/task-api-runtime.ts";

export async function GET(
  request: Request,
  context: { params: Promise<{ receiptId: string }> },
): Promise<Response> {
  return await getTaskApiHandlers().receipt(
    request,
    (await context.params).receiptId,
  );
}
