ALTER TABLE "spec_revisions" DROP CONSTRAINT "spec_revisions_artifact_chk";--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "artifact_media_type" text DEFAULT 'application/json' NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "artifact_size_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "planner_run_id" text DEFAULT 'legacy-migration' NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "planner_configuration" jsonb DEFAULT '{"adapter":"legacy","modelProfile":"unknown","schemaVersion":"spec-bundle.v1"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "generated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD CONSTRAINT "spec_revisions_planner_metadata_chk" CHECK (char_length(btrim("spec_revisions"."planner_run_id")) BETWEEN 1 AND 200 AND "spec_revisions"."generated_at" >= "spec_revisions"."created_at");--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD CONSTRAINT "spec_revisions_artifact_chk" CHECK (char_length(btrim("spec_revisions"."artifact_ref")) BETWEEN 1 AND 1000 AND "spec_revisions"."artifact_digest" ~ '^[0-9a-f]{64}$' AND "spec_revisions"."artifact_media_type" = 'application/json' AND "spec_revisions"."artifact_size_bytes" >= 0);