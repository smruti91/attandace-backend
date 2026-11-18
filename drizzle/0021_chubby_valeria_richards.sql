ALTER TABLE "attendance_logs" ADD COLUMN "incomplete_reason" text;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "incomplete_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "incomplete_by" uuid;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_incomplete_by_users_id_fk" FOREIGN KEY ("incomplete_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;