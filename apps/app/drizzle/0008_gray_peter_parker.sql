ALTER TABLE "folders" ADD COLUMN "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;