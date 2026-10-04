-- Plans and prices are still an open question (TD §14). The 14-day trial lets the prototype
-- register, activate the desktop app and work; paid plans are added with billing (Payme).
INSERT INTO "plans" ("code", "price_uzs", "period_days", "seats", "max_companies", "ai_token_quota", "features")
VALUES ('trial', 0, 14, 1, 5, 0, '{"maxDevicesPerSeat": 2}')
ON CONFLICT ("code") DO NOTHING;
