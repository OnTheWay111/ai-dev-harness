import { getArtifactDownloadHandler } from
  "../../../../../control-plane/runtime/artifact-runtime.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
): Promise<Response> {
  return await getArtifactDownloadHandler()(
    request,
    (await context.params).artifactId,
  );
}
