import { WorkbenchApp } from "./workbench/components/workbench-app";
import { getWorkbenchRepository } from "./workbench/server/workbench-repository-factory";

export const dynamic = "force-dynamic";

export default async function Home() {
  const workbenchRepository = getWorkbenchRepository();
  const { data } = await workbenchRepository.getWorkbench({ limit: 50 });
  return <WorkbenchApp initialSnapshot={data} />;
}
