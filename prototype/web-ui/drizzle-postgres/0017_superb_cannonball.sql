CREATE TABLE "task_action_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_id" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"task_version" integer NOT NULL,
	"result_task_version" integer,
	"error" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_action_receipts_status_chk" CHECK ("task_action_receipts"."status" IN ('accepted','running','completed','failed')),
	CONSTRAINT "task_action_receipts_action_chk" CHECK ("task_action_receipts"."action" IN ('review_evidence','answer_questions','resolve_blocker','inspect_schedule','inspect_run')),
	CONSTRAINT "task_action_receipts_identity_chk" CHECK (char_length(btrim("task_action_receipts"."task_id")) BETWEEN 1 AND 128 AND char_length(btrim("task_action_receipts"."goal_id")) BETWEEN 1 AND 128 AND char_length(btrim("task_action_receipts"."actor_id")) BETWEEN 1 AND 200 AND char_length(btrim("task_action_receipts"."idempotency_key")) BETWEEN 8 AND 200 AND "task_action_receipts"."request_hash" ~ '^[0-9a-f]{64}$' AND char_length(btrim("task_action_receipts"."request_id")) BETWEEN 1 AND 200 AND char_length(btrim("task_action_receipts"."reason")) BETWEEN 1 AND 4000),
	CONSTRAINT "task_action_receipts_version_chk" CHECK ("task_action_receipts"."task_version" > 0 AND "task_action_receipts"."version" > 0 AND ("task_action_receipts"."result_task_version" IS NULL OR "task_action_receipts"."result_task_version" >= "task_action_receipts"."task_version")),
	CONSTRAINT "task_action_receipts_lifecycle_chk" CHECK ((("task_action_receipts"."status" IN ('accepted','running') AND "task_action_receipts"."completed_at" IS NULL) OR ("task_action_receipts"."status" IN ('completed','failed') AND "task_action_receipts"."completed_at" IS NOT NULL)) AND ("task_action_receipts"."status"='failed' OR "task_action_receipts"."error" IS NULL) AND "task_action_receipts"."updated_at" >= "task_action_receipts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "workbench_projection_checkpoints" (
	"scope_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"snapshot_digest" text NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_event_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbench_projection_checkpoints_scope_id_organization_id_project_id_pk" PRIMARY KEY("scope_id","organization_id","project_id"),
	CONSTRAINT "workbench_projection_checkpoints_revision_chk" CHECK ("workbench_projection_checkpoints"."revision" > 0),
	CONSTRAINT "workbench_projection_checkpoints_digest_chk" CHECK ("workbench_projection_checkpoints"."snapshot_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workbench_projection_checkpoints_cursor_chk" CHECK (("workbench_projection_checkpoints"."last_event_at" IS NULL AND "workbench_projection_checkpoints"."last_event_id" IS NULL) OR ("workbench_projection_checkpoints"."last_event_at" IS NOT NULL AND "workbench_projection_checkpoints"."last_event_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "task_action_receipts" ADD CONSTRAINT "task_action_receipts_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "workbench_projection_checkpoints" ADD CONSTRAINT "workbench_projection_checkpoints_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "task_action_receipts_actor_endpoint_key_uidx" ON "task_action_receipts" USING btree ("organization_id","actor_id","task_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "task_action_receipts_task_status_idx" ON "task_action_receipts" USING btree ("organization_id","project_id","task_id","status");