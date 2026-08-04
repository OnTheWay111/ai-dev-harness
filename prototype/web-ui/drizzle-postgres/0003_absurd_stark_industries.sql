CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"goal_id" uuid,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_version" integer NOT NULL,
	"reason" text NOT NULL,
	"request_id" text NOT NULL,
	"details_ref" text,
	"details_digest" text,
	"retention_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_scope_chk" CHECK ("audit_events"."goal_id" IS NULL OR "audit_events"."project_id" IS NOT NULL),
	CONSTRAINT "audit_events_identity_chk" CHECK (char_length(btrim("audit_events"."actor_id")) BETWEEN 1 AND 200 AND char_length(btrim("audit_events"."action")) BETWEEN 1 AND 200 AND char_length(btrim("audit_events"."entity_type")) BETWEEN 1 AND 100 AND "audit_events"."entity_version" > 0 AND char_length(btrim("audit_events"."reason")) BETWEEN 1 AND 4000 AND char_length(btrim("audit_events"."request_id")) BETWEEN 1 AND 200),
	CONSTRAINT "audit_events_details_chk" CHECK ((("audit_events"."details_ref" IS NULL AND "audit_events"."details_digest" IS NULL) OR (char_length(btrim("audit_events"."details_ref")) BETWEEN 1 AND 1000 AND "audit_events"."details_digest" ~ '^[0-9a-f]{64}$')) AND "audit_events"."retention_until" > "audit_events"."created_at")
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"artifact_ref" text NOT NULL,
	"digest" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_kind_chk" CHECK ("evidence"."kind" IN ('artifact', 'log', 'test', 'review', 'commit', 'push')),
	CONSTRAINT "evidence_digest_chk" CHECK ("evidence"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_metadata_chk" CHECK (char_length(btrim("evidence"."artifact_ref")) BETWEEN 1 AND 1000 AND char_length(btrim("evidence"."media_type")) BETWEEN 1 AND 200 AND "evidence"."size_bytes" >= 0 AND "evidence"."retention_until" > "evidence"."created_at")
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_ref" text,
	"response_digest" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_status_chk" CHECK ("idempotency_records"."status" IN ('in_progress', 'completed', 'failed')),
	CONSTRAINT "idempotency_records_identity_chk" CHECK (char_length(btrim("idempotency_records"."actor_id")) BETWEEN 1 AND 200 AND char_length(btrim("idempotency_records"."endpoint")) BETWEEN 1 AND 300 AND char_length("idempotency_records"."key") BETWEEN 1 AND 200 AND "idempotency_records"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_records_response_chk" CHECK (("idempotency_records"."status" = 'in_progress' AND "idempotency_records"."response_status" IS NULL AND "idempotency_records"."response_ref" IS NULL AND "idempotency_records"."response_digest" IS NULL) OR ("idempotency_records"."status" IN ('completed', 'failed') AND "idempotency_records"."response_status" BETWEEN 100 AND 599 AND char_length(btrim("idempotency_records"."response_ref")) BETWEEN 1 AND 1000 AND "idempotency_records"."response_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "idempotency_records_expiry_chk" CHECK ("idempotency_records"."expires_at" > "idempotency_records"."created_at" AND "idempotency_records"."updated_at" >= "idempotency_records"."created_at")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer NOT NULL,
	"event_type" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"last_error_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_status_chk" CHECK ("outbox_events"."status" IN ('pending', 'published', 'failed')),
	CONSTRAINT "outbox_events_state_chk" CHECK ("outbox_events"."aggregate_version" > 0 AND "outbox_events"."attempts" >= 0 AND (("outbox_events"."status" = 'published' AND "outbox_events"."published_at" IS NOT NULL) OR ("outbox_events"."status" <> 'published' AND "outbox_events"."published_at" IS NULL))),
	CONSTRAINT "outbox_events_identity_chk" CHECK (char_length(btrim("outbox_events"."aggregate_type")) BETWEEN 1 AND 100 AND char_length(btrim("outbox_events"."event_type")) BETWEEN 1 AND 200 AND char_length(btrim("outbox_events"."deduplication_key")) BETWEEN 1 AND 300 AND ("outbox_events"."last_error_ref" IS NULL OR char_length(btrim("outbox_events"."last_error_ref")) BETWEEN 1 AND 1000)),
	CONSTRAINT "outbox_events_timestamps_order_chk" CHECK ("outbox_events"."updated_at" >= "outbox_events"."created_at")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"request_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_issue_id_uidx" UNIQUE("organization_id","project_id","goal_id","issue_id","id"),
	CONSTRAINT "runs_attempt_positive_chk" CHECK ("runs"."attempt" > 0),
	CONSTRAINT "runs_status_chk" CHECK ("runs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "runs_lifecycle_chk" CHECK (("runs"."status" = 'queued' AND "runs"."started_at" IS NULL AND "runs"."finished_at" IS NULL) OR ("runs"."status" = 'running' AND "runs"."started_at" IS NOT NULL AND "runs"."finished_at" IS NULL) OR ("runs"."status" IN ('succeeded', 'failed') AND "runs"."started_at" IS NOT NULL AND "runs"."finished_at" >= "runs"."started_at") OR ("runs"."status" = 'cancelled' AND "runs"."finished_at" IS NOT NULL AND ("runs"."started_at" IS NULL OR "runs"."finished_at" >= "runs"."started_at"))),
	CONSTRAINT "runs_identity_version_chk" CHECK (char_length(btrim("runs"."request_id")) BETWEEN 1 AND 200 AND "runs"."version" > 0),
	CONSTRAINT "runs_timestamps_order_chk" CHECK ("runs"."updated_at" >= "runs"."created_at")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_organization_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_goal_organization_fk" FOREIGN KEY ("organization_id","project_id","goal_id") REFERENCES "public"."goals"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_issue_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_id","run_id") REFERENCES "public"."runs"("organization_id","project_id","goal_id","issue_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_issue_goal_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_id") REFERENCES "public"."issues"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "audit_events_organization_created_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("organization_id","entity_type","entity_id","entity_version");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_run_kind_digest_uidx" ON "evidence" USING btree ("organization_id","project_id","goal_id","run_id","kind","digest");--> statement-breakpoint
CREATE INDEX "evidence_retention_idx" ON "evidence" USING btree ("organization_id","retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_scope_key_uidx" ON "idempotency_records" USING btree ("organization_id","actor_id","endpoint","key");--> statement-breakpoint
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_organization_dedupe_uidx" ON "outbox_events" USING btree ("organization_id","deduplication_key");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_aggregate_version_uidx" ON "outbox_events" USING btree ("organization_id","aggregate_type","aggregate_id","aggregate_version","event_type");--> statement-breakpoint
CREATE INDEX "outbox_events_dispatch_idx" ON "outbox_events" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_issue_attempt_uidx" ON "runs" USING btree ("organization_id","project_id","goal_id","issue_id","attempt");--> statement-breakpoint
CREATE INDEX "runs_status_updated_idx" ON "runs" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE TRIGGER evidence_append_only
BEFORE UPDATE OR DELETE ON "evidence"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();
