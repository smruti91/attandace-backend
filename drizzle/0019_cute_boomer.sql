CREATE TABLE "shift_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"supervisor_id" uuid,
	"attendance_date" date DEFAULT CURRENT_DATE NOT NULL,
	"shift" varchar(10) NOT NULL,
	"present_employees" integer NOT NULL,
	"description" text,
	"image_path" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_attendance_shift_valid" CHECK ("shift_attendance"."shift" IN ('morning','day','night','general')),
	CONSTRAINT "shift_attendance_present_valid" CHECK ("shift_attendance"."present_employees" > 0 AND "shift_attendance"."present_employees" <= 5000)
);
--> statement-breakpoint
ALTER TABLE "shift_attendance" ADD CONSTRAINT "shift_attendance_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_attendance" ADD CONSTRAINT "shift_attendance_supervisor_id_users_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_attendance_site_date_shift_idx" ON "shift_attendance" USING btree ("site_id","attendance_date","shift");--> statement-breakpoint
CREATE INDEX "shift_attendance_site_date_idx" ON "shift_attendance" USING btree ("site_id","attendance_date");--> statement-breakpoint
CREATE INDEX "shift_attendance_supervisor_idx" ON "shift_attendance" USING btree ("supervisor_id");