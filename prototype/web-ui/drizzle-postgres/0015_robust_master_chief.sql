CREATE TABLE "execution_command_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_id" text NOT NULL,
	"reason" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"operation" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_command_receipts_identity_chk" CHECK (char_length(btrim("execution_command_receipts"."actor_id")) BETWEEN 1 AND 200 AND char_length(btrim("execution_command_receipts"."idempotency_key")) BETWEEN 1 AND 200 AND char_length(btrim("execution_command_receipts"."request_id")) BETWEEN 1 AND 200 AND char_length(btrim("execution_command_receipts"."reason")) BETWEEN 1 AND 4000 AND "execution_command_receipts"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "execution_command_receipts_scope_chk" CHECK ("execution_command_receipts"."scope_type" IN ('global','project') AND char_length(btrim("execution_command_receipts"."scope_key")) BETWEEN 1 AND 200),
	CONSTRAINT "execution_command_receipts_operation_chk" CHECK ("execution_command_receipts"."operation" IN ('start','pause','drain','resume','retry','stop'))
);
--> statement-breakpoint
CREATE TABLE "execution_controls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"project_id" uuid,
	"scope_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"circuit_open_until" timestamp with time zone,
	"reason" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_controls_scope_chk" CHECK (("execution_controls"."scope_type" = 'global' AND "execution_controls"."scope_key" = 'global' AND "execution_controls"."organization_id" IS NULL AND "execution_controls"."project_id" IS NULL) OR ("execution_controls"."scope_type" = 'project' AND "execution_controls"."organization_id" IS NOT NULL AND "execution_controls"."project_id" IS NOT NULL AND "execution_controls"."scope_key" = "execution_controls"."project_id"::text)),
	CONSTRAINT "execution_controls_state_chk" CHECK ("execution_controls"."state" IN ('active','paused','draining','stopped')),
	CONSTRAINT "execution_controls_failure_chk" CHECK ("execution_controls"."consecutive_failures" >= 0),
	CONSTRAINT "execution_controls_reason_chk" CHECK (char_length(btrim("execution_controls"."reason")) BETWEEN 1 AND 4000),
	CONSTRAINT "execution_controls_version_chk" CHECK ("execution_controls"."version" > 0),
	CONSTRAINT "execution_controls_timestamps_chk" CHECK ("execution_controls"."updated_at" >= "execution_controls"."created_at")
);
--> statement-breakpoint
CREATE TABLE "execution_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "execution_leases_status_chk" CHECK ("execution_leases"."status" IN ('active','released','expired')),
	CONSTRAINT "execution_leases_identity_chk" CHECK (char_length(btrim("execution_leases"."owner_id")) BETWEEN 1 AND 200 AND "execution_leases"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "execution_leases_lifecycle_chk" CHECK ("execution_leases"."expires_at" > "execution_leases"."acquired_at" AND "execution_leases"."heartbeat_at" >= "execution_leases"."acquired_at" AND (("execution_leases"."status" = 'active' AND "execution_leases"."released_at" IS NULL) OR ("execution_leases"."status" <> 'active' AND "execution_leases"."released_at" IS NOT NULL))),
	CONSTRAINT "execution_leases_version_chk" CHECK ("execution_leases"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "execution_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrent_runs" integer NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"offline_after" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_nodes_identity_chk" CHECK (char_length(btrim("execution_nodes"."name")) BETWEEN 1 AND 200 AND char_length(btrim("execution_nodes"."provider")) BETWEEN 1 AND 100),
	CONSTRAINT "execution_nodes_capabilities_chk" CHECK (jsonb_typeof("execution_nodes"."capabilities") = 'array'),
	CONSTRAINT "execution_nodes_capacity_chk" CHECK ("execution_nodes"."max_concurrent_runs" > 0 AND "execution_nodes"."max_concurrent_runs" <= 1000),
	CONSTRAINT "execution_nodes_status_chk" CHECK ("execution_nodes"."status" IN ('online','draining','offline')),
	CONSTRAINT "execution_nodes_liveness_chk" CHECK ("execution_nodes"."offline_after" > "execution_nodes"."heartbeat_at"),
	CONSTRAINT "execution_nodes_version_chk" CHECK ("execution_nodes"."version" > 0),
	CONSTRAINT "execution_nodes_timestamps_chk" CHECK ("execution_nodes"."updated_at" >= "execution_nodes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "external_event_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"source" text DEFAULT 'autodev' NOT NULL,
	"source_event_id" text NOT NULL,
	"source_event_digest" text NOT NULL,
	"external_run_id" text NOT NULL,
	"external_task_id" text NOT NULL,
	"source_sequence" integer NOT NULL,
	"phase" text NOT NULL,
	"external_status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "external_event_inbox_schema_chk" CHECK ("external_event_inbox"."schema_version" = 'autodev.run-event.v1'),
	CONSTRAINT "external_event_inbox_digest_chk" CHECK ("external_event_inbox"."source_event_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "external_event_inbox_sequence_chk" CHECK ("external_event_inbox"."source_sequence" > 0),
	CONSTRAINT "external_event_inbox_status_chk" CHECK ("external_event_inbox"."processing_status" IN ('pending','applied','duplicate','gap','terminal_ignored','failed')),
	CONSTRAINT "external_event_inbox_lifecycle_chk" CHECK (("external_event_inbox"."processing_status" IN ('pending','gap') AND "external_event_inbox"."processed_at" IS NULL) OR ("external_event_inbox"."processing_status" NOT IN ('pending','gap') AND "external_event_inbox"."processed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "scheduler_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"external_task_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_run_id" text,
	"node_id" uuid,
	"lease_token_digest" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"last_event_sequence" integer DEFAULT 0 NOT NULL,
	"reconciliation_required" boolean DEFAULT false NOT NULL,
	"failure_code" text,
	"failure_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduler_jobs_scope_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "scheduler_jobs_state_chk" CHECK ("scheduler_jobs"."state" IN ('pending','claimed','starting','running','retry_wait','reconciling','succeeded','failed','cancelled','blocked')),
	CONSTRAINT "scheduler_jobs_attempt_chk" CHECK ("scheduler_jobs"."attempt" > 0 AND "scheduler_jobs"."max_attempts" >= "scheduler_jobs"."attempt"),
	CONSTRAINT "scheduler_jobs_sequence_chk" CHECK ("scheduler_jobs"."last_event_sequence" >= 0),
	CONSTRAINT "scheduler_jobs_identity_chk" CHECK (char_length(btrim("scheduler_jobs"."external_task_id")) BETWEEN 1 AND 128 AND ("scheduler_jobs"."external_run_id" IS NULL OR char_length(btrim("scheduler_jobs"."external_run_id")) BETWEEN 1 AND 128)),
	CONSTRAINT "scheduler_jobs_version_chk" CHECK ("scheduler_jobs"."version" > 0),
	CONSTRAINT "scheduler_jobs_timestamps_chk" CHECK ("scheduler_jobs"."deadline_at" > "scheduler_jobs"."created_at" AND "scheduler_jobs"."updated_at" >= "scheduler_jobs"."created_at")
);
--> statement-breakpoint
ALTER TABLE "execution_controls" ADD CONSTRAINT "execution_controls_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "execution_leases" ADD CONSTRAINT "execution_leases_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "execution_leases" ADD CONSTRAINT "execution_leases_node_fk" FOREIGN KEY ("node_id") REFERENCES "public"."execution_nodes"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "external_event_inbox" ADD CONSTRAINT "external_event_inbox_job_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scheduler_jobs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "external_event_inbox" ADD CONSTRAINT "external_event_inbox_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "scheduler_jobs" ADD CONSTRAINT "scheduler_jobs_run_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_id","run_id") REFERENCES "public"."runs"("organization_id","project_id","goal_id","issue_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "scheduler_jobs" ADD CONSTRAINT "scheduler_jobs_node_fk" FOREIGN KEY ("node_id") REFERENCES "public"."execution_nodes"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_command_receipts_actor_key_uidx" ON "execution_command_receipts" USING btree ("actor_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_controls_scope_uidx" ON "execution_controls" USING btree ("scope_type","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_leases_active_run_uidx" ON "execution_leases" USING btree ("run_id") WHERE "execution_leases"."status" = 'active';--> statement-breakpoint
CREATE INDEX "execution_leases_active_node_idx" ON "execution_leases" USING btree ("node_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_nodes_name_uidx" ON "execution_nodes" USING btree ("name");--> statement-breakpoint
CREATE INDEX "execution_nodes_provider_status_idx" ON "execution_nodes" USING btree ("provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "external_event_inbox_source_event_uidx" ON "external_event_inbox" USING btree ("source","source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_event_inbox_run_sequence_uidx" ON "external_event_inbox" USING btree ("source","external_run_id","source_sequence");--> statement-breakpoint
CREATE INDEX "external_event_inbox_pending_idx" ON "external_event_inbox" USING btree ("processing_status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduler_jobs_run_uidx" ON "scheduler_jobs" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduler_jobs_external_run_uidx" ON "scheduler_jobs" USING btree ("external_run_id");--> statement-breakpoint
CREATE INDEX "scheduler_jobs_claim_idx" ON "scheduler_jobs" USING btree ("state","next_attempt_at","priority","created_at");--> statement-breakpoint
CREATE INDEX "scheduler_jobs_reconcile_idx" ON "scheduler_jobs" USING btree ("reconciliation_required","state","updated_at");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_goal_id_uidx" UNIQUE("organization_id","project_id","goal_id","id");