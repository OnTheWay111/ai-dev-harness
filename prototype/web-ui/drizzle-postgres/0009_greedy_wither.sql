CREATE TABLE "classification_policy_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"revision" integer NOT NULL,
	"previous_policy_revision_id" uuid,
	"schema_version" text NOT NULL,
	"digest" text NOT NULL,
	"definition" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_policy_revisions_revision_chk" CHECK ("classification_policy_revisions"."revision" > 0 AND (("classification_policy_revisions"."revision" = 1 AND "classification_policy_revisions"."previous_policy_revision_id" IS NULL) OR ("classification_policy_revisions"."revision" > 1 AND "classification_policy_revisions"."previous_policy_revision_id" IS NOT NULL))),
	CONSTRAINT "classification_policy_revisions_key_chk" CHECK (char_length(btrim("classification_policy_revisions"."policy_key")) BETWEEN 1 AND 100),
	CONSTRAINT "classification_policy_revisions_schema_chk" CHECK (char_length(btrim("classification_policy_revisions"."schema_version")) BETWEEN 1 AND 100),
	CONSTRAINT "classification_policy_revisions_digest_chk" CHECK ("classification_policy_revisions"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "classification_policy_revisions_actor_chk" CHECK (char_length(btrim("classification_policy_revisions"."actor_id")) BETWEEN 1 AND 200),
	CONSTRAINT "classification_policy_revisions_reason_chk" CHECK (char_length(btrim("classification_policy_revisions"."reason")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_classification_id" uuid,
	"source_goal_version" integer NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"size" text NOT NULL,
	"risk" text NOT NULL,
	"size_score" integer NOT NULL,
	"risk_score" integer NOT NULL,
	"matched_factors" jsonb NOT NULL,
	"required_artifacts" jsonb NOT NULL,
	"required_approver_roles" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classifications_goal_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "classifications_revision_chain_chk" CHECK ("classifications"."revision" > 0 AND (("classifications"."revision" = 1 AND "classifications"."previous_classification_id" IS NULL) OR ("classifications"."revision" > 1 AND "classifications"."previous_classification_id" IS NOT NULL))),
	CONSTRAINT "classifications_goal_version_chk" CHECK ("classifications"."source_goal_version" > 0),
	CONSTRAINT "classifications_size_chk" CHECK ("classifications"."size" IN ('S','M','L','XL')),
	CONSTRAINT "classifications_risk_chk" CHECK ("classifications"."risk" IN ('low','medium','high')),
	CONSTRAINT "classifications_scores_chk" CHECK ("classifications"."size_score" >= 0 AND "classifications"."risk_score" >= 0),
	CONSTRAINT "classifications_actor_chk" CHECK (char_length(btrim("classifications"."actor_id")) BETWEEN 1 AND 200),
	CONSTRAINT "classifications_reason_chk" CHECK (char_length(btrim("classifications"."reason")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "classification_policy_revisions" ADD CONSTRAINT "classification_policy_revisions_previous_fk" FOREIGN KEY ("previous_policy_revision_id") REFERENCES "public"."classification_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_goal_organization_fk" FOREIGN KEY ("organization_id","project_id","goal_id") REFERENCES "public"."goals"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_previous_fk" FOREIGN KEY ("organization_id","project_id","goal_id","previous_classification_id") REFERENCES "public"."classifications"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_policy_revision_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."classification_policy_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "classification_policy_revisions_key_revision_uidx" ON "classification_policy_revisions" USING btree ("policy_key","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "classification_policy_revisions_digest_uidx" ON "classification_policy_revisions" USING btree ("digest");--> statement-breakpoint
CREATE UNIQUE INDEX "classifications_goal_revision_uidx" ON "classifications" USING btree ("organization_id","project_id","goal_id","revision");--> statement-breakpoint
CREATE TRIGGER classification_policy_revisions_append_only
BEFORE UPDATE OR DELETE ON classification_policy_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER classifications_append_only
BEFORE UPDATE OR DELETE ON classifications
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();
