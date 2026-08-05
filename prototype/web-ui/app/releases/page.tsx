import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { readRequestPrincipal } from "../auth/oidc-http";
import { getOidcService } from "../auth/oidc-runtime";
import { ReleaseCenterApp } from "../release-center/release-center-app";
import type { ReleaseCenterSnapshot } from "../release-center/api-client";
import type { ReleaseCenterScope } from "../release-center/repository";
import { getReleaseCenterService } from "../release-center/runtime";
import { resolveDefaultGoalWorkspaceScope } from
  "../control-plane/runtime/goal-workspace-runtime";
import { getWorkbenchVisibilityResolver } from
  "../workbench/server/workbench-repository-factory";

export const dynamic = "force-dynamic";

export default async function ReleasesPage() {
  const requestHeaders = await headers();
  const principal = await readRequestPrincipal(new Request(
    "https://harness.invalid/releases",
    { headers: { cookie: requestHeaders.get("cookie") ?? "" } },
  ), getOidcService());
  if (!principal) redirect("/auth/login?returnTo=/releases");
  let scope: ReleaseCenterScope | null = null;
  let initialSnapshot: ReleaseCenterSnapshot | null = null;
  let failed = false;
  try {
    const visibility = await getWorkbenchVisibilityResolver().resolve(principal.actorId);
    scope = await resolveDefaultGoalWorkspaceScope(visibility);
    initialSnapshot = scope
      ? await getReleaseCenterService().snapshot({
          ...scope,
          actorId: principal.actorId,
        })
      : null;
  } catch {
    failed = true;
  }
  if (failed) {
    return <main className="page-failure-state" role="alert"><h1>发布中心暂时不可用</h1><p>页面没有展示模拟发布状态；请稍后重试。</p></main>;
  }
  if (!scope || !initialSnapshot) {
    return <main className="page-failure-state" role="alert"><h1>没有可发布项目</h1><p>请联系管理员分配项目角色。</p></main>;
  }
  return <ReleaseCenterApp scope={scope} initialSnapshot={initialSnapshot} />;
}
