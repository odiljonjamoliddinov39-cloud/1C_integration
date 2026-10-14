ALTER TABLE "ai_usage" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "first_token_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "attempts" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "rate_limited" integer;