-- Rename the workspace concept Space -> Brain (product vocabulary). Pure rename,
-- no data loss: the table, its column on folders, indexes, FK and RLS policy are
-- renamed in place. folders/folder_access keep their names.
ALTER TABLE "spaces" RENAME TO "brains";
--> statement-breakpoint
ALTER TABLE "folders" RENAME COLUMN "space_id" TO "brain_id";
--> statement-breakpoint
ALTER INDEX "spaces_org_slug_uniq" RENAME TO "brains_org_slug_uniq";
--> statement-breakpoint
ALTER INDEX "folders_space_slug_uniq" RENAME TO "folders_brain_slug_uniq";
--> statement-breakpoint
ALTER INDEX "folders_space_idx" RENAME TO "folders_brain_idx";
--> statement-breakpoint
ALTER TABLE "brains" RENAME CONSTRAINT "spaces_org_id_organization_id_fk" TO "brains_org_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "folders" RENAME CONSTRAINT "folders_space_id_spaces_id_fk" TO "folders_brain_id_brains_id_fk";
--> statement-breakpoint
ALTER POLICY "spaces_tenant_isolation" ON "brains" RENAME TO "brains_tenant_isolation";
