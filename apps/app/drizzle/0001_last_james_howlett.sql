CREATE TABLE "folder_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"folder_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"permission" "permission" DEFAULT 'read' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folder_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"path" text NOT NULL,
	"repo_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "space_access_tenant_isolation" ON "space_access" CASCADE;--> statement-breakpoint
DROP TABLE "space_access" CASCADE;--> statement-breakpoint
ALTER TABLE "folder_access" ADD CONSTRAINT "folder_access_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_access" ADD CONSTRAINT "folder_access_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_access" ADD CONSTRAINT "folder_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folder_access_uniq" ON "folder_access" USING btree ("folder_id","user_id");--> statement-breakpoint
CREATE INDEX "folder_access_user_idx" ON "folder_access" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_space_slug_uniq" ON "folders" USING btree ("space_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_org_repo_uniq" ON "folders" USING btree ("org_id","repo_name");--> statement-breakpoint
CREATE INDEX "folders_space_idx" ON "folders" USING btree ("space_id");--> statement-breakpoint
ALTER TABLE "spaces" DROP COLUMN "path";--> statement-breakpoint
CREATE POLICY "folder_access_tenant_isolation" ON "folder_access" AS PERMISSIVE FOR ALL TO "app_user" USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "folders_tenant_isolation" ON "folders" AS PERMISSIVE FOR ALL TO "app_user" USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));