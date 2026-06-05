CREATE TABLE "user_memory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"actor_user_id" text,
	"event_type" text NOT NULL,
	"metadata" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_memory_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_memory_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"body" text NOT NULL,
	"source_event_ids" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_memory_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_memory_reflections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"brief_id" text NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"prompt_metadata" jsonb,
	"source_observation_ids" jsonb NOT NULL,
	"proposed_actions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_memory_reflections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_memory_settings" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_memory_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_memory_events" ADD CONSTRAINT "user_memory_events_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_events" ADD CONSTRAINT "user_memory_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_events" ADD CONSTRAINT "user_memory_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_observations" ADD CONSTRAINT "user_memory_observations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_observations" ADD CONSTRAINT "user_memory_observations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_reflections" ADD CONSTRAINT "user_memory_reflections_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_reflections" ADD CONSTRAINT "user_memory_reflections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_settings" ADD CONSTRAINT "user_memory_settings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_settings" ADD CONSTRAINT "user_memory_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_memory_events_user_observed_idx" ON "user_memory_events" USING btree ("org_id","user_id","observed_at");--> statement-breakpoint
CREATE INDEX "user_memory_events_pending_idx" ON "user_memory_events" USING btree ("org_id","user_id","processed_at");--> statement-breakpoint
CREATE INDEX "user_memory_observations_user_created_idx" ON "user_memory_observations" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_memory_reflections_user_created_idx" ON "user_memory_reflections" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_memory_settings_user_uniq" ON "user_memory_settings" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE POLICY "user_memory_events_owner_isolation" ON "user_memory_events" AS PERMISSIVE FOR ALL TO "app_user" USING (org_id = current_setting('app.current_org_id', true) and user_id = current_setting('app.current_user_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true) and user_id = current_setting('app.current_user_id', true));--> statement-breakpoint
CREATE POLICY "user_memory_observations_owner_isolation" ON "user_memory_observations" AS PERMISSIVE FOR ALL TO "app_user" USING (org_id = current_setting('app.current_org_id', true) and user_id = current_setting('app.current_user_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true) and user_id = current_setting('app.current_user_id', true));--> statement-breakpoint
CREATE POLICY "user_memory_reflections_owner_isolation" ON "user_memory_reflections" AS PERMISSIVE FOR ALL TO "app_user" USING (org_id = current_setting('app.current_org_id', true) and user_id = current_setting('app.current_user_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true) and user_id = current_setting('app.current_user_id', true));--> statement-breakpoint
CREATE POLICY "user_memory_settings_owner_isolation" ON "user_memory_settings" AS PERMISSIVE FOR ALL TO "app_user" USING (org_id = current_setting('app.current_org_id', true) and user_id = current_setting('app.current_user_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true) and user_id = current_setting('app.current_user_id', true));
