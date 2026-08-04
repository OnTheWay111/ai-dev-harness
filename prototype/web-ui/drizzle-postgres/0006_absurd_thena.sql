-- Workbench projections are rebuildable. Clear legacy rows before making
-- tenant ownership mandatory so no row can survive without an Organization
-- and Project boundary.
TRUNCATE TABLE "workbench_tasks", "workbench_snapshots";--> statement-breakpoint
DROP INDEX "workbench_tasks_scope_rank_idx";--> statement-breakpoint
DROP INDEX "workbench_tasks_scope_goal_idx";--> statement-breakpoint
DROP INDEX "workbench_tasks_scope_stage_idx";--> statement-breakpoint
DROP INDEX "workbench_tasks_scope_attention_idx";--> statement-breakpoint
ALTER TABLE "workbench_tasks" DROP CONSTRAINT "workbench_tasks_scope_id_task_id_pk";--> statement-breakpoint
ALTER TABLE "workbench_snapshots" DROP CONSTRAINT "workbench_snapshots_pkey";--> statement-breakpoint
ALTER TABLE "workbench_snapshots" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "workbench_snapshots" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "workbench_tasks" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "workbench_tasks" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "workbench_snapshots" ADD CONSTRAINT "workbench_snapshots_scope_id_organization_id_project_id_pk" PRIMARY KEY("scope_id","organization_id","project_id");--> statement-breakpoint
ALTER TABLE "workbench_tasks" ADD CONSTRAINT "workbench_tasks_scope_id_organization_id_project_id_task_id_pk" PRIMARY KEY("scope_id","organization_id","project_id","task_id");--> statement-breakpoint
CREATE INDEX "workbench_snapshots_visibility_idx" ON "workbench_snapshots" USING btree ("scope_id","organization_id","project_id");--> statement-breakpoint
CREATE INDEX "workbench_tasks_scope_rank_idx" ON "workbench_tasks" USING btree ("scope_id","organization_id","project_id","rank");--> statement-breakpoint
CREATE INDEX "workbench_tasks_scope_goal_idx" ON "workbench_tasks" USING btree ("scope_id","organization_id","project_id","goal_id");--> statement-breakpoint
CREATE INDEX "workbench_tasks_scope_stage_idx" ON "workbench_tasks" USING btree ("scope_id","organization_id","project_id","stage");--> statement-breakpoint
CREATE INDEX "workbench_tasks_scope_attention_idx" ON "workbench_tasks" USING btree ("scope_id","organization_id","project_id","attention_required");
