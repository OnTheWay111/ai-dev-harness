import { WorkbenchApp } from "./workbench/components/workbench-app";
import {
  getWorkbenchRepository,
  getWorkbenchVisibilityResolver,
} from "./workbench/server/workbench-repository-factory";
import { getOidcService } from "./auth/oidc-runtime";
import { readRequestPrincipal } from "./auth/oidc-http";
import { hasVisibleProjects } from "./auth/visibility-scope";
import { resolveDefaultGoalWorkspaceScope } from
  "./control-plane/runtime/goal-workspace-runtime";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Home() {
  const requestHeaders = await headers();
  const principal = await readRequestPrincipal(
    new Request("https://harness.invalid/", {
      headers: { cookie: requestHeaders.get("cookie") ?? "" },
    }),
    getOidcService(),
  );
  if (!principal) redirect("/auth/login?returnTo=/");
  const loadResult = await (async () => {
    try {
      const visibility = await getWorkbenchVisibilityResolver().resolve(
        principal.actorId,
      );
      if (!hasVisibleProjects(visibility)) {
        return { kind: "forbidden" as const };
      }
      const goalWorkspaceScope = await resolveDefaultGoalWorkspaceScope(visibility);
      if (!goalWorkspaceScope) {
        return { kind: "workspace-unavailable" as const };
      }
      const { data } = await getWorkbenchRepository().getWorkbench(
        visibility,
        { limit: 50 },
      );
      return { kind: "loaded" as const, data, goalWorkspaceScope };
    } catch {
      return { kind: "service-unavailable" as const };
    }
  })();
  if (loadResult.kind === "forbidden") {
    return (
      <main className="page-failure-state" role="alert">
        <h1>没有可见项目</h1>
        <p>当前账号无法查看任何项目，未返回组织或项目数据。</p>
        <p>请联系组织管理员分配项目角色后重新加载。</p>
      </main>
    );
  }
  if (loadResult.kind === "workspace-unavailable") {
    return (
      <main className="page-failure-state" role="alert">
        <h1>Goal Workspace 不可用</h1>
        <p>当前账号没有可用于 Goal Workspace 的项目。</p>
        <p>请联系组织管理员分配项目角色后重新加载。</p>
      </main>
    );
  }
  if (loadResult.kind === "service-unavailable") {
    return (
      <main className="page-failure-state" role="alert">
        <h1>工作台暂时不可用</h1>
        <p>数据库读取失败，当前页面没有展示过期数据或演示数据。</p>
        <p>请稍后重新加载；若问题持续，请联系平台管理员。</p>
        <Link href="/">重新加载</Link>
      </main>
    );
  }
  return (
    <WorkbenchApp
      initialSnapshot={loadResult.data}
      goalWorkspaceScope={loadResult.goalWorkspaceScope}
    />
  );
}
