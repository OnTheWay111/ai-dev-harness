CREATE TABLE "artifact_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"digest" text NOT NULL,
	"artifact_kind" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"retention_policy" text NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_objects_scope_id_uidx" UNIQUE("organization_id","project_id","id"),
	CONSTRAINT "artifact_objects_digest_chk" CHECK ("artifact_objects"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifact_objects_kind_chk" CHECK ("artifact_objects"."artifact_kind" IN ('prompt','run_log','test_output','build_result','failure_evidence')),
	CONSTRAINT "artifact_objects_retention_policy_chk" CHECK ("artifact_objects"."retention_policy" IN ('standard_180d','extended_365d','legal_hold')),
	CONSTRAINT "artifact_objects_metadata_chk" CHECK (char_length(btrim("artifact_objects"."object_key")) BETWEEN 1 AND 1000 AND char_length(btrim("artifact_objects"."media_type")) BETWEEN 1 AND 200 AND char_length(btrim("artifact_objects"."created_by_actor_id")) BETWEEN 1 AND 200 AND "artifact_objects"."size_bytes" >= 0 AND "artifact_objects"."retention_until" > "artifact_objects"."created_at")
);
--> statement-breakpoint
CREATE TABLE "credential_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_reference" text NOT NULL,
	"allowed_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_references_scope_id_uidx" UNIQUE("organization_id","project_id","repository_id","id"),
	CONSTRAINT "credential_references_provider_chk" CHECK ("credential_references"."provider" IN ('github_app','git_token')),
	CONSTRAINT "credential_references_metadata_chk" CHECK (char_length("credential_references"."external_reference") BETWEEN 18 AND 1000 AND "credential_references"."external_reference" ~ '^secret-manager://[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND jsonb_typeof("credential_references"."allowed_scopes")='array' AND "credential_references"."version" > 0 AND "credential_references"."updated_at" >= "credential_references"."created_at")
);
--> statement-breakpoint
CREATE TABLE "delivery_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"worktree_ref" text NOT NULL,
	"baseline_branch" text NOT NULL,
	"baseline_sha" text NOT NULL,
	"branch" text NOT NULL,
	"commit_message" text NOT NULL,
	"commit_sha" text,
	"review_id" uuid,
	"state" text DEFAULT 'verified' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_candidates_scope_id_uidx" UNIQUE("organization_id","project_id","id"),
	CONSTRAINT "delivery_candidates_state_chk" CHECK ("delivery_candidates"."state" IN ('verified','committed','reviewed','local_ready','branch_pushed','pr_open','landing','landed','failed')),
	CONSTRAINT "delivery_candidates_sha_chk" CHECK ("delivery_candidates"."baseline_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND ("delivery_candidates"."commit_sha" IS NULL OR "delivery_candidates"."commit_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')),
	CONSTRAINT "delivery_candidates_commit_state_chk" CHECK (("delivery_candidates"."state"='verified' AND "delivery_candidates"."commit_sha" IS NULL AND "delivery_candidates"."review_id" IS NULL) OR ("delivery_candidates"."state"<>'verified' AND "delivery_candidates"."commit_sha" IS NOT NULL)),
	CONSTRAINT "delivery_candidates_metadata_chk" CHECK (char_length(btrim("delivery_candidates"."worktree_ref")) BETWEEN 1 AND 1000 AND char_length(btrim("delivery_candidates"."baseline_branch")) BETWEEN 1 AND 255 AND char_length(btrim("delivery_candidates"."branch")) BETWEEN 1 AND 255 AND char_length(btrim("delivery_candidates"."commit_message")) BETWEEN 1 AND 4000 AND "delivery_candidates"."version" > 0 AND "delivery_candidates"."updated_at" >= "delivery_candidates"."created_at")
);
--> statement-breakpoint
CREATE TABLE "delivery_operation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"candidate_version" integer NOT NULL,
	"candidate_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_operation_receipts_identity_chk" CHECK (char_length(btrim("delivery_operation_receipts"."operation_key")) BETWEEN 8 AND 300 AND "delivery_operation_receipts"."candidate_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"push_mode" text DEFAULT 'push_disabled' NOT NULL,
	"baseline_branch" text NOT NULL,
	"branch_prefix" text DEFAULT 'autodev/' NOT NULL,
	"protected_branches" jsonb DEFAULT '["main"]'::jsonb NOT NULL,
	"credential_reference_id" uuid,
	"revision" integer NOT NULL,
	"changed_by_actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_policies_mode_chk" CHECK ("delivery_policies"."push_mode" IN ('push_disabled','push_branch','push_and_open_pr')),
	CONSTRAINT "delivery_policies_credential_chk" CHECK (("delivery_policies"."push_mode"='push_disabled' AND "delivery_policies"."credential_reference_id" IS NULL) OR ("delivery_policies"."push_mode"<>'push_disabled' AND "delivery_policies"."credential_reference_id" IS NOT NULL)),
	CONSTRAINT "delivery_policies_metadata_chk" CHECK (char_length(btrim("delivery_policies"."baseline_branch")) BETWEEN 1 AND 255 AND char_length(btrim("delivery_policies"."branch_prefix")) BETWEEN 1 AND 255 AND jsonb_typeof("delivery_policies"."protected_branches")='array' AND "delivery_policies"."revision" > 0 AND char_length(btrim("delivery_policies"."changed_by_actor_id")) BETWEEN 1 AND 200 AND char_length(btrim("delivery_policies"."reason")) BETWEEN 1 AND 4000 AND "delivery_policies"."updated_at" >= "delivery_policies"."created_at")
);
--> statement-breakpoint
CREATE TABLE "landing_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"external_id" text NOT NULL,
	"landing_commit_sha" text NOT NULL,
	"landed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_receipts_sha_chk" CHECK ("landing_receipts"."landing_commit_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "landing_receipts_metadata_chk" CHECK (char_length(btrim("landing_receipts"."operation_key")) BETWEEN 8 AND 300 AND char_length(btrim("landing_receipts"."external_id")) BETWEEN 1 AND 300 AND "landing_receipts"."landed_at" >= "landing_receipts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "pull_request_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"head_branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_request_receipts_status_chk" CHECK ("pull_request_receipts"."status" IN ('open','merged','closed')),
	CONSTRAINT "pull_request_receipts_metadata_chk" CHECK (char_length(btrim("pull_request_receipts"."operation_key")) BETWEEN 8 AND 300 AND char_length(btrim("pull_request_receipts"."external_id")) BETWEEN 1 AND 300 AND "pull_request_receipts"."url" ~ '^https://' AND char_length(btrim("pull_request_receipts"."head_branch")) BETWEEN 1 AND 255 AND char_length(btrim("pull_request_receipts"."base_branch")) BETWEEN 1 AND 255 AND "pull_request_receipts"."updated_at" >= "pull_request_receipts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "push_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"external_receipt_id" text NOT NULL,
	"remote_name" text NOT NULL,
	"remote_branch" text NOT NULL,
	"commit_sha" text NOT NULL,
	"pushed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_receipts_sha_chk" CHECK ("push_receipts"."commit_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "push_receipts_metadata_chk" CHECK (char_length(btrim("push_receipts"."operation_key")) BETWEEN 8 AND 300 AND char_length(btrim("push_receipts"."external_receipt_id")) BETWEEN 1 AND 300 AND char_length(btrim("push_receipts"."remote_name")) BETWEEN 1 AND 100 AND char_length(btrim("push_receipts"."remote_branch")) BETWEEN 1 AND 255 AND "push_receipts"."pushed_at" >= "push_receipts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"target_commit_sha" text NOT NULL,
	"verdict" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"builder_identity" text NOT NULL,
	"reviewer_type" text NOT NULL,
	"reviewer_identity" text NOT NULL,
	"reviewer_version" text NOT NULL,
	"model_capability" text,
	"reasoning_effort" text,
	"input_artifact_digests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_scope_id_uidx" UNIQUE("organization_id","project_id","goal_id","issue_id","run_id","id"),
	CONSTRAINT "reviews_commit_digest_chk" CHECK ("reviews"."target_commit_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND "reviews"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reviews_verdict_chk" CHECK ("reviews"."verdict" IN ('approved','request_changes','rejected')),
	CONSTRAINT "reviews_reviewer_chk" CHECK ("reviews"."reviewer_type" IN ('human','model') AND char_length(btrim("reviews"."builder_identity")) BETWEEN 1 AND 200 AND char_length(btrim("reviews"."reviewer_identity")) BETWEEN 1 AND 200 AND lower(btrim("reviews"."builder_identity")) <> lower(btrim("reviews"."reviewer_identity")) AND char_length(btrim("reviews"."reviewer_version")) BETWEEN 1 AND 200 AND (("reviews"."reviewer_type"='human' AND "reviews"."model_capability" IS NULL AND "reviews"."reasoning_effort" IS NULL) OR ("reviews"."reviewer_type"='model' AND "reviews"."model_capability" IN ('cost_optimized','general_coding','advanced_coding','frontier') AND "reviews"."reasoning_effort" IN ('low','medium','high','highest')))),
	CONSTRAINT "reviews_evidence_chk" CHECK (jsonb_typeof("reviews"."findings")='array' AND jsonb_typeof("reviews"."input_artifact_digests")='array' AND jsonb_array_length("reviews"."input_artifact_digests") > 0),
	CONSTRAINT "reviews_identity_version_chk" CHECK (char_length(btrim("reviews"."idempotency_key")) BETWEEN 8 AND 200 AND "reviews"."version" > 0 AND "reviews"."reviewed_at" >= "reviews"."created_at" AND "reviews"."updated_at" >= "reviews"."created_at")
);
--> statement-breakpoint
ALTER TABLE "artifact_objects" ADD CONSTRAINT "artifact_objects_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credential_references" ADD CONSTRAINT "credential_references_repository_fk" FOREIGN KEY ("organization_id","project_id","repository_id") REFERENCES "public"."repositories"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_candidates" ADD CONSTRAINT "delivery_candidates_repository_fk" FOREIGN KEY ("organization_id","project_id","repository_id") REFERENCES "public"."repositories"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_candidates" ADD CONSTRAINT "delivery_candidates_run_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_id","run_id") REFERENCES "public"."runs"("organization_id","project_id","goal_id","issue_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_candidates" ADD CONSTRAINT "delivery_candidates_review_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_id","run_id","review_id") REFERENCES "public"."reviews"("organization_id","project_id","goal_id","issue_id","run_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_operation_receipts" ADD CONSTRAINT "delivery_operation_receipts_candidate_fk" FOREIGN KEY ("organization_id","project_id","candidate_id") REFERENCES "public"."delivery_candidates"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_repository_fk" FOREIGN KEY ("organization_id","project_id","repository_id") REFERENCES "public"."repositories"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_credential_fk" FOREIGN KEY ("organization_id","project_id","repository_id","credential_reference_id") REFERENCES "public"."credential_references"("organization_id","project_id","repository_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "landing_receipts" ADD CONSTRAINT "landing_receipts_candidate_fk" FOREIGN KEY ("organization_id","project_id","candidate_id") REFERENCES "public"."delivery_candidates"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "pull_request_receipts" ADD CONSTRAINT "pull_request_receipts_candidate_fk" FOREIGN KEY ("organization_id","project_id","candidate_id") REFERENCES "public"."delivery_candidates"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "push_receipts" ADD CONSTRAINT "push_receipts_candidate_fk" FOREIGN KEY ("organization_id","project_id","candidate_id") REFERENCES "public"."delivery_candidates"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_run_issue_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_id","run_id") REFERENCES "public"."runs"("organization_id","project_id","goal_id","issue_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_objects_scope_digest_uidx" ON "artifact_objects" USING btree ("organization_id","project_id","artifact_kind","digest");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_objects_scope_key_uidx" ON "artifact_objects" USING btree ("organization_id","project_id","object_key");--> statement-breakpoint
CREATE INDEX "artifact_objects_retention_idx" ON "artifact_objects" USING btree ("organization_id","retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_references_external_uidx" ON "credential_references" USING btree ("organization_id","project_id","repository_id","external_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_candidates_run_uidx" ON "delivery_candidates" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_candidates_branch_uidx" ON "delivery_candidates" USING btree ("organization_id","project_id","repository_id","branch");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_operation_receipts_candidate_key_uidx" ON "delivery_operation_receipts" USING btree ("candidate_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_policies_repository_revision_uidx" ON "delivery_policies" USING btree ("organization_id","project_id","repository_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "landing_receipts_candidate_operation_uidx" ON "landing_receipts" USING btree ("candidate_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "landing_receipts_candidate_uidx" ON "landing_receipts" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_receipts_candidate_operation_uidx" ON "pull_request_receipts" USING btree ("candidate_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_receipts_external_uidx" ON "pull_request_receipts" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_receipts_candidate_operation_uidx" ON "push_receipts" USING btree ("candidate_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "push_receipts_candidate_uidx" ON "push_receipts" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_run_idempotency_uidx" ON "reviews" USING btree ("organization_id","run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "reviews_commit_verdict_idx" ON "reviews" USING btree ("organization_id","project_id","issue_id","target_commit_sha","verdict");--> statement-breakpoint
CREATE TRIGGER artifact_objects_append_only
BEFORE UPDATE OR DELETE ON "artifact_objects"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER reviews_append_only
BEFORE UPDATE OR DELETE ON "reviews"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER delivery_policies_append_only
BEFORE UPDATE OR DELETE ON "delivery_policies"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER push_receipts_append_only
BEFORE UPDATE OR DELETE ON "push_receipts"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER landing_receipts_append_only
BEFORE UPDATE OR DELETE ON "landing_receipts"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER delivery_operation_receipts_append_only
BEFORE UPDATE OR DELETE ON "delivery_operation_receipts"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();
