-- A dollar fence per plan on top of the question quota (Admin -> AI limits edits them): a monthly cap
-- per account and a daily cap per user, about 40% of each plan's price. Existing policies are kept.
INSERT INTO "ai_policies" ("plan_id", "policy")
SELECT p."id", v."policy"::jsonb
FROM (VALUES
  ('free',     '{"monthlyLimitUsd": 3,   "dailyLimitUsdPerUser": 1.5, "onLimit": "block"}'),
  ('start',    '{"monthlyLimitUsd": 20,  "dailyLimitUsdPerUser": 8,   "onLimit": "addon"}'),
  ('business', '{"monthlyLimitUsd": 60,  "dailyLimitUsdPerUser": 15,  "onLimit": "addon"}'),
  ('firm',     '{"monthlyLimitUsd": 160, "dailyLimitUsdPerUser": 40,  "onLimit": "addon"}')
) AS v("code", "policy")
JOIN "plans" p ON p."code" = v."code"
ON CONFLICT ("plan_id") DO NOTHING;
