CREATE TABLE "workbench_snapshots" (
	"scope_id" text PRIMARY KEY NOT NULL,
	"revision" bigint NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"summary" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workbench_tasks" (
	"scope_id" text NOT NULL,
	"task_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"priority" text NOT NULL,
	"stage" text NOT NULL,
	"attention_required" boolean NOT NULL,
	"rank" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbench_tasks_scope_id_task_id_pk" PRIMARY KEY("scope_id","task_id")
);
--> statement-breakpoint
CREATE INDEX "workbench_tasks_scope_rank_idx" ON "workbench_tasks" USING btree ("scope_id","rank");--> statement-breakpoint
CREATE INDEX "workbench_tasks_scope_goal_idx" ON "workbench_tasks" USING btree ("scope_id","goal_id");--> statement-breakpoint
CREATE INDEX "workbench_tasks_scope_stage_idx" ON "workbench_tasks" USING btree ("scope_id","stage");--> statement-breakpoint
CREATE INDEX "workbench_tasks_scope_attention_idx" ON "workbench_tasks" USING btree ("scope_id","attention_required");