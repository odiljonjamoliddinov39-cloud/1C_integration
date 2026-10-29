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

The yearly price is always the monthly one for 10 months (12 for 10): it is worked out wherever it is used (catalog, invoices, revenue) and when a plan is saved, so whatever the form sends for it is ignored. The admin form shows it as you type the monthly price; the pricing page's yearly view shows the monthly equivalent, the saving and each monthly limit with its yearly total.

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

## What counts as an AI question

A question is 1. A heavy job (a big import that reads many documents) counts as more: one more for each
further `AI_QUESTION_UNIT_USD` (default 0.50) of real AI cost, charged as the cost builds up
(`ai_question_charges`). The answer in progress is never cut; if it takes the account over its limit,
the next question is refused. Set `AI_QUESTION_UNIT_USD=0` to count every question as 1.

There is no separate daily token cap any more. The limits are the plan's questions per month and a
dollar fence per plan (monthly per account, daily per user), seeded at about 40% of each plan's price
and edited in Admin → AI limits.

Speed: a question that comes with files to enter into 1C runs at `AI_IMPORT_EFFORT` (default `low`)
instead of `AI_EFFORT` (`high`), since thinking is most of the wait on a long import. Set it equal to
`AI_EFFORT` to turn this off. If the AI provider refuses our requests (e.g. its credit ran out),
customers see "temporarily unavailable" and the admin overview shows a red alert until an answer works.

Measuring: every model step records how long it took, the wait for its first word, the calls made to
the API and the 429s among them (`ai_usage`); Admin → AI cost shows the AI time and 429s per expensive
question. A question the AI could not answer at all is not charged: the question it took is given back.

Imports are saved unposted: what the assistant creates from attached files is written unposted unless
the question itself asks for posting. XML documents (Didox ЭСФ) are sent without the indentation between
tags. The files stay in the chat until the question ends, because a job in several cards needs them for
each card; they are cached, so resending them is cheap.

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

## Payme: checked against the Merchant API pages

Checked against Payme's pages for CheckTransaction, CreateTransaction, PerformTransaction, CancelTransaction, GetStatement,
SetFiscalData, the general errors, the data types, the states and the reasons (the pages the owner pasted, Oct 2026):

- Basic auth `Paycom:<key>`, amounts in tiyin, `account.invoice_id` = our invoice number (register that field in the merchant
  cabinet), 12-hour timeout (43 200 000 ms: state −1, reason 4), the states 1 / 2 / −1 / −2, the reasons, a repeated
  CreateTransaction / PerformTransaction answers what was stored.
- Errors: −31001 wrong amount, −31003 no transaction, −31007, −31008, −31050…−31099 with the sub-field in `data`
  (−31050 no invoice, −31051 invoice not payable, −31099 another transaction open), and the general ones, all on HTTP 200:
  −32700 not JSON, −32300 not a POST, −32600 bad request, −32601 unknown method (its name in `data`), −32504 no privileges,
  −32400 a fault of ours (database…; logged).
- GetStatement: by the time Payme created the transaction, `from ≤ time ≤ to`, oldest first, an empty list when none.
- SetFiscalData (optional): the fiscal data of a paid and of a cancelled receipt are kept apart in the payment's `raw.fiscal`;
  −32001 unknown receipt, −32602 invalid parameters (the parameter named).
- Every call is logged as one line (method, id, error code).

**A decision to confirm.** CancelTransaction of a _performed_ transaction answers −31007 ("the service has been provided in
full"): the plan was extended, and refunds are made by hand. Payme's page says a refund from the merchant's Payme cabinet is
possible only when CancelTransaction is implemented for performed transactions (state −2). If refunds through the cabinet are
wanted, a refund must take the plan back (move the account to Free); say so and it is added.

**Still to check on pages not yet seen:** CheckPerformTransaction (the optional `detail` of a fiscal receipt: the IKPU code,
the package code, the unit are set with `PAYME_FISCAL_CODE`, `PAYME_FISCAL_PACKAGE`, `PAYME_FISCAL_UNITS`, off until the code
and the package are given), the checkout link (`m`, `ac.*`, `a`, `c` and the test host `checkout.test.paycom.uz`), and Payme's
sandbox test scenarios, which must all pass before `PAYME_TEST=false`.

## Click: checked against the SHOP API pages

Click calls `POST /v1/billing/click/prepare` and `/complete` (form-urlencoded in, JSON out, always 200 with `error` /
`error_note`); `merchant_trans_id` is our invoice number. The signature is MD5 over the request's own values and the service's
secret key (Prepare without `merchant_prepare_id`, Complete with it); the error table is Click's (−1 signature, −2 amount, −3
action, −4 already paid, −5 no order, −6 no transaction, −7 could not update, −8 bad request, −9 cancelled). A repeated Prepare
returns the same payment (`merchant_prepare_id` = invoice number × 1000 + the attempt); a Complete applies the plan once; a status
below 0 from Click cancels the prepared payment; an invoice paid another way meanwhile answers −4 and is logged
(`duplicate_payment`) for a refund by hand (Click's `payment/reversal` is not called by the program).

On the page the customer pays **without leaving it**: the cabinet opens Click's own window (`checkout.js`,
`createPaymentRequest`), or the link `https://my.click.uz/services/pay?...` when the window cannot be opened. The card is typed in
Click's window or in the Click and Payme apps; nothing of it reaches the page or the server.

Set `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` (and `CLICK_MERCHANT_USER_ID` if Click gave one) in the server's
`.env` (the deploy file passes them on; the keys are never in the repository) and give Click the two URLs
`https://<api>/v1/billing/click/prepare` and `/complete`. Click's fiscalization calls (`submit_items`, `submit_qrcode`) are not
made yet.

## Paynet: what the developer guide says (not built)

Paynet is a different model: **Paynet always calls us** (UWS, JSON-RPC 2.0 on one endpoint: GetInformation, PerformTransaction,
CheckTransaction, CancelTransaction, GetStatement, optional ChangePassword), and the customer pays in the Paynet app or at a
terminal by entering the account (our invoice number) under our `serviceId`; the guide has no web checkout link or card window.
So a Paynet button on the cabinet cannot open a payment window: it can only tell the customer the service and the invoice number to
pay in Paynet. Needs: HTTP Basic Auth (a wrong login is HTTP 401, not an error object), Paynet's two IP ranges (a firewall rule),
TLS 1.3, answers within 500 ms, error codes of its own table (201 duplicate, 202/203/77/306 for cancellation, 302 unknown account,
413 amount, state 3 for an unknown transaction in CheckTransaction), the `timestamp` of CheckTransaction in
`EEE MMM dd HH:mm:ss z yyyy`, amounts in tiyin, dates `YYYY-MM-dd HH:mm:ss` (GMT+5), daily reconciliation by GetStatement, a "technical
interaction" form with the service list, and the connection over TAS-IX. The field-level OpenAPI file ("OpenAPI (UWS) in
English.yaml") is not in the guide: it is needed before this is written.

## Not built yet

- Payme auto-renewal with card tokens (Subscribe API, phase 2). Renewal invoices are made and shown in
  the cabinet; the customer pays them.
- Sending the reminders: they are recorded as `reminder_*` billing events (visible in the dashboard)
  and the app shows the state in its sidebar, but there is no e-mail or Telegram sender yet.
- Yearly → monthly is possible only at renewal (`CYCLE_AT_RENEWAL`).
- The desktop app does not start the trial itself: the website cabinet does.
