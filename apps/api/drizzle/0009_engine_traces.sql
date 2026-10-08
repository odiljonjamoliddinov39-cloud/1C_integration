CREATE TABLE "ai_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid,
	"company" text NOT NULL,
	"question" text NOT NULL,
	"outcome" text NOT NULL,
	"steps" jsonb NOT NULL,
	"learnable" jsonb,
	"group_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"company" text NOT NULL,
	"group_key" text NOT NULL,
	"phrase" text NOT NULL,
	"question" text NOT NULL,
	"action" text,
	"hits" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "query_templates" ADD COLUMN "action" jsonb;--> statement-breakpoint
ALTER TABLE "ai_traces" ADD CONSTRAINT "ai_traces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_traces" ADD CONSTRAINT "ai_traces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_groups" ADD CONSTRAINT "template_groups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_traces_account_idx" ON "ai_traces" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_traces_group_idx" ON "ai_traces" USING btree ("account_id","group_key");--> statement-breakpoint
CREATE UNIQUE INDEX "template_groups_key" ON "template_groups" USING btree ("account_id","company","group_key");