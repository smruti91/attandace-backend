CREATE TABLE "role_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" varchar(30) NOT NULL,
	"pages" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_pages_role_unique" UNIQUE("role")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "role_pages_role_idx" ON "role_pages" USING btree ("role");