-- Credits bought or approved by an admin are used as soon as the plan's own credits are out (the customer asked for them):
-- accounts that already hold such credits get the extra credits turned on, the way a new purchase now does.
UPDATE "credit_accounts" SET "extra_enabled" = true, "updated_at" = now()
WHERE "extra_enabled" = false AND "extra_credits" > 0
  AND "account_id" IN (SELECT "account_id" FROM "credit_transactions" WHERE "type" = 'purchase');
