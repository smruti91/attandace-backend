CREATE TABLE "co_fo_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"co_user_id" uuid NOT NULL,
	"fo_user_id" uuid NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "co_fo_assignments_not_self" CHECK ("co_fo_assignments"."co_user_id" <> "co_fo_assignments"."fo_user_id"),
	CONSTRAINT "co_fo_assignments_active_no_end" CHECK (("co_fo_assignments"."is_active" = true AND "co_fo_assignments"."removed_at" IS NULL) OR ("co_fo_assignments"."is_active" = false AND "co_fo_assignments"."removed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "co_fo_assignments" ADD CONSTRAINT "co_fo_assignments_co_user_id_users_id_fk" FOREIGN KEY ("co_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "co_fo_assignments" ADD CONSTRAINT "co_fo_assignments_fo_user_id_users_id_fk" FOREIGN KEY ("fo_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "co_fo_assignments" ADD CONSTRAINT "co_fo_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "co_fo_assignments_active_pair_idx" ON "co_fo_assignments" USING btree ("co_user_id","fo_user_id") WHERE "co_fo_assignments"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "co_fo_assignments_active_fo_idx" ON "co_fo_assignments" USING btree ("fo_user_id") WHERE "co_fo_assignments"."is_active" = true;--> statement-breakpoint
CREATE INDEX "co_fo_assignments_co_idx" ON "co_fo_assignments" USING btree ("co_user_id");--> statement-breakpoint
CREATE INDEX "co_fo_assignments_fo_idx" ON "co_fo_assignments" USING btree ("fo_user_id");