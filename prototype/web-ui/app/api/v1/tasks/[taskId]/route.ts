import { getTaskApiHandlers } from
  "../../../../workbench/server/task-api-runtime.ts";

export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  return await getTaskApiHandlers().task(request, (await context.params).taskId);
}
