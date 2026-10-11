# Tariffs and billing

What is built, how to switch it on, and what is still open. The design is "Tariffs and Billing —
Technical Design" (Oct 11, 2026); this file records how the code follows it.

## Plans

Four plans, in the `plans` table (the admin dashboard edits them: **Plans**; no release needed):

|                            | Free  | Start     | Business   | Firm       |
| -------------------------- | ----- | --------- | ---------- | ---------- |
| Price / month, sum         | 0     | 590 000   | 1 690 000  | 4 900 000  |
| Price / year (12 for 10)   | 0     | 5 900 000 | 16 900 000 | 49 000 000 |
| Companies / users          | 1 / 1 | 1 / 1     | 3 / 2      | 10 / 5     |
| Imported documents / month | 30    | unlimited | unlimited  | unlimited  |
| Audit reports / month      | 1     | unlimited | unlimited  | unlimited  |
| AI questions / month       | 10    | 80        | 250        | 700        |
| Excel export               | no    | yes       | yes        | yes        |

Prices exclude VAT (`VAT_PERCENT`, 12): invoices show it as its own line. Add-ons: extra company
390 000 / month, extra user 150 000 / month, extra 100 AI questions 390 000 (one-off, valid to the end
of the period). Over 10 companies: a `custom` plan made by hand in the dashboard (hidden from the
pricing page, then put on an account from **Subscriptions**).

Free never ends: an unpaid plan lands on Free, and no data is deleted.

## Where the code is

`apps/api/src/billing/`:

- `entitlements.ts` — `Billing.get(accountId)` merges plan + active add-ons + trial into the account's
  limits (cached 60 s, `ENTITLEMENTS_CACHE_SECONDS`); `stateOf` reads the stored row against the clock.
- `service.ts` — the limits: `POST /v1/companies`, `POST /v1/users`, `POST /v1/usage/import`,
  `POST /v1/audits/runs`, and the AI question counter (`takeAiQuestion`, called by the AI gateway on
  the first step of a question; template and cache answers never reach it). 80% warning once per
  period, refusal at 100%, an answer already in progress is never cut.
- `invoicing.ts` — prices, promo codes, invoices, `applyInvoice` (one transaction, idempotent), trial,
  upgrade proration, scheduled downgrade, cancel. Proration:
  `(new − old) × daysLeft / daysInPeriod`, rounded up to 1 000 sum.
- `payme.ts` — Payme Merchant API (JSON-RPC webhook `POST /v1/billing/payme`).
- `lifecycle.ts` — hourly: overdue → grace (3 days), ended trial / finished grace / cancelled plan →
  Free, old invoices → expired. Daily: reminders 7 and 1 days before the end, the renewal invoice (one
  per period).
- `admin.ts` — the dashboard: plans, add-ons, subscriptions, revenue (MRR), promo codes.

Endpoints: `GET /v1/plans`, `GET /v1/billing/entitlements`, `GET /v1/billing/subscription`,
`POST /v1/billing/{trial,quote,checkout,change-plan,cancel,resume}`, `GET /v1/billing/invoices`,
`POST /v1/billing/invoices/:id/checkout`, `GET /v1/billing/invoices/:id/print`; admin:
`/v1/admin/{billing/plans,plans/:code,addons/:code,subscriptions,subscriptions/:id/extend,revenue,promo-codes}`.

Counters (`usage_counters`) are keyed by where the month started: Free counts calendar months, a paid
plan counts from its period start (a yearly plan still gets its monthly limits each month), a trial
counts the whole trial. "Reset" is therefore automatic.

## Rules from the design (section 10)

A repeated webhook (same `provider_txn_id`) returns the stored result and applies nothing. A payment
after the invoice expired is accepted, applied from the payment date, and logged (`late_payment`).
Paying in grace restores the plan with the original period dates (`renewed_in_grace`). Upgrade during
grace: pay the overdue invoice first (`PAY_OVERDUE_FIRST`). Extra companies after a downgrade are
read-only; the newest stay active unless the owner picks (`POST /v1/companies/active`). A second trial
is refused per account and per INN of the first company. A price change applies from the next period.

## Switching it on

The tables and the four plans arrive with the deploy, and existing accounts are moved: one still inside
its period keeps Business until that date, one that ended goes to Free (no trial left). **Limits are enforced
when `PLAN_LIMITS=on`**, which is now the deploy default (set `PLAN_LIMITS=off` in the server's `.env`
to stop enforcing; use is still counted):

1. `SITE_URL` (default `https://1c-integration.vercel.app` in `deploy/docker-compose.yml`; override it in
   the server's `.env`) is where the Upgrade button leads: `SITE_URL/cabinet`.
2. For card payments set `PAYME_MERCHANT_ID`, `PAYME_KEY` and `PAYME_TEST=true` (sandbox). Without them
   only bank transfer is offered; set `BANK_REQUISITES` (lines separated by `|`) for the printed invoice.

## Payme: verify before going live

`payme.ts` was written from Payme's Merchant API as we know it (method names, Basic auth `Paycom:<key>`,
amounts in tiyin, error codes −31001 / −31003 / −31007 / −31008 / −31050 / −31051 / −31099, the 12-hour
timeout) and the checkout link `https://checkout.paycom.uz/<base64 of m=…;ac.invoice_id=…;a=…>` (the
sandbox host is `test.paycom.uz`). Payme's documentation could not be reached while building, so
**compare every method and code with the current documentation, and pass all of Payme's sandbox test
cases, before `PAYME_TEST=false`** (checklist item 12 of the design). The account field is
`invoice_id` (our invoice number); register that in the merchant cabinet.

A performed transaction is not cancelled automatically (`-31007`); refunds are done by hand.

## Not built yet

- Click (phase 2): `POST /billing/click/prepare` and `/complete`.
- Payme auto-renewal with card tokens (Subscribe API, phase 2). Renewal invoices are made and shown in
  the cabinet; the customer pays them.
- Sending the reminders: they are recorded as `reminder_*` billing events (visible in the dashboard)
  and the app shows the state in its sidebar, but there is no e-mail or Telegram sender yet.
- Yearly → monthly is possible only at renewal (`CYCLE_AT_RENEWAL`).
- The desktop app does not start the trial itself: the website cabinet does.
