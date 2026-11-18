CREATE TABLE "site_location_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_location_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"submitted_by" uuid,
	"latitude" numeric(10, 7) NOT NULL,
	"longitude" numeric(10, 7) NOT NULL,
	"accuracy" numeric(8, 2),
	"previous_latitude" numeric(10, 7),
	"previous_longitude" numeric(10, 7),
	"status" varchar(12) DEFAULT 'PENDING' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	CONSTRAINT "site_location_submissions_status_valid" CHECK ("site_location_submissions"."status" IN ('PENDING','APPROVED','REJECTED')),
	CONSTRAINT "site_location_submissions_lat_range" CHECK ("site_location_submissions"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "site_location_submissions_lng_range" CHECK ("site_location_submissions"."longitude" BETWEEN -180 AND 180)
);
--> statement-breakpoint
ALTER TABLE "site_location_submissions" ADD CONSTRAINT "site_location_submissions_client_location_id_client_locations_id_fk" FOREIGN KEY ("client_location_id") REFERENCES "public"."client_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_location_submissions" ADD CONSTRAINT "site_location_submissions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_location_submissions" ADD CONSTRAINT "site_location_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_location_submissions" ADD CONSTRAINT "site_location_submissions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_location_submissions_site_idx" ON "site_location_submissions" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "site_location_submissions_status_idx" ON "site_location_submissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "site_location_submissions_submitter_idx" ON "site_location_submissions" USING btree ("submitted_by");--> statement-breakpoint
CREATE INDEX "site_location_submissions_submitted_at_idx" ON "site_location_submissions" USING btree ("submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_location_submissions_pending_idx" ON "site_location_submissions" USING btree ("site_id") WHERE "site_location_submissions"."status" = 'PENDING';