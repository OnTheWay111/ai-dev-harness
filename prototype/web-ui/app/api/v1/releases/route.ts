import { getReleaseCenterHandlers } from
  "../../../release-center/runtime.ts";

export async function GET(request: Request): Promise<Response> {
  return await getReleaseCenterHandlers().collection(request);
}
