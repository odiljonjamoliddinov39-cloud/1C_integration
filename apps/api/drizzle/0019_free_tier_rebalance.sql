-- Free tier rebalance (docs/free-tier-tz.md). Three changes, all data-only:
--   1. imports_per_month on Free drops 30 -> 10, matching ai_questions_per_month: an import is
--      itself an AI question, so the old 30 was never reachable in practice and only confused
--      people reading the pricing page.
--   2. The Free AI-cost fence widens 3 -> 5 USD/month, 1.5 -> 2 USD/day-per-user, so it does not
--      bind before the 10-question count does on a normal mix of questions (see the doc for the
--      cost math); the count stays the one limit people actually see.
--   3. A small one-off AI-question credit pack, buyable on every plan including Free (entitlements.ts
--      and invoicing.ts now apply and allow one_off add-ons regardless of plan state).
--> statement-breakpoint
UPDATE "plans" SET "imports_per_month" = 10 WHERE "code" = 'free';
--> statement-breakpoint
UPDATE "ai_policies" SET "policy" = '{"monthlyLimitUsd": 5, "dailyLimitUsdPerUser": 2, "onLimit": "block"}'::jsonb
WHERE "plan_id" = (SELECT "id" FROM "plans" WHERE "code" = 'free');
--> statement-breakpoint
INSERT INTO "addons" ("code", "name", "price_sum", "kind", "allowed_plans", "grants")
VALUES
  ('addon_ai_5', 'Extra 5 AI questions', 25000, 'one_off', ARRAY['free','start','business','firm'], '{"aiQuestions": 5}')
ON CONFLICT ("code") DO NOTHING;
