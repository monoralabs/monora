CREATE TYPE "public"."device_flow_status" AS ENUM('pending', 'approved', 'claimed', 'denied');--> statement-breakpoint
CREATE TABLE "device_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"status" "device_flow_status" DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_flows" ADD CONSTRAINT "device_flows_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_flows" ADD CONSTRAINT "device_flows_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_flows_device_code_uniq" ON "device_flows" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "device_flows_user_code_uniq" ON "device_flows" USING btree ("user_code");