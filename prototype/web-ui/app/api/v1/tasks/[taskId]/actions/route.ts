import { getTaskApiHandlers } from
  "../../../../../workbench/server/task-api-runtime.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  return await getTaskApiHandlers().action(request, (await context.params).taskId);
}
