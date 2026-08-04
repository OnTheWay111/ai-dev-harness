import type { ActorVisibilityScope } from "../../auth/visibility-scope.ts";
import {
  assertSameOrigin,
  configuredWriteOrigins,
  RequestSecurityError,
  withSecurityHeaders,
} from "../../security/request-security.ts";
import {
  ArtifactDownloadError,
  type ArtifactDownloadService,
} from "../application/artifact-download-service.ts";

function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && supplied.length <= 200
    ? supplied
    : `req_${crypto.randomUUID()}`;
}

function errorResponse(
  status: number,
  id: string,
  message: string,
): Response {
  return withSecurityHeaders(Response.json({
    error: {
      code: status === 404 ? "not_found" : status === 403 ? "forbidden" : "internal_error",
      message,
      impact: "未创建 Artifact 下载授权",
      preservedState: "不可变证据及其保留策略未改变",
      nextAction: status === 404
        ? "刷新任务证据后重试"
        : "检查登录与项目权限后重试",
    },
    requestId: id,
  }, {
    status,
    headers: { "cache-control": "private, no-store" },
  }));
}

export function createArtifactDownloadHandler(input: {
  service: ArtifactDownloadService;
  actorResolver(request: Request): Promise<{ actorId: string } | null>;
  visibilityResolver(request: Request): Promise<ActorVisibilityScope>;
  allowedOrigins?: readonly string[];
}) {
  const origins = input.allowedOrigins ?? configuredWriteOrigins();
  return async (request: Request, artifactId: string): Promise<Response> => {
    const id = requestId(request);
    try {
      if (request.method !== "POST") {
        return errorResponse(404, id, "Artifact download endpoint was not found");
      }
      assertSameOrigin(request, origins);
      const actor = await input.actorResolver(request);
      if (!actor) return errorResponse(403, id, "需要有效登录会话");
      const result = await input.service.createGrant({
        artifactId,
        actorId: actor.actorId,
        visibility: await input.visibilityResolver(request),
      });
      return withSecurityHeaders(Response.json({ ...result, requestId: id }, {
        headers: { "cache-control": "private, no-store" },
      }));
    } catch (error) {
      if (error instanceof ArtifactDownloadError) {
        return errorResponse(404, id, error.message);
      }
      if (error instanceof RequestSecurityError) {
        return errorResponse(403, id, "下载请求未通过同源安全校验");
      }
      return errorResponse(500, id, "Artifact 下载服务暂时不可用");
    }
  };
}
