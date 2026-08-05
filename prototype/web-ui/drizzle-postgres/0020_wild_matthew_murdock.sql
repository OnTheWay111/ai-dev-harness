CREATE TABLE "production_gate_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"gate_id" text NOT NULL,
	"status" text DEFAULT 'passed' NOT NULL,
	"owner_role" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"checked_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_gate_checks_gate_chk" CHECK ("production_gate_checks"."gate_id" IN ('browser-e2e','identity-security','autodev-authorization','model-routing-write','supply-chain','git-traceability','recovery-stop','observability-oncall','canary-goal-verification','defect-budget') AND "production_gate_checks"."status"='passed'),
	CONSTRAINT "production_gate_checks_role_chk" CHECK ("production_gate_checks"."owner_role" IN ('security','operations','product','project-owner') AND jsonb_typeof("production_gate_checks"."evidence_refs")='array' AND jsonb_array_length("production_gate_checks"."evidence_refs") > 0 AND char_length(btrim("production_gate_checks"."checked_by")) BETWEEN 1 AND 200 AND "production_gate_checks"."updated_at" >= "production_gate_checks"."created_at")
);
--> statement-breakpoint
CREATE TABLE "production_release_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"role" text NOT NULL,
	"signer_id" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"decision" text DEFAULT 'approved' NOT NULL,
	"reason" text NOT NULL,
	"authentication_method" text DEFAULT 'oidc' NOT NULL,
	"request_id" text NOT NULL,
	"audit_receipt_id" uuid NOT NULL,
	"attestation_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_release_signatures_role_chk" CHECK ("production_release_signatures"."role" IN ('security','operations','product','project-owner') AND "production_release_signatures"."decision"='approved' AND "production_release_signatures"."authentication_method"='oidc'),
	CONSTRAINT "production_release_signatures_identity_chk" CHECK (char_length(btrim("production_release_signatures"."signer_id")) BETWEEN 1 AND 200 AND char_length(btrim("production_release_signatures"."reason")) BETWEEN 20 AND 4000 AND char_length(btrim("production_release_signatures"."request_id")) BETWEEN 1 AND 200 AND "production_release_signatures"."attestation_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "production_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"canary_id" uuid NOT NULL,
	"candidate_commit" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"canary_report" jsonb NOT NULL,
	"defects" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone,
	"attestation_digest" text,
	"report" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_releases_scope_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "production_releases_status_chk" CHECK ("production_releases"."status" IN ('draft','awaiting_signatures','approved')),
	CONSTRAINT "production_releases_identity_chk" CHECK ("production_releases"."candidate_commit" ~ '^[0-9a-f]{40}$' AND "production_releases"."version" > 0 AND char_length(btrim("production_releases"."created_by")) BETWEEN 1 AND 200 AND jsonb_typeof("production_releases"."canary_report")='object' AND jsonb_typeof("production_releases"."defects")='object'),
	CONSTRAINT "production_releases_evaluation_chk" CHECK (("production_releases"."status"='draft' AND "production_releases"."evaluated_at" IS NULL AND "production_releases"."attestation_digest" IS NULL AND "production_releases"."report" IS NULL) OR ("production_releases"."status" IN ('awaiting_signatures','approved') AND "production_releases"."evaluated_at" IS NOT NULL AND "production_releases"."attestation_digest" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("production_releases"."report")='object')),
	CONSTRAINT "production_releases_time_chk" CHECK ("production_releases"."updated_at" >= "production_releases"."created_at" AND ("production_releases"."evaluated_at" IS NULL OR "production_releases"."evaluated_at" >= "production_releases"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "release_canaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"candidate_commit" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"goal_contract_version" integer NOT NULL,
	"allowed_areas" jsonb NOT NULL,
	"excluded_areas" jsonb NOT NULL,
	"success_conditions" jsonb NOT NULL,
	"stop_conditions" jsonb NOT NULL,
	"rollback_runbook" text NOT NULL,
	"stop_runbook" text NOT NULL,
	"owner_id" text,
	"approved_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"report" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_canaries_scope_id_uidx" UNIQUE("organization_id","project_id","goal_id","id"),
	CONSTRAINT "release_canaries_status_chk" CHECK ("release_canaries"."status" IN ('draft','observing','stopped','passed')),
	CONSTRAINT "release_canaries_identity_chk" CHECK ("release_canaries"."candidate_commit" ~ '^[0-9a-f]{40}$' AND "release_canaries"."attempt" > 0 AND "release_canaries"."goal_contract_version" > 0 AND "release_canaries"."version" > 0 AND char_length(btrim("release_canaries"."created_by")) BETWEEN 1 AND 200),
	CONSTRAINT "release_canaries_scope_chk" CHECK (jsonb_typeof("release_canaries"."allowed_areas")='array' AND jsonb_array_length("release_canaries"."allowed_areas") BETWEEN 1 AND 100 AND jsonb_typeof("release_canaries"."excluded_areas")='array' AND jsonb_array_length("release_canaries"."excluded_areas") BETWEEN 1 AND 100 AND jsonb_typeof("release_canaries"."success_conditions")='array' AND jsonb_array_length("release_canaries"."success_conditions") BETWEEN 1 AND 100 AND jsonb_typeof("release_canaries"."stop_conditions")='array' AND jsonb_array_length("release_canaries"."stop_conditions") BETWEEN 1 AND 100),
	CONSTRAINT "release_canaries_lifecycle_chk" CHECK (("release_canaries"."status"='draft' AND "release_canaries"."owner_id" IS NULL AND "release_canaries"."approved_at" IS NULL AND "release_canaries"."started_at" IS NULL AND "release_canaries"."report" IS NULL) OR ("release_canaries"."status"='observing' AND "release_canaries"."owner_id" IS NOT NULL AND "release_canaries"."approved_at" IS NOT NULL AND "release_canaries"."started_at" IS NOT NULL AND "release_canaries"."ended_at" IS NULL AND "release_canaries"."report" IS NULL) OR ("release_canaries"."status"='stopped' AND "release_canaries"."owner_id" IS NOT NULL AND "release_canaries"."approved_at" IS NOT NULL AND "release_canaries"."started_at" IS NOT NULL AND "release_canaries"."ended_at" IS NOT NULL AND "release_canaries"."report" IS NULL) OR ("release_canaries"."status"='passed' AND "release_canaries"."owner_id" IS NOT NULL AND "release_canaries"."approved_at" IS NOT NULL AND "release_canaries"."started_at" IS NOT NULL AND "release_canaries"."ended_at" IS NOT NULL AND jsonb_typeof("release_canaries"."report")='object')),
	CONSTRAINT "release_canaries_time_chk" CHECK ("release_canaries"."updated_at" >= "release_canaries"."created_at" AND ("release_canaries"."approved_at" IS NULL OR "release_canaries"."approved_at" >= "release_canaries"."created_at") AND ("release_canaries"."started_at" IS NULL OR "release_canaries"."started_at" >= "release_canaries"."approved_at") AND ("release_canaries"."ended_at" IS NULL OR "release_canaries"."ended_at" >= "release_canaries"."started_at"))
);
--> statement-breakpoint
CREATE TABLE "release_canary_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"canary_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text,
	"observed_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_canary_events_kind_chk" CHECK ("release_canary_events"."kind" IN ('defect','alert','intervention') AND (("release_canary_events"."kind"='intervention' AND "release_canary_events"."severity" IS NULL) OR ("release_canary_events"."kind"<>'intervention' AND "release_canary_events"."severity" IN ('P0','P1','P2','P3')))),
	CONSTRAINT "release_canary_events_payload_chk" CHECK ("release_canary_events"."attempt" > 0 AND jsonb_typeof("release_canary_events"."payload")='object' AND char_length(btrim("release_canary_events"."event_key")) BETWEEN 1 AND 128 AND char_length(btrim("release_canary_events"."recorded_by")) BETWEEN 1 AND 200 AND "release_canary_events"."updated_at" >= "release_canary_events"."created_at")
);
--> statement-breakpoint
CREATE TABLE "release_canary_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"canary_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"sequence" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"p0_count" integer DEFAULT 0 NOT NULL,
	"p1_count" integer DEFAULT 0 NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_canary_windows_state_chk" CHECK ("release_canary_windows"."attempt" > 0 AND "release_canary_windows"."sequence" > 0 AND "release_canary_windows"."status" IN ('healthy','unhealthy') AND "release_canary_windows"."p0_count" >= 0 AND "release_canary_windows"."p1_count" >= 0),
	CONSTRAINT "release_canary_windows_time_chk" CHECK ("release_canary_windows"."ended_at" > "release_canary_windows"."started_at" AND "release_canary_windows"."ended_at" <= "release_canary_windows"."started_at" + interval '1 hour'),
	CONSTRAINT "release_canary_windows_evidence_chk" CHECK (jsonb_typeof("release_canary_windows"."evidence_refs")='array' AND jsonb_array_length("release_canary_windows"."evidence_refs") > 0 AND char_length(btrim("release_canary_windows"."recorded_by")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "production_gate_checks" ADD CONSTRAINT "production_gate_checks_release_fk" FOREIGN KEY ("organization_id","project_id","goal_id","release_id") REFERENCES "public"."production_releases"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "production_release_signatures" ADD CONSTRAINT "production_release_signatures_release_fk" FOREIGN KEY ("organization_id","project_id","goal_id","release_id") REFERENCES "public"."production_releases"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "production_release_signatures" ADD CONSTRAINT "production_release_signatures_audit_receipt_fk" FOREIGN KEY ("audit_receipt_id") REFERENCES "public"."audit_events"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "production_releases" ADD CONSTRAINT "production_releases_canary_fk" FOREIGN KEY ("organization_id","project_id","goal_id","canary_id") REFERENCES "public"."release_canaries"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "release_canaries" ADD CONSTRAINT "release_canaries_goal_fk" FOREIGN KEY ("organization_id","project_id","goal_id") REFERENCES "public"."goals"("organization_id","project_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "release_canary_events" ADD CONSTRAINT "release_canary_events_canary_fk" FOREIGN KEY ("organization_id","project_id","goal_id","canary_id") REFERENCES "public"."release_canaries"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "release_canary_windows" ADD CONSTRAINT "release_canary_windows_canary_fk" FOREIGN KEY ("organization_id","project_id","goal_id","canary_id") REFERENCES "public"."release_canaries"("organization_id","project_id","goal_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "production_gate_checks_release_gate_uidx" ON "production_gate_checks" USING btree ("release_id","gate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_release_signatures_release_role_uidx" ON "production_release_signatures" USING btree ("release_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "production_release_signatures_release_signer_uidx" ON "production_release_signatures" USING btree ("release_id","signer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_releases_canary_uidx" ON "production_releases" USING btree ("canary_id");--> statement-breakpoint
CREATE INDEX "production_releases_project_status_idx" ON "production_releases" USING btree ("organization_id","project_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "release_canaries_project_status_idx" ON "release_canaries" USING btree ("organization_id","project_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "release_canary_events_attempt_key_uidx" ON "release_canary_events" USING btree ("canary_id","attempt","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "release_canary_windows_attempt_sequence_uidx" ON "release_canary_windows" USING btree ("canary_id","attempt","sequence");--> statement-breakpoint
CREATE TRIGGER release_canary_windows_append_only
BEFORE UPDATE OR DELETE ON "release_canary_windows"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE TRIGGER production_release_signatures_append_only
BEFORE UPDATE OR DELETE ON "production_release_signatures"
FOR EACH ROW EXECUTE FUNCTION prevent_planning_history_mutation();--> statement-breakpoint
CREATE FUNCTION prevent_locked_production_gate_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	release_status text;
BEGIN
	SELECT status INTO release_status
	FROM production_releases
	WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.release_id ELSE NEW.release_id END;
	IF release_status IS DISTINCT FROM 'draft' THEN
		RAISE EXCEPTION 'production gate evidence is locked' USING ERRCODE = '55000';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER production_gate_checks_lock_after_evaluation
BEFORE INSERT OR UPDATE OR DELETE ON "production_gate_checks"
FOR EACH ROW EXECUTE FUNCTION prevent_locked_production_gate_mutation();
