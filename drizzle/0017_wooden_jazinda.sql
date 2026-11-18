CREATE TABLE "fo_visit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracking_session_id" uuid,
	"visit_id" uuid,
	"field_officer_user_id" uuid NOT NULL,
	"event_type" varchar(24) NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"event_time" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracking_sessions" ADD COLUMN "checkout_type" varchar(16);--> statement-breakpoint
ALTER TABLE "fo_visit_events" ADD CONSTRAINT "fo_visit_events_tracking_session_id_tracking_sessions_id_fk" FOREIGN KEY ("tracking_session_id") REFERENCES "public"."tracking_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fo_visit_events" ADD CONSTRAINT "fo_visit_events_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fo_visit_events" ADD CONSTRAINT "fo_visit_events_field_officer_user_id_users_id_fk" FOREIGN KEY ("field_officer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fo_visit_events_session_idx" ON "fo_visit_events" USING btree ("tracking_session_id");--> statement-breakpoint
CREATE INDEX "fo_visit_events_officer_time_idx" ON "fo_visit_events" USING btree ("field_officer_user_id","event_time");--> statement-breakpoint
CREATE INDEX "fo_visit_events_type_idx" ON "fo_visit_events" USING btree ("event_type");