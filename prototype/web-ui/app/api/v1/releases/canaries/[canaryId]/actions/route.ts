import { getReleaseCenterHandlers } from
  "../../../../../../release-center/runtime.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ canaryId: string }> },
): Promise<Response> {
  return await getReleaseCenterHandlers().canaryAction(
    request,
    (await context.params).canaryId,
  );
}
