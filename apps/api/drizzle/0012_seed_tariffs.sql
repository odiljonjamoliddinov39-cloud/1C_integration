-- The four plans and the add-ons (docs/billing.md). Prices are whole sum, VAT excluded.
INSERT INTO "plans" ("code", "name", "price_uzs", "price_year_sum", "period_days", "seats", "max_companies",
  "imports_per_month", "audits_per_month", "ai_questions_per_month", "features", "is_public", "sort_order")
VALUES
  ('free', 'Free', 0, 0, 30, 1, 1, 30, 1, 10,
    '{"maxDevicesPerSeat": 2, "excelExport": false, "prioritySupport": false, "support": "docs"}', true, 0),
  ('start', 'Start', 590000, 5900000, 30, 1, 1, NULL, NULL, 80,
    '{"maxDevicesPerSeat": 2, "excelExport": true, "prioritySupport": false, "support": "telegram"}', true, 1),
  ('business', 'Business', 1690000, 16900000, 30, 2, 3, NULL, NULL, 250,
    '{"maxDevicesPerSeat": 2, "excelExport": true, "prioritySupport": true, "support": "telegram-priority"}', true, 2),
  ('firm', 'Firm', 4900000, 49000000, 30, 5, 10, NULL, NULL, 700,
    '{"maxDevicesPerSeat": 2, "excelExport": true, "prioritySupport": true, "support": "manager"}', true, 3)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
-- The prototype's 14-day plan is retired: it stays for old records but is not offered.
UPDATE "plans" SET "name" = 'Trial (retired)', "is_public" = false, "sort_order" = 99 WHERE "code" = 'trial';
--> statement-breakpoint
INSERT INTO "addons" ("code", "name", "price_sum", "kind", "allowed_plans", "grants")
VALUES
  ('addon_company', 'Extra company', 390000, 'recurring', ARRAY['start','business','firm'], '{"companies": 1}'),
  ('addon_user', 'Extra user', 150000, 'recurring', ARRAY['business','firm'], '{"users": 1}'),
  ('addon_ai_100', 'Extra 100 AI questions', 390000, 'one_off', ARRAY['start','business','firm'], '{"aiQuestions": 100}')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
-- Accounts made during the prototype: one still inside its period keeps Business until that date
-- (nobody loses access by this release); one that ended goes to Free. Neither can start the trial again.
UPDATE "subscriptions" s SET
  "plan_id" = (SELECT "id" FROM "plans" WHERE "code" = 'business'),
  "status" = 'active',
  "trial_used" = true
WHERE s."plan_id" = (SELECT "id" FROM "plans" WHERE "code" = 'trial') AND s."ends_at" > now();
--> statement-breakpoint
UPDATE "subscriptions" s SET
  "plan_id" = (SELECT "id" FROM "plans" WHERE "code" = 'free'),
  "status" = 'free',
  "starts_at" = now(),
  "ends_at" = '2999-01-01T00:00:00Z',
  "trial_used" = true
WHERE s."plan_id" = (SELECT "id" FROM "plans" WHERE "code" = 'trial');
