CREATE TABLE "password_reset_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"employee_id" uuid,
	"status" varchar(12) DEFAULT 'PENDING' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processed_by" uuid,
	"remarks" text,
	CONSTRAINT "password_reset_requests_status_valid" CHECK ("password_reset_requests"."status" IN ('PENDING','APPROVED','COMPLETED','REJECTED'))
);
--> statement-breakpoint
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_reset_requests_user_idx" ON "password_reset_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_requests_status_idx" ON "password_reset_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "password_reset_requests_requested_at_idx" ON "password_reset_requests" USING btree ("requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_requests_pending_idx" ON "password_reset_requests" USING btree ("user_id") WHERE "password_reset_requests"."status" = 'PENDING';