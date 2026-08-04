CREATE TABLE "acceptance_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"statement" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acceptance_criteria_position_positive_chk" CHECK ("acceptance_criteria"."position" > 0),
	CONSTRAINT "acceptance_criteria_statement_length_chk" CHECK (char_length(btrim("acceptance_criteria"."statement")) BETWEEN 1 AND 2000),
	CONSTRAINT "acceptance_criteria_version_positive_chk" CHECK ("acceptance_criteria"."version" > 0),
	CONSTRAINT "acceptance_criteria_timestamps_order_chk" CHECK ("acceptance_criteria"."updated_at" >= "acceptance_criteria"."created_at")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"problem_statement" text NOT NULL,
	"desired_outcome" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_organization_project_id_uidx" UNIQUE("organization_id","project_id","id"),
	CONSTRAINT "goals_title_length_chk" CHECK (char_length(btrim("goals"."title")) BETWEEN 1 AND 200),
	CONSTRAINT "goals_problem_length_chk" CHECK (char_length(btrim("goals"."problem_statement")) BETWEEN 1 AND 10000),
	CONSTRAINT "goals_outcome_length_chk" CHECK (char_length(btrim("goals"."desired_outcome")) BETWEEN 1 AND 10000),
	CONSTRAINT "goals_version_positive_chk" CHECK ("goals"."version" > 0),
	CONSTRAINT "goals_timestamps_order_chk" CHECK ("goals"."updated_at" >= "goals"."created_at")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_format_chk" CHECK (char_length("organizations"."slug") BETWEEN 1 AND 64 AND ("organizations"."slug" ~ '^[a-z]$' OR "organizations"."slug" ~ '^[a-z][a-z0-9-]*[a-z0-9]$')),
	CONSTRAINT "organizations_name_length_chk" CHECK (char_length(btrim("organizations"."name")) BETWEEN 1 AND 200),
	CONSTRAINT "organizations_version_positive_chk" CHECK ("organizations"."version" > 0),
	CONSTRAINT "organizations_timestamps_order_chk" CHECK ("organizations"."updated_at" >= "organizations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_organization_id_id_uidx" UNIQUE("organization_id","id"),
	CONSTRAINT "projects_slug_format_chk" CHECK (char_length("projects"."slug") BETWEEN 1 AND 64 AND ("projects"."slug" ~ '^[a-z]$' OR "projects"."slug" ~ '^[a-z][a-z0-9-]*[a-z0-9]$')),
	CONSTRAINT "projects_name_length_chk" CHECK (char_length(btrim("projects"."name")) BETWEEN 1 AND 200),
	CONSTRAINT "projects_version_positive_chk" CHECK ("projects"."version" > 0),
	CONSTRAINT "projects_timestamps_order_chk" CHECK ("projects"."updated_at" >= "projects"."created_at")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_repository_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_provider_chk" CHECK ("repositories"."provider" IN ('github')),
	CONSTRAINT "repositories_identity_length_chk" CHECK (char_length(btrim("repositories"."provider_repository_id")) BETWEEN 1 AND 200 AND char_length(btrim("repositories"."owner")) BETWEEN 1 AND 200 AND char_length(btrim("repositories"."name")) BETWEEN 1 AND 200),
	CONSTRAINT "repositories_default_branch_length_chk" CHECK (char_length(btrim("repositories"."default_branch")) BETWEEN 1 AND 255),
	CONSTRAINT "repositories_version_positive_chk" CHECK ("repositories"."version" > 0),
	CONSTRAINT "repositories_timestamps_order_chk" CHECK ("repositories"."updated_at" >= "repositories"."created_at")
);
--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_goal_organization_fk" FOREIGN KEY ("organization_id","project_id","goal_id") REFERENCES "public"."goals"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_organization_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_organization_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "acceptance_criteria_goal_position_uidx" ON "acceptance_criteria" USING btree ("organization_id","project_id","goal_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uidx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_organization_slug_uidx" ON "projects" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_organization_project_id_uidx" ON "repositories" USING btree ("organization_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_project_provider_id_uidx" ON "repositories" USING btree ("organization_id","project_id","provider","provider_repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_project_owner_name_uidx" ON "repositories" USING btree ("organization_id","project_id","provider","owner","name");