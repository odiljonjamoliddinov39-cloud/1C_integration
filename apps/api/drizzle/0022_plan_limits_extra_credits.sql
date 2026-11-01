ALTER TABLE "credit_accounts" ADD COLUMN "extra_credits" numeric(16, 4) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD COLUMN "extra_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "pool" text DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "daily_limit_pct" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "weekly_limit_pct" integer DEFAULT 35 NOT NULL;