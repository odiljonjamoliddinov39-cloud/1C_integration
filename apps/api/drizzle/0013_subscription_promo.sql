ALTER TABLE "subscriptions" ADD COLUMN "promo_code" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "promo_months_left" integer DEFAULT 0 NOT NULL;