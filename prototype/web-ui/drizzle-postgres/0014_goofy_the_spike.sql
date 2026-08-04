CREATE TABLE "execution_waves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"issue_plan_id" uuid NOT NULL,
	"wave_number" integer NOT NULL,
	"issue_keys" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_waves_number_chk" CHECK ("execution_waves"."wave_number" > 0),
	CONSTRAINT "execution_waves_issue_keys_chk" CHECK (jsonb_typeof("execution_waves"."issue_keys") = 'array' AND jsonb_array_length("execution_waves"."issue_keys") > 0),
	CONSTRAINT "execution_waves_reasons_chk" CHECK (jsonb_typeof("execution_waves"."reasons") = 'array')
);
--> statement-breakpoint
CREATE TABLE "issue_plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"spec_revision_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_plan_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_spec_version" integer NOT NULL,
	"source_spec_digest" text NOT NULL,
	"plan_data" jsonb NOT NULL,
	"digest" text NOT NULL,
	"planner_run_id" text NOT NULL,
	"planner_configuration" jsonb NOT NULL,
	"compiler_policy_revision" text NOT NULL,
	"conflict_policy_revision" text NOT NULL,
	"model_router_policy_revision" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_plan_revisions_goal_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "issue_plan_revisions_chain_chk" CHECK ("issue_plan_revisions"."revision" > 0 AND (("issue_plan_revisions"."revision" = 1 AND "issue_plan_revisions"."previous_plan_id" IS NULL) OR ("issue_plan_revisions"."revision" > 1 AND "issue_plan_revisions"."previous_plan_id" IS NOT NULL))),
	CONSTRAINT "issue_plan_revisions_status_chk" CHECK ("issue_plan_revisions"."status" IN ('draft','approved','rejected','superseded')),
	CONSTRAINT "issue_plan_revisions_source_chk" CHECK ("issue_plan_revisions"."source_spec_version" > 0 AND "issue_plan_revisions"."source_spec_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "issue_plan_revisions_digest_chk" CHECK ("issue_plan_revisions"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "issue_plan_revisions_metadata_chk" CHECK (char_length(btrim("issue_plan_revisions"."planner_run_id")) BETWEEN 1 AND 200 AND char_length(btrim("issue_plan_revisions"."compiler_policy_revision")) BETWEEN 1 AND 100 AND char_length(btrim("issue_plan_revisions"."conflict_policy_revision")) BETWEEN 1 AND 100 AND char_length(btrim("issue_plan_revisions"."model_router_policy_revision")) BETWEEN 1 AND 100),
	CONSTRAINT "issue_plan_revisions_version_positive_chk" CHECK ("issue_plan_revisions"."version" > 0),
	CONSTRAINT "issue_plan_revisions_timestamps_order_chk" CHECK ("issue_plan_revisions"."generated_at" >= "issue_plan_revisions"."created_at" AND "issue_plan_revisions"."updated_at" >= "issue_plan_revisions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "model_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"issue_plan_id" uuid NOT NULL,
	"issue_key" text NOT NULL,
	"capability_tier" text NOT NULL,
	"reasoning_effort" text NOT NULL,
	"factors" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"override" jsonb,
	"policy_revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_recommendations_issue_key_chk" CHECK (char_length("model_recommendations"."issue_key") BETWEEN 1 AND 64 AND "model_recommendations"."issue_key" ~ '^[A-Z][A-Z0-9-]*$'),
	CONSTRAINT "model_recommendations_capability_chk" CHECK ("model_recommendations"."capability_tier" IN ('cost_optimized','general_coding','advanced_coding','frontier')),
	CONSTRAINT "model_recommendations_effort_chk" CHECK ("model_recommendations"."reasoning_effort" IN ('low','medium','high','highest')),
	CONSTRAINT "model_recommendations_policy_chk" CHECK (char_length(btrim("model_recommendations"."policy_revision")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "queue_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"issue_plan_id" uuid NOT NULL,
	"plan_digest" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_id" text NOT NULL,
	"external_import_id" text NOT NULL,
	"status" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_projections_digest_chk" CHECK ("queue_projections"."plan_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "queue_projections_status_chk" CHECK ("queue_projections"."status" IN ('completed','failed')),
	CONSTRAINT "queue_projections_identity_chk" CHECK (char_length(btrim("queue_projections"."idempotency_key")) BETWEEN 1 AND 200 AND char_length(btrim("queue_projections"."request_id")) BETWEEN 1 AND 200 AND char_length(btrim("queue_projections"."external_import_id")) BETWEEN 1 AND 200),
	CONSTRAINT "queue_projections_version_positive_chk" CHECK ("queue_projections"."version" > 0),
	CONSTRAINT "queue_projections_timestamps_order_chk" CHECK ("queue_projections"."updated_at" >= "queue_projections"."created_at")
);
--> statement-breakpoint
ALTER TABLE "execution_waves" ADD CONSTRAINT "execution_waves_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_plan_id") REFERENCES "public"."issue_plan_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issue_plan_revisions" ADD CONSTRAINT "issue_plan_revisions_spec_revision_fk" FOREIGN KEY ("organization_id","project_id","goal_id","spec_revision_id") REFERENCES "public"."spec_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issue_plan_revisions" ADD CONSTRAINT "issue_plan_revisions_previous_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_plan_id") REFERENCES "public"."issue_plan_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "model_recommendations" ADD CONSTRAINT "model_recommendations_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_plan_id") REFERENCES "public"."issue_plan_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "queue_projections" ADD CONSTRAINT "queue_projections_plan_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_plan_id") REFERENCES "public"."issue_plan_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_waves_plan_number_uidx" ON "execution_waves" USING btree ("organization_id","project_id","goal_id","issue_plan_id","wave_number");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_plan_revisions_goal_revision_uidx" ON "issue_plan_revisions" USING btree ("organization_id","project_id","goal_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "model_recommendations_plan_issue_uidx" ON "model_recommendations" USING btree ("organization_id","project_id","goal_id","issue_plan_id","issue_key");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_projections_idempotency_uidx" ON "queue_projections" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_projections_plan_digest_uidx" ON "queue_projections" USING btree ("organization_id","project_id","goal_id","issue_plan_id","plan_digest");