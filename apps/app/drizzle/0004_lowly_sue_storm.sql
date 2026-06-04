CREATE TABLE "brain_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brain_id" uuid NOT NULL,
	"label" text,
	"created_by" text,
	"entries" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brain_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brain_snapshots" ADD CONSTRAINT "brain_snapshots_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_snapshots" ADD CONSTRAINT "brain_snapshots_brain_id_brains_id_fk" FOREIGN KEY ("brain_id") REFERENCES "public"."brains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_snapshots" ADD CONSTRAINT "brain_snapshots_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_snapshots_brain_idx" ON "brain_snapshots" USING btree ("org_id","brain_id","created_at");--> statement-breakpoint
CREATE POLICY "brain_snapshots_tenant_isolation" ON "brain_snapshots" AS PERMISSIVE FOR ALL TO "app_user" USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));