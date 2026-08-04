CREATE TABLE "clarification_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"previous_round_id" uuid,
	"regenerated_from_round_id" uuid,
	"source_goal_version" integer NOT NULL,
	"planner_run_id" text NOT NULL,
	"known_facts" jsonb NOT NULL,
	"uncertainties" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarification_rounds_goal_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "clarification_rounds_number_chk" CHECK ("clarification_rounds"."round_number" > 0),
	CONSTRAINT "clarification_rounds_goal_version_chk" CHECK ("clarification_rounds"."source_goal_version" > 0),
	CONSTRAINT "clarification_rounds_chain_chk" CHECK (("clarification_rounds"."round_number" = 1 AND "clarification_rounds"."previous_round_id" IS NULL AND "clarification_rounds"."regenerated_from_round_id" IS NULL) OR ("clarification_rounds"."round_number" > 1 AND "clarification_rounds"."previous_round_id" IS NOT NULL AND "clarification_rounds"."regenerated_from_round_id" IS NOT NULL)),
	CONSTRAINT "clarification_rounds_actor_chk" CHECK (char_length(btrim("clarification_rounds"."actor_id")) BETWEEN 1 AND 200),
	CONSTRAINT "clarification_rounds_reason_chk" CHECK (char_length(btrim("clarification_rounds"."reason")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_content_chk";--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "round_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "planner_question_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "rationale" text NOT NULL;--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "blocking_level" text NOT NULL;--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "answer_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "suggested_options" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "actor_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "reason" text NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "actor_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "clarification_rounds" ADD CONSTRAINT "clarification_rounds_goal_organization_fk" FOREIGN KEY ("organization_id","project_id","goal_id") REFERENCES "public"."goals"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "clarification_rounds" ADD CONSTRAINT "clarification_rounds_previous_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_round_id") REFERENCES "public"."clarification_rounds"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "clarification_rounds" ADD CONSTRAINT "clarification_rounds_regenerated_from_fk" FOREIGN KEY ("organization_id","project_id","goal_id","regenerated_from_round_id") REFERENCES "public"."clarification_rounds"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "clarification_rounds_goal_number_uidx" ON "clarification_rounds" USING btree ("organization_id","project_id","goal_id","round_number");--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_round_fk" FOREIGN KEY ("organization_id","project_id","goal_id","round_id") REFERENCES "public"."clarification_rounds"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_metadata_chk" CHECK (char_length(btrim("clarifications"."planner_question_id")) BETWEEN 1 AND 64 AND char_length(btrim("clarifications"."rationale")) BETWEEN 1 AND 4000 AND "clarifications"."blocking_level" IN ('blocker', 'high', 'medium', 'low') AND "clarifications"."answer_type" IN ('single_choice', 'multiple_choice', 'boolean', 'text', 'number'));--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_actor_chk" CHECK (char_length(btrim("clarifications"."actor_id")) BETWEEN 1 AND 200);--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_reason_chk" CHECK (char_length(btrim("clarifications"."reason")) BETWEEN 1 AND 4000);--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_content_chk" CHECK (char_length(btrim("decisions"."outcome")) BETWEEN 1 AND 4000 AND char_length(btrim("decisions"."actor_id")) BETWEEN 1 AND 200 AND char_length(btrim("decisions"."reason")) BETWEEN 1 AND 4000);--> statement-breakpoint
CREATE TRIGGER clarification_rounds_append_only
BEFORE UPDATE OR DELETE ON clarification_rounds
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();
