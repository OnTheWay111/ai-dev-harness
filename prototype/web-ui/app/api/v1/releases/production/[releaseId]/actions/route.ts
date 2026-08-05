import { getReleaseCenterHandlers } from
  "../../../../../../release-center/runtime.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ releaseId: string }> },
): Promise<Response> {
  return await getReleaseCenterHandlers().productionAction(
    request,
    (await context.params).releaseId,
  );
}
