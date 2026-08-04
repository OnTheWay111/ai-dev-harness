import { WorkbenchApp } from "./workbench/components/workbench-app";
import {
  getWorkbenchRepository,
  getWorkbenchVisibilityResolver,
} from "./workbench/server/workbench-repository-factory";
import { getOidcService } from "./auth/oidc-runtime";
import { readRequestPrincipal } from "./auth/oidc-http";
import { hasVisibleProjects } from "./auth/visibility-scope";
import { headers } from "next/headers";
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
  const visibility = await getWorkbenchVisibilityResolver().resolve(
    principal.actorId,
  );
  if (!hasVisibleProjects(visibility)) {
    return <main>当前账号没有可见项目，请联系组织管理员分配角色。</main>;
  }
  const workbenchRepository = getWorkbenchRepository();
  const { data } = await workbenchRepository.getWorkbench(
    visibility,
    { limit: 50 },
  );
  return <WorkbenchApp initialSnapshot={data} />;
}
