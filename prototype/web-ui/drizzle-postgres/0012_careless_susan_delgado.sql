ALTER TABLE "decisions" DROP CONSTRAINT "decisions_content_chk";--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "request_id" text DEFAULT 'legacy-migration' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "policy_revision" text DEFAULT 'legacy-policy' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "affected_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "decision_payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_content_chk" CHECK (char_length(btrim("decisions"."outcome")) BETWEEN 1 AND 4000 AND char_length(btrim("decisions"."actor_id")) BETWEEN 1 AND 200 AND char_length(btrim("decisions"."reason")) BETWEEN 1 AND 4000 AND char_length(btrim("decisions"."request_id")) BETWEEN 1 AND 200 AND char_length(btrim("decisions"."policy_revision")) BETWEEN 1 AND 100);