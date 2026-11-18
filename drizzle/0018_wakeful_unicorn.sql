ALTER TABLE "attendance_logs" ADD COLUMN "supervisor_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "attendance_method" varchar(10);--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "image_path" varchar(500);--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "attendance_date" date DEFAULT CURRENT_DATE;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_supervisor_id_users_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "attendance_logs" SET "attendance_date" = ((created_at AT TIME ZONE 'Asia/Kolkata'))::date WHERE "attendance_date" IS NULL OR TRUE;--> statement-breakpoint
CREATE INDEX "att_logs_employee_attdate_idx" ON "attendance_logs" USING btree ("employee_id","attendance_date");--> statement-breakpoint
CREATE INDEX "att_logs_supervisor_idx" ON "attendance_logs" USING btree ("supervisor_id");