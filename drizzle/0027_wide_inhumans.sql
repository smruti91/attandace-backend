CREATE TABLE "lksguard_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid,
	"action" varchar(40) NOT NULL,
	"resource_type" varchar(30),
	"resource_id" varchar(64),
	"employee_id" uuid,
	"device_id" varchar(64),
	"ip_address" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lksguard_call_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_uuid" varchar(36) NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"employee_id" uuid NOT NULL,
	"phone_number" varchar(20),
	"call_type" varchar(10) NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"server_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lksguard_call_type_valid" CHECK ("lksguard_call_records"."call_type" IN ('INCOMING','OUTGOING','MISSED'))
);
--> statement-breakpoint
CREATE TABLE "lksguard_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"employee_id" uuid NOT NULL,
	"contact_uuid" varchar(64) NOT NULL,
	"contact_name" varchar(200),
	"phone_number" varchar(20),
	"email" varchar(160),
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lksguard_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"employee_id" uuid,
	"phone" varchar(20),
	"device_name" varchar(120),
	"manufacturer" varchar(60),
	"model" varchar(60),
	"android_version" varchar(30),
	"app_version" varchar(30),
	"status" varchar(12) DEFAULT 'ACTIVE' NOT NULL,
	"perm_call" boolean DEFAULT false NOT NULL,
	"perm_sms" boolean DEFAULT false NOT NULL,
	"perm_contacts" boolean DEFAULT false NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lksguard_devices_device_id_unique" UNIQUE("device_id"),
	CONSTRAINT "lksguard_devices_status_valid" CHECK ("lksguard_devices"."status" IN ('ACTIVE','BLOCKED','DEACTIVATED'))
);
--> statement-breakpoint
CREATE TABLE "lksguard_employee_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"device_row_id" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lksguard_sms_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_uuid" varchar(36) NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"employee_id" uuid NOT NULL,
	"phone_number" varchar(20),
	"direction" varchar(10) NOT NULL,
	"message_timestamp" timestamp with time zone,
	"policy" varchar(20) DEFAULT 'SMS_METADATA_ONLY' NOT NULL,
	"content_cipher" text,
	"content_iv" text,
	"message_time" timestamp with time zone NOT NULL,
	"server_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lksguard_sms_direction_valid" CHECK ("lksguard_sms_records"."direction" IN ('SENT','RECEIVED')),
	CONSTRAINT "lksguard_sms_policy_valid" CHECK ("lksguard_sms_records"."policy" IN ('SMS_METADATA_ONLY','SMS_CONTENT'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lksguard_audit_logs" ADD CONSTRAINT "lksguard_audit_logs_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lksguard_audit_logs" ADD CONSTRAINT "lksguard_audit_logs_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lksguard_call_records" ADD CONSTRAINT "lksguard_call_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lksguard_contacts" ADD CONSTRAINT "lksguard_contacts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lksguard_devices" ADD CONSTRAINT "lksguard_devices_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lksguard_employee_devices" ADD CONSTRAINT "lksguard_employee_devices_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lksguard_employee_devices" ADD CONSTRAINT "lksguard_employee_devices_device_row_id_lksguard_devices_id_fk" FOREIGN KEY ("device_row_id") REFERENCES "public"."lksguard_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lksguard_employee_devices" ADD CONSTRAINT "lksguard_employee_devices_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lksguard_sms_records" ADD CONSTRAINT "lksguard_sms_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lksguard_audit_admin_idx" ON "lksguard_audit_logs" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "lksguard_audit_created_idx" ON "lksguard_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "lksguard_audit_action_idx" ON "lksguard_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "lksguard_call_dedup_idx" ON "lksguard_call_records" USING btree ("device_id","event_uuid");--> statement-breakpoint
CREATE INDEX "lksguard_call_employee_time_idx" ON "lksguard_call_records" USING btree ("employee_id","event_time");--> statement-breakpoint
CREATE INDEX "lksguard_call_device_idx" ON "lksguard_call_records" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lksguard_contacts_dedup_idx" ON "lksguard_contacts" USING btree ("device_id","contact_uuid");--> statement-breakpoint
CREATE INDEX "lksguard_contacts_employee_idx" ON "lksguard_contacts" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "lksguard_contacts_phone_idx" ON "lksguard_contacts" USING btree ("phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "lksguard_devices_device_id_idx" ON "lksguard_devices" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "lksguard_devices_employee_status_idx" ON "lksguard_devices" USING btree ("employee_id","status");--> statement-breakpoint
CREATE INDEX "lksguard_emp_dev_device_idx" ON "lksguard_employee_devices" USING btree ("device_row_id");--> statement-breakpoint
CREATE INDEX "lksguard_emp_dev_employee_idx" ON "lksguard_employee_devices" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lksguard_sms_dedup_idx" ON "lksguard_sms_records" USING btree ("device_id","event_uuid");--> statement-breakpoint
CREATE INDEX "lksguard_sms_employee_time_idx" ON "lksguard_sms_records" USING btree ("employee_id","message_time");--> statement-breakpoint
CREATE INDEX "lksguard_sms_device_idx" ON "lksguard_sms_records" USING btree ("device_id");