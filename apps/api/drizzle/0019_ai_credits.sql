CREATE TABLE "credit_accounts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"balance_credits" numeric(16, 4) DEFAULT 0 NOT NULL,
	"rollover_cap_credits" integer DEFAULT 50000 NOT NULL,
	"auto_enabled" boolean DEFAULT false NOT NULL,
	"auto_threshold" integer DEFAULT 300 NOT NULL,
	"auto_amount" integer DEFAULT 1000 NOT NULL,
	"auto_method" text,
	"auto_card_token" text,
	"low_warned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_rate_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"old_som_per_credit" integer NOT NULL,
	"new_som_per_credit" integer NOT NULL,
	"cbu_rate" numeric(12, 2) NOT NULL,
	"set_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_recharge_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_credits" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_credits" numeric(16, 4) NOT NULL,
	"balance_after" numeric(16, 4) NOT NULL,
	"related_usage_id" uuid,
	"period_key" text,
	"note" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "monthly_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_recharge_failures" ADD CONSTRAINT "credit_recharge_failures_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_recharge_failures_idx" ON "credit_recharge_failures" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "credit_transactions_account_idx" ON "credit_transactions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_period_key" ON "credit_transactions" USING btree ("account_id","type","period_key");--> statement-breakpoint
UPDATE "plans" SET "monthly_credits" = 500 WHERE "code" = 'free';--> statement-breakpoint
UPDATE "plans" SET "monthly_credits" = 3040 WHERE "code" = 'start';--> statement-breakpoint
UPDATE "plans" SET "monthly_credits" = 8110 WHERE "code" = 'business';--> statement-breakpoint
UPDATE "plans" SET "monthly_credits" = 19930 WHERE "code" = 'firm';--> statement-breakpoint
INSERT INTO "credit_rate_history" ("old_som_per_credit", "new_som_per_credit", "cbu_rate", "set_by", "note") VALUES (120, 120, 11839.00, 'system', 'The starting price: 1 credit = $0.01');
