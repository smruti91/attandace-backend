CREATE TABLE "tracking_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_officer_user_id" uuid NOT NULL,
	"face_check_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"face_check_in_latitude" numeric(10, 7),
	"face_check_in_longitude" numeric(10, 7),
	"face_check_in_accuracy" numeric(8, 2),
	"face_check_out_at" timestamp with time zone,
	"face_check_out_latitude" numeric(10, 7),
	"face_check_out_longitude" numeric(10, 7),
	"face_check_out_accuracy" numeric(8, 2),
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_sessions_status_valid" CHECK ("tracking_sessions"."status" IN ('active', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "visit_location_points" ALTER COLUMN "visit_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "visit_location_points" ADD COLUMN "tracking_session_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_location_points" ADD COLUMN "heading" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "tracking_session_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "check_in_source" varchar(8);--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "check_out_source" varchar(8);--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "check_in_accuracy" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "check_out_accuracy" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "last_inside_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "first_outside_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracking_sessions" ADD CONSTRAINT "tracking_sessions_field_officer_user_id_users_id_fk" FOREIGN KEY ("field_officer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracking_sessions_officer_checkin_idx" ON "tracking_sessions" USING btree ("field_officer_user_id","face_check_in_at");--> statement-breakpoint
CREATE INDEX "tracking_sessions_status_idx" ON "tracking_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_sessions_one_active_idx" ON "tracking_sessions" USING btree ("field_officer_user_id") WHERE "tracking_sessions"."status" = 'active';--> statement-breakpoint
ALTER TABLE "visit_location_points" ADD CONSTRAINT "visit_location_points_tracking_session_id_tracking_sessions_id_fk" FOREIGN KEY ("tracking_session_id") REFERENCES "public"."tracking_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_tracking_session_id_tracking_sessions_id_fk" FOREIGN KEY ("tracking_session_id") REFERENCES "public"."tracking_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_points_session_dedup_idx" ON "visit_location_points" USING btree ("tracking_session_id","client_uuid");--> statement-breakpoint
CREATE INDEX "visit_points_session_recorded_idx" ON "visit_location_points" USING btree ("tracking_session_id","recorded_at");--> statement-breakpoint
CREATE INDEX "visits_session_idx" ON "visits" USING btree ("tracking_session_id");