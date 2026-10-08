CREATE TABLE "ai_answer_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"company" text NOT NULL,
	"question_hash" text NOT NULL,
	"normalized_question" text NOT NULL,
	"data_version" text NOT NULL,
	"answer" text NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"period" text NOT NULL,
	"limit_usd" numeric(12, 4),
	"used_usd" numeric(14, 6) DEFAULT 0 NOT NULL,
	"warned_at" timestamp with time zone,
	"blocked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid,
	"policy" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "metadata_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"company" text NOT NULL,
	"config_name" text NOT NULL,
	"config_version" text NOT NULL,
	"digest" text NOT NULL,
	"token_count" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"intents" jsonb NOT NULL,
	"onec_query" text NOT NULL,
	"params" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result_layout" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "query_templates_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "feature" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "route" text DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "tool_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "first_step" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "question" text;--> statement-breakpoint
ALTER TABLE "ai_answer_cache" ADD CONSTRAINT "ai_answer_cache_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_budgets" ADD CONSTRAINT "ai_budgets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_policies" ADD CONSTRAINT "ai_policies_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_policies" ADD CONSTRAINT "ai_policies_updated_by_admins_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_digests" ADD CONSTRAINT "metadata_digests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_templates" ADD CONSTRAINT "query_templates_updated_by_admins_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_answer_cache_key" ON "ai_answer_cache" USING btree ("account_id","company","question_hash","data_version");--> statement-breakpoint
CREATE INDEX "ai_answer_cache_expires_idx" ON "ai_answer_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_budgets_account_period_key" ON "ai_budgets" USING btree ("account_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_policies_plan_key" ON "ai_policies" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_policies_default_key" ON "ai_policies" USING btree ((1)) WHERE plan_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "metadata_digests_key" ON "metadata_digests" USING btree ("account_id","company","config_name","config_version");--> statement-breakpoint
CREATE INDEX "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");