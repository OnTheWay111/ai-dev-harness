import { getReleaseCenterHandlers } from
  "../../../../release-center/runtime.ts";

export async function POST(request: Request): Promise<Response> {
  return await getReleaseCenterHandlers().productionCollection(request);
}
