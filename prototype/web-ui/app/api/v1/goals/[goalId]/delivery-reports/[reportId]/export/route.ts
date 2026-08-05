import { getGoalVerificationHandler } from
  "../../../../../../../control-plane/runtime/goal-verification-runtime.ts";

interface Context { params: Promise<{ goalId: string; reportId: string }> }

export async function GET(request: Request, context: Context) {
  const parameters = await context.params;
  return await getGoalVerificationHandler().reportExport(
    request,
    parameters.goalId,
    parameters.reportId,
  );
}
