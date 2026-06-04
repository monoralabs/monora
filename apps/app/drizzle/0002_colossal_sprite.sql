CREATE TABLE "access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"hashed_secret" text NOT NULL,
	"scopes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_tokens_prefix_idx" ON "access_tokens" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "access_tokens_subject_idx" ON "access_tokens" USING btree ("org_id","subject_id");--> statement-breakpoint
CREATE POLICY "access_tokens_tenant_isolation" ON "access_tokens" AS PERMISSIVE FOR ALL TO "app_user" USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));