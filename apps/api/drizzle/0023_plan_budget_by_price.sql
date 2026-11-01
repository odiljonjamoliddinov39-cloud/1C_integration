ALTER TABLE "credit_requests" ADD COLUMN "paid_sum" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Requests made before top-ups were by sum: they were paid at the price of the credits.
UPDATE "credit_requests" SET "paid_sum" = "credits" * "som_per_credit" WHERE "paid_sum" = 0;--> statement-breakpoint
-- Free has a small fixed AI budget a month and no day or week limit.
UPDATE "plans" SET "daily_limit_pct" = 0, "weekly_limit_pct" = 0 WHERE "code" = 'free';--> statement-breakpoint
-- "Extra 100 AI questions" cost more than 45% of its price: the extra balance replaces it (existing purchases stay valid).
UPDATE "addons" SET "is_public" = false WHERE "code" = 'addon_ai_100';
