CREATE TABLE "role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_id" text NOT NULL,
	"role" text NOT NULL,
	"assigned_by_actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"request_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_bindings_scope_chk" CHECK (("role_bindings"."role" = 'organization_owner' AND "role_bindings"."project_id" IS NULL) OR ("role_bindings"."role" = 'project_admin' AND "role_bindings"."project_id" IS NOT NULL) OR "role_bindings"."role" IN ('approver', 'operator', 'viewer')),
	CONSTRAINT "role_bindings_identity_chk" CHECK (char_length(btrim("role_bindings"."actor_id")) BETWEEN 1 AND 200 AND char_length(btrim("role_bindings"."assigned_by_actor_id")) BETWEEN 1 AND 200 AND char_length(btrim("role_bindings"."reason")) BETWEEN 1 AND 4000 AND char_length(btrim("role_bindings"."request_id")) BETWEEN 1 AND 200 AND "role_bindings"."version" > 0),
	CONSTRAINT "role_bindings_lifecycle_chk" CHECK ("role_bindings"."updated_at" >= "role_bindings"."created_at" AND ("role_bindings"."revoked_at" IS NULL OR "role_bindings"."revoked_at" >= "role_bindings"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_project_organization_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "role_bindings_active_organization_uidx" ON "role_bindings" USING btree ("organization_id","actor_id","role") WHERE "role_bindings"."project_id" IS NULL AND "role_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_bindings_active_project_uidx" ON "role_bindings" USING btree ("organization_id","project_id","actor_id","role") WHERE "role_bindings"."project_id" IS NOT NULL AND "role_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "role_bindings_actor_scope_idx" ON "role_bindings" USING btree ("actor_id","organization_id","project_id");