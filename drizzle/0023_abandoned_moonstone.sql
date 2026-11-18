CREATE TABLE "employee_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"supervisor_id" uuid,
	"violation_type" varchar(40) NOT NULL,
	"reason" text NOT NULL,
	"violation_date" date DEFAULT CURRENT_DATE NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "violations_type_valid" CHECK ("employee_violations"."violation_type" IN ('late_arrival','unauthorized_absence','leaving_duty_post','leaving_site_without_permission','sleeping_during_duty','negligence_of_duty','failure_security_procedure','failure_vigilance','failure_patrol','failure_register_log','unauthorized_visitor_handling','improper_uniform_id','inappropriate_conduct','violation_client_site_rules','unauthorized_access','improper_handling_property','equipment_misuse','failure_report_incident','other'))
);
--> statement-breakpoint
ALTER TABLE "employee_violations" ADD CONSTRAINT "employee_violations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_violations" ADD CONSTRAINT "employee_violations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_violations" ADD CONSTRAINT "employee_violations_supervisor_id_users_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "violations_site_date_idx" ON "employee_violations" USING btree ("site_id","violation_date");--> statement-breakpoint
CREATE INDEX "violations_employee_idx" ON "employee_violations" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "violations_supervisor_idx" ON "employee_violations" USING btree ("supervisor_id");