CREATE TABLE "clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_clarification_id" uuid,
	"status" text NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"source_goal_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarifications_goal_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "clarifications_status_chk" CHECK ("clarifications"."status" IN ('open', 'answered', 'superseded')),
	CONSTRAINT "clarifications_revision_chain_chk" CHECK ("clarifications"."revision" > 0 AND (("clarifications"."revision" = 1 AND "clarifications"."previous_clarification_id" IS NULL) OR ("clarifications"."revision" > 1 AND "clarifications"."previous_clarification_id" IS NOT NULL))),
	CONSTRAINT "clarifications_content_chk" CHECK (char_length(btrim("clarifications"."question")) BETWEEN 1 AND 4000 AND (("clarifications"."status" = 'open' AND "clarifications"."answer" IS NULL) OR ("clarifications"."status" IN ('answered', 'superseded') AND char_length(btrim("clarifications"."answer")) BETWEEN 1 AND 10000))),
	CONSTRAINT "clarifications_source_goal_version_chk" CHECK ("clarifications"."source_goal_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"decision_key" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_decision_id" uuid,
	"status" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_version" integer NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_goal_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "decisions_status_chk" CHECK ("decisions"."status" IN ('proposed', 'approved', 'rejected', 'superseded')),
	CONSTRAINT "decisions_subject_type_chk" CHECK ("decisions"."subject_type" IN ('clarification', 'spec_revision', 'issue_plan')),
	CONSTRAINT "decisions_revision_chain_chk" CHECK ("decisions"."revision" > 0 AND (("decisions"."revision" = 1 AND "decisions"."previous_decision_id" IS NULL) OR ("decisions"."revision" > 1 AND "decisions"."previous_decision_id" IS NOT NULL))),
	CONSTRAINT "decisions_subject_version_chk" CHECK ("decisions"."subject_version" > 0),
	CONSTRAINT "decisions_content_chk" CHECK (char_length(btrim("decisions"."outcome")) BETWEEN 1 AND 4000 AND char_length(btrim("decisions"."reason")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "issue_dependencies" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"depends_on_issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_dependencies_pk" PRIMARY KEY("organization_id","project_id","goal_id","issue_id","depends_on_issue_id"),
	CONSTRAINT "issue_dependencies_not_self_chk" CHECK ("issue_dependencies"."issue_id" <> "issue_dependencies"."depends_on_issue_id")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"spec_revision_id" uuid NOT NULL,
	"issue_key" text NOT NULL,
	"revision" integer NOT NULL,
	"previous_issue_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"body_ref" text NOT NULL,
	"body_digest" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_goal_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "issues_status_chk" CHECK ("issues"."status" IN ('draft', 'approved', 'ready', 'in_progress', 'blocked', 'completed', 'cancelled')),
	CONSTRAINT "issues_revision_chain_chk" CHECK ("issues"."revision" > 0 AND (("issues"."revision" = 1 AND "issues"."previous_issue_id" IS NULL) OR ("issues"."revision" > 1 AND "issues"."previous_issue_id" IS NOT NULL))),
	CONSTRAINT "issues_identity_chk" CHECK (char_length("issues"."issue_key") BETWEEN 1 AND 64 AND "issues"."issue_key" ~ '^[A-Z][A-Z0-9-]*$' AND char_length(btrim("issues"."title")) BETWEEN 1 AND 300),
	CONSTRAINT "issues_artifact_chk" CHECK (char_length(btrim("issues"."body_ref")) BETWEEN 1 AND 1000 AND "issues"."body_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "issues_version_positive_chk" CHECK ("issues"."version" > 0),
	CONSTRAINT "issues_timestamps_order_chk" CHECK ("issues"."updated_at" >= "issues"."created_at")
);
--> statement-breakpoint
CREATE TABLE "spec_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_revision_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_goal_version" integer NOT NULL,
	"artifact_ref" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_revisions_goal_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "spec_revisions_status_chk" CHECK ("spec_revisions"."status" IN ('draft', 'in_review', 'approved', 'rejected', 'superseded')),
	CONSTRAINT "spec_revisions_revision_chain_chk" CHECK ("spec_revisions"."revision" > 0 AND (("spec_revisions"."revision" = 1 AND "spec_revisions"."previous_revision_id" IS NULL) OR ("spec_revisions"."revision" > 1 AND "spec_revisions"."previous_revision_id" IS NOT NULL))),
	CONSTRAINT "spec_revisions_artifact_chk" CHECK (char_length(btrim("spec_revisions"."artifact_ref")) BETWEEN 1 AND 1000 AND "spec_revisions"."artifact_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "spec_revisions_versions_chk" CHECK ("spec_revisions"."source_goal_version" > 0 AND "spec_revisions"."version" > 0),
	CONSTRAINT "spec_revisions_timestamps_order_chk" CHECK ("spec_revisions"."updated_at" >= "spec_revisions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_goal_organization_fk" FOREIGN KEY ("organization_id","project_id","goal_id") REFERENCES "public"."goals"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_previous_revision_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_clarification_id") REFERENCES "public"."clarifications"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_goal_organization_fk" FOREIGN KEY ("organization_id","project_id","goal_id") REFERENCES "public"."goals"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_previous_revision_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_decision_id") REFERENCES "public"."decisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_issue_goal_fk" FOREIGN KEY ("organization_id","project_id","goal_id","issue_id") REFERENCES "public"."issues"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_depends_on_goal_fk" FOREIGN KEY ("organization_id","project_id","goal_id","depends_on_issue_id") REFERENCES "public"."issues"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_spec_revision_goal_fk" FOREIGN KEY ("organization_id","project_id","goal_id","spec_revision_id") REFERENCES "public"."spec_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_previous_revision_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_issue_id") REFERENCES "public"."issues"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD CONSTRAINT "spec_revisions_goal_organization_fk" FOREIGN KEY ("organization_id","project_id","goal_id") REFERENCES "public"."goals"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD CONSTRAINT "spec_revisions_previous_revision_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_revision_id") REFERENCES "public"."spec_revisions"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "clarifications_goal_thread_revision_uidx" ON "clarifications" USING btree ("organization_id","project_id","goal_id","thread_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_goal_key_revision_uidx" ON "decisions" USING btree ("organization_id","project_id","goal_id","decision_key","revision");--> statement-breakpoint
CREATE INDEX "issue_dependencies_depends_on_idx" ON "issue_dependencies" USING btree ("organization_id","project_id","goal_id","depends_on_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_goal_key_revision_uidx" ON "issues" USING btree ("organization_id","project_id","goal_id","issue_key","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_revisions_goal_revision_uidx" ON "spec_revisions" USING btree ("organization_id","project_id","goal_id","revision");--> statement-breakpoint
CREATE FUNCTION prevent_planning_history_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'planning history is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER clarifications_append_only
BEFORE UPDATE OR DELETE ON "clarifications"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER decisions_append_only
BEFORE UPDATE OR DELETE ON "decisions"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();
