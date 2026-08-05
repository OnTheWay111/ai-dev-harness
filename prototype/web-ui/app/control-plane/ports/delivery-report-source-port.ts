import type { DeliveryReportSource } from "../domain/delivery-report.ts";
import type { GoalVerificationScope } from
  "./goal-verification-repository.ts";

export interface DeliveryReportSourcePort {
  collect(scope: GoalVerificationScope): Promise<DeliveryReportSource>;
}
