import { getGoalVerificationHandler } from
  "../../../../../control-plane/runtime/goal-verification-runtime.ts";

interface Context { params: Promise<{ goalId: string }> }

export async function GET(request: Request, context: Context) {
  return await getGoalVerificationHandler().verifications(
    request,
    (await context.params).goalId,
  );
}

export async function POST(request: Request, context: Context) {
  return await getGoalVerificationHandler().verifications(
    request,
    (await context.params).goalId,
  );
}
