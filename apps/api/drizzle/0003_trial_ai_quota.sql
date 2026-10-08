-- AI tokens a trial account may use in its 14 days (input + output + cache), about $1-3 of Claude
-- usage. Per-account daily caps (AI_DAILY_TOKENS) apply on top.
UPDATE "plans" SET "ai_token_quota" = 1000000 WHERE "code" = 'trial' AND "ai_token_quota" = 0;
