CREATE TABLE "app_settings" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_officer_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_officer_user_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_location_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"field_officer_user_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"latitude" numeric(10, 7) NOT NULL,
	"longitude" numeric(10, 7) NOT NULL,
	"accuracy" numeric(8, 2),
	"speed" numeric(8, 2),
	"battery_level" numeric(5, 2),
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_uuid" varchar(36) NOT NULL,
	CONSTRAINT "visit_points_lat_range" CHECK ("visit_location_points"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "visit_points_lng_range" CHECK ("visit_location_points"."longitude" BETWEEN -180 AND 180)
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_officer_user_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"check_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_in_latitude" numeric(10, 7),
	"check_in_longitude" numeric(10, 7),
	"check_out_at" timestamp with time zone,
	"check_out_latitude" numeric(10, 7),
	"check_out_longitude" numeric(10, 7),
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visits_status_valid" CHECK ("visits"."status" IN ('active', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "field_officer_sites" ADD CONSTRAINT "field_officer_sites_field_officer_user_id_users_id_fk" FOREIGN KEY ("field_officer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_officer_sites" ADD CONSTRAINT "field_officer_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_location_points" ADD CONSTRAINT "visit_location_points_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_location_points" ADD CONSTRAINT "visit_location_points_field_officer_user_id_users_id_fk" FOREIGN KEY ("field_officer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_location_points" ADD CONSTRAINT "visit_location_points_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_field_officer_user_id_users_id_fk" FOREIGN KEY ("field_officer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "field_officer_sites_pair_idx" ON "field_officer_sites" USING btree ("field_officer_user_id","site_id");--> statement-breakpoint
CREATE INDEX "field_officer_sites_officer_idx" ON "field_officer_sites" USING btree ("field_officer_user_id");--> statement-breakpoint
CREATE INDEX "field_officer_sites_site_idx" ON "field_officer_sites" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_points_dedup_idx" ON "visit_location_points" USING btree ("visit_id","client_uuid");--> statement-breakpoint
CREATE INDEX "visit_points_visit_recorded_idx" ON "visit_location_points" USING btree ("visit_id","recorded_at");--> statement-breakpoint
CREATE INDEX "visit_points_officer_idx" ON "visit_location_points" USING btree ("field_officer_user_id");--> statement-breakpoint
CREATE INDEX "visits_officer_checkin_idx" ON "visits" USING btree ("field_officer_user_id","check_in_at");--> statement-breakpoint
CREATE INDEX "visits_site_idx" ON "visits" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "visits_status_idx" ON "visits" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "visits_one_active_per_officer_idx" ON "visits" USING btree ("field_officer_user_id") WHERE "visits"."status" = 'active';