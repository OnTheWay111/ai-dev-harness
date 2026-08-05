CREATE TABLE "acceptance_verification_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"goal_version" integer NOT NULL,
	"issue_plan_id" uuid NOT NULL,
	"issue_plan_version" integer NOT NULL,
	"revision" integer NOT NULL,
	"previous_plan_id" uuid,
	"entries" jsonb NOT NULL,
	"compilation" jsonb NOT NULL,
	"digest" text NOT NULL,
	"compiled_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acceptance_verification_plans_scope_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "acceptance_verification_plans_chain_chk" CHECK ("acceptance_verification_plans"."revision" > 0 AND (("acceptance_verification_plans"."revision"=1 AND "acceptance_verification_plans"."previous_plan_id" IS NULL) OR ("acceptance_verification_plans"."revision">1 AND "acceptance_verification_plans"."previous_plan_id" IS NOT NULL))),
	CONSTRAINT "acceptance_verification_plans_source_chk" CHECK ("acceptance_verification_plans"."goal_version" > 0 AND "acceptance_verification_plans"."issue_plan_version" > 0 AND "acceptance_verification_plans"."version" > 0),
	CONSTRAINT "acceptance_verification_plans_payload_chk" CHECK (jsonb_typeof("acceptance_verification_plans"."entries")='array' AND jsonb_array_length("acceptance_verification_plans"."entries") BETWEEN 1 AND 50 AND jsonb_typeof("acceptance_verification_plans"."compilation")='object' AND "acceptance_verification_plans"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "acceptance_verification_plans_time_chk" CHECK ("acceptance_verification_plans"."compiled_at" >= "acceptance_verification_plans"."created_at")
);
--> statement-breakpoint
CREATE TABLE "delivery_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_report_id" uuid,
	"verification_id" uuid NOT NULL,
	"verification_plan_id" uuid NOT NULL,
	"issue_plan_id" uuid NOT NULL,
	"goal_snapshot" jsonb NOT NULL,
	"acceptance" jsonb NOT NULL,
	"issue_runs" jsonb NOT NULL,
	"exceptions" jsonb NOT NULL,
	"known_risks" jsonb NOT NULL,
	"regression_risks" jsonb NOT NULL,
	"status" text NOT NULL,
	"human_acceptance" jsonb,
	"digest" text NOT NULL,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_reports_scope_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "delivery_reports_chain_chk" CHECK ("delivery_reports"."revision" > 0 AND (("delivery_reports"."revision"=1 AND "delivery_reports"."previous_report_id" IS NULL) OR ("delivery_reports"."revision">1 AND "delivery_reports"."previous_report_id" IS NOT NULL))),
	CONSTRAINT "delivery_reports_status_chk" CHECK (("delivery_reports"."status"='awaiting_human_acceptance' AND "delivery_reports"."human_acceptance" IS NULL) OR ("delivery_reports"."status"='accepted' AND jsonb_typeof("delivery_reports"."human_acceptance")='object')),
	CONSTRAINT "delivery_reports_payload_chk" CHECK (jsonb_typeof("delivery_reports"."goal_snapshot")='object' AND jsonb_typeof("delivery_reports"."acceptance")='array' AND jsonb_array_length("delivery_reports"."acceptance") BETWEEN 1 AND 50 AND jsonb_typeof("delivery_reports"."issue_runs")='array' AND jsonb_array_length("delivery_reports"."issue_runs") > 0 AND jsonb_typeof("delivery_reports"."exceptions")='array' AND jsonb_typeof("delivery_reports"."known_risks")='array' AND jsonb_typeof("delivery_reports"."regression_risks")='array'),
	CONSTRAINT "delivery_reports_identity_chk" CHECK ("delivery_reports"."digest" ~ '^[0-9a-f]{64}$' AND char_length(btrim("delivery_reports"."generated_by")) BETWEEN 1 AND 200 AND "delivery_reports"."version" > 0 AND "delivery_reports"."generated_at" >= "delivery_reports"."created_at")
);
--> statement-breakpoint
CREATE TABLE "gap_remediation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gap_remediation_receipts_identity_chk" CHECK (char_length(btrim("gap_remediation_receipts"."actor_id")) BETWEEN 1 AND 200 AND char_length("gap_remediation_receipts"."idempotency_key") BETWEEN 8 AND 200 AND "gap_remediation_receipts"."request_hash" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("gap_remediation_receipts"."receipt")='object')
);
--> statement-breakpoint
CREATE TABLE "goal_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"verification_plan_id" uuid NOT NULL,
	"issue_plan_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_verification_id" uuid,
	"goal_version" integer NOT NULL,
	"verdict" text NOT NULL,
	"deterministic_results" jsonb NOT NULL,
	"verifier_output" jsonb NOT NULL,
	"verifier_identity" text NOT NULL,
	"verifier_version" text NOT NULL,
	"session_id" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_verifications_scope_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "goal_verifications_chain_chk" CHECK ("goal_verifications"."revision" > 0 AND (("goal_verifications"."revision"=1 AND "goal_verifications"."previous_verification_id" IS NULL) OR ("goal_verifications"."revision">1 AND "goal_verifications"."previous_verification_id" IS NOT NULL))),
	CONSTRAINT "goal_verifications_verdict_chk" CHECK ("goal_verifications"."verdict" IN ('passed','failed','needs_manual')),
	CONSTRAINT "goal_verifications_payload_chk" CHECK ("goal_verifications"."goal_version" > 0 AND "goal_verifications"."version" > 0 AND jsonb_typeof("goal_verifications"."deterministic_results")='array' AND jsonb_array_length("goal_verifications"."deterministic_results") BETWEEN 1 AND 50 AND jsonb_typeof("goal_verifications"."verifier_output")='object'),
	CONSTRAINT "goal_verifications_identity_chk" CHECK (char_length(btrim("goal_verifications"."verifier_identity")) BETWEEN 1 AND 200 AND char_length(btrim("goal_verifications"."verifier_version")) BETWEEN 1 AND 200 AND char_length(btrim("goal_verifications"."session_id")) BETWEEN 1 AND 200 AND "goal_verifications"."verified_at" >= "goal_verifications"."created_at")
);
--> statement-breakpoint
CREATE TABLE "verification_gap_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"verification_id" uuid NOT NULL,
	"issue_plan_id" uuid NOT NULL,
	"failed_criterion_refs" jsonb NOT NULL,
	"preserved_evidence_refs" jsonb NOT NULL,
	"gaps" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_gap_reports_scope_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "verification_gap_reports_payload_chk" CHECK (jsonb_typeof("verification_gap_reports"."failed_criterion_refs")='array' AND jsonb_array_length("verification_gap_reports"."failed_criterion_refs") <= 50 AND jsonb_typeof("verification_gap_reports"."preserved_evidence_refs")='array' AND jsonb_typeof("verification_gap_reports"."gaps")='array' AND jsonb_array_length("verification_gap_reports"."gaps") BETWEEN 1 AND 50),
	CONSTRAINT "verification_gap_reports_identity_chk" CHECK (char_length(btrim("verification_gap_reports"."created_by")) BETWEEN 1 AND 200 AND "verification_gap_reports"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "acceptance_verification_plans" ADD CONSTRAINT "acceptance_verification_plans_goal_fk" FOREIGN KEY ("organization_id","project_id","goal_id") REFERENCES "public"."goals"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "acceptance_verification_plans" ADD CONSTRAINT "acceptance_verification_plans_issue_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_plan_id") REFERENCES "public"."issue_plan_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "acceptance_verification_plans" ADD CONSTRAINT "acceptance_verification_plans_previous_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_plan_id") REFERENCES "public"."acceptance_verification_plans"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_reports" ADD CONSTRAINT "delivery_reports_verification_fk" FOREIGN KEY ("organization_id","project_id","goal_id","verification_id") REFERENCES "public"."goal_verifications"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_reports" ADD CONSTRAINT "delivery_reports_verification_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","verification_plan_id") REFERENCES "public"."acceptance_verification_plans"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_reports" ADD CONSTRAINT "delivery_reports_issue_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_plan_id") REFERENCES "public"."issue_plan_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_reports" ADD CONSTRAINT "delivery_reports_previous_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_report_id") REFERENCES "public"."delivery_reports"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gap_remediation_receipts" ADD CONSTRAINT "gap_remediation_receipts_report_fk" FOREIGN KEY ("organization_id","project_id","goal_id","report_id") REFERENCES "public"."verification_gap_reports"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gap_remediation_receipts" ADD CONSTRAINT "gap_remediation_receipts_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","plan_id") REFERENCES "public"."issue_plan_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "goal_verifications" ADD CONSTRAINT "goal_verifications_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","verification_plan_id") REFERENCES "public"."acceptance_verification_plans"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "goal_verifications" ADD CONSTRAINT "goal_verifications_issue_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_plan_id") REFERENCES "public"."issue_plan_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "goal_verifications" ADD CONSTRAINT "goal_verifications_previous_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_verification_id") REFERENCES "public"."goal_verifications"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "verification_gap_reports" ADD CONSTRAINT "verification_gap_reports_verification_fk" FOREIGN KEY ("organization_id","project_id","goal_id","verification_id") REFERENCES "public"."goal_verifications"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "verification_gap_reports" ADD CONSTRAINT "verification_gap_reports_issue_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_plan_id") REFERENCES "public"."issue_plan_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "acceptance_verification_plans_goal_revision_uidx" ON "acceptance_verification_plans" USING btree ("organization_id","project_id","goal_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_reports_goal_revision_uidx" ON "delivery_reports" USING btree ("organization_id","project_id","goal_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "gap_remediation_receipts_idempotency_uidx" ON "gap_remediation_receipts" USING btree ("organization_id","report_id","actor_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_verifications_goal_revision_uidx" ON "goal_verifications" USING btree ("organization_id","project_id","goal_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_verifications_session_uidx" ON "goal_verifications" USING btree ("organization_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_gap_reports_verification_uidx" ON "verification_gap_reports" USING btree ("verification_id");--> statement-breakpoint
CREATE TRIGGER acceptance_verification_plans_append_only
BEFORE UPDATE OR DELETE ON acceptance_verification_plans
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER goal_verifications_append_only
BEFORE UPDATE OR DELETE ON goal_verifications
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER verification_gap_reports_append_only
BEFORE UPDATE OR DELETE ON verification_gap_reports
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER gap_remediation_receipts_append_only
BEFORE UPDATE OR DELETE ON gap_remediation_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER delivery_reports_append_only
BEFORE UPDATE OR DELETE ON delivery_reports
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();
