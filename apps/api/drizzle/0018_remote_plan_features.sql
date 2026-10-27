-- The Telegram remote control is part of every paid plan (docs/remote-control.md); the priority tier is served first.
UPDATE plans
SET features = features || '{"telegram": true}'::jsonb
WHERE code <> 'free';
--> statement-breakpoint
UPDATE plans
SET features = features || '{"telegramPriority": true}'::jsonb
WHERE features->>'support' IN ('telegram-priority', 'manager');
