# CRM

Leads from the first contact to a customer, in one place, with a funnel the admin shapes and the conversion measured. It
lives in the admin dashboard (the **CRM** area, beside **Buxgalteriya**, the accounting product's 12 pages) and in a
Telegram Mini App for the sales team. The technical assignment (TZ) is the source of what is in version 1.

## Who uses it

| Who                                  | Where                                      | Sees                                                                                         |
| ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Owner, support                       | the dashboard (`/admin/#/crm/...`)         | every lead; shape the funnel; import; reports of everyone                                    |
| Sales manager (admin role `manager`) | the Mini App, and the dashboard's CRM area | **only their own leads**; nothing of Buxgalteriya (every other `/v1/admin` call answers 403) |

A manager is added by the owner on **Buxgalteriya → Admins** (role _Sales manager_). The system makes a **one-time password**
and shows it once (only its hash is kept); the manager must change it at the first sign-in (until then every call answers
`PASSWORD_CHANGE_REQUIRED`). The owner can make a new one-time password at any time (_New password_).

The Mini App needs **no Telegram link**: the person signs in with the same email and password (the one-time one the first time, then
their own). Disabling the person on the Admins page signs them out of the Mini App at once.

## Data (`apps/api/src/db/schema.ts`)

`crm_pipelines` (one for now), `crm_stages` (name, position, colour, `is_won`, `is_lost`, `archived`), `crm_leads` (name, phone,
`phone_key` — its digits, unique —, source, company, stage, owner, last contact), `crm_stage_history` (every move, the first one
is the lead's birth — **conversion is counted from it**), `crm_calls`, `crm_notes`, `crm_import_jobs`. `admins` gets `must_change_password`.

**Duplicates.** The same phone is the same lead, however it is written (`+998 90 123-45-67`, `90 123 45 67`, `998901234567`):
adding it again updates the lead (a manager cannot do that to another manager's lead: `DUPLICATE_LEAD`, 409). A number with 9
digits is Uzbek; anything else needs 11–15 digits; letters make a number broken.

## The client card

Every lead has a **client card**. The basic details (name, phone, company, source) are always on it; the rest is shaped by the admin:
CRM → Settings → _Client card_: make **sections** (Contact, Business, …) and the **fields** in them, each with a name and a type
(text, long text, number, date, phone, e-mail, choice from a list with its options, yes/no); reorder them, move a field to another
section, rename, delete (what was written in a deleted field or section is deleted too). The **managers fill the values in** on each
lead, in the dashboard (the lead page) and in the Mini App (the lead card). A value is checked against its field's type (`BAD_VALUE`,
400, nothing is saved if one is wrong); an empty one clears the field. A field's type is fixed once made. The card starts empty; a lead
with no section shows only the basics. Tables: `crm_card_sections`, `crm_card_fields`, `crm_lead_values`. API: `GET /card`,
`POST /card/sections`, `PATCH|DELETE /card/sections/:id`, `PUT /card/sections/order`, `POST /card/fields`, `PATCH|DELETE /card/fields/:id`,
`PUT /card/sections/:id/fields/order` (owner/support), `PUT /leads/:id/values` (anyone who may see the lead).

## The funnel

Admin → CRM → _Settings_: add, rename, colour, reorder, delete stages; mark one as **won** (a customer) and one as **lost**.
Lost stages are outside the funnel in the reports. Deleting a stage with leads asks where they go; a stage that has history is
kept hidden (`archived`) so past conversions stay right. The default funnel: Yangi lead → Bog'lanildi → Qiziqish bildirdi →
Kelishuv → Mijoz bo'ldi (won) · Rad etildi (lost). Moving a lead between stages is manual (no automatic rules yet).

## Reports (CRM → Reports, Excel export of every table)

Counted from the leads **created in the period** and their history (Tashkent days):

- **Funnel conversion**: a lead has reached a stage if it was there or in a later open stage (a lead that jumped to "won"
  passed the stages before). Each step shows the share of the previous step and of all leads.
- **Time in a stage**: the average from a move in to the move out (the stage a lead is in counts until now; won and lost are ends).
- **By source** and **by manager**: leads, customers, conversion, and won of closed (won / (won + lost)).
- **Customers table**: lead, current stage, manager, last contact; with search and filters.

A manager's reports hold only their own leads.

## Leads from the website

The sign-up form on the website asks for a **phone**. The person is made a user (`users.phone`, written as `+998…`; a broken number
is `BAD_PHONE`, no account) and, at the same moment, a lead in the first open stage with the source `Sayt (ro'yxatdan o'tish)`, the
company from the form, no manager, and a note with the e-mail. A phone that is already a lead is not added twice: that lead gets a
note about the sign-up. A failure to make the lead never fails the sign-up (it is logged).

## Import and export

- **Export**: _Download Excel_ on the leads list (as filtered) and on the reports.
- **Import**: an `.xlsx` file (up to about 5 MB, 20 000 rows), a **CSV** (`;`, `,` or a tab; UTF-8 or Windows-1251) or a **Google
  Sheets** link. The old binary `.xls` is refused with how to save it as `.xlsx`. The **header** is the first row (of the first 30)
  that has a phone column, so a list with an empty row or a title above it works. Columns are matched by their titles in Uzbek (Latin
  and Cyrillic), Russian or English (Ism/ким/Name/Имя/Ф.И.О., Telefon/Tel./Номер телефона, Manba/Источник, Kompaniya/Company,
  Izoh/Note, Bosqich/Status); a title that could be two fields is the first of: phone, source, company, note, stage, name; other columns
  are left out, and a column with no title but with text in it (notes written beside a list) becomes the notes. A row with nothing in
  the used columns is skipped (a list numbered far below its last entry). A cell with several phones takes the first valid one; a
  stage text that is not one of the funnel's is ignored. A broken row (bad phone) is written to `crm_import_jobs` with its row number
  and the reason, and does not stop the rest. When no column has phones, the failure lists the columns it saw. Each import is a job
  with counts (new / updated / failed), the columns used and left out, and its errors.
- **Google Sheets** is a **one-time read**, no sync: the customer shares the sheet (read only) with the service account's e-mail
  (shown on the import panel) and pastes the link. Needs `GOOGLE_SERVICE_ACCOUNT_JSON`.

## The Mini App (`apps/crm-miniapp`, served at `/crm-app/`)

Its **own bot** (not the remote-control bot), whose menu button opens the Mini App; the bot has no chat. Sign-in is the person's own
email and password (`POST /v1/crm/login`): the answer is a session token for one working day, kept on the phone and valid for
`/v1/crm` only (its own issuer: it never opens the dashboard, even for an owner). A one-time password is replaced on the first
sign-in (`POST /v1/crm/password`), in the Mini App or in the dashboard. Screens: sign-in, the lead list (search, stage filters), the
lead card (call, result of the call, stage, notes, history), a short _new lead_ form. It works in an ordinary browser too.

**Calls (variant B)**: the _Call_ button is a `tel:` link, so the phone's own dialer makes the call; when the operator comes back
the app asks what came of it (answered, no answer, busy, call back, wrong number; minutes and a note are optional) and writes it to
the call log. A call attempt moves the lead's _last contact_ date. Variants A (a companion app) and C (GSM gateway) are later.

## Setup

1. Make a bot with @BotFather (a new one, apart from the remote-control bot). In the repository secrets set `CRM_BOT_TOKEN` and
   `CRM_BOT_USERNAME` (optional); the deploy writes them to the server's `.env`. On start the server sets the bot's menu button to the
   Mini App (`CRM_MINIAPP_URL`, `https://<site>/crm-app/`).
2. For Google Sheets: make a service account (Sheets API on, read only), put its JSON key in the `GOOGLE_SERVICE_ACCOUNT_JSON` secret.
3. On Admins, add the sales managers (role _Sales manager_) and give each the one-time password shown once.

Environment (apps/api): `CRM_BOT_TOKEN`, `CRM_BOT_USERNAME`, `CRM_MINIAPP_URL`, `GOOGLE_SERVICE_ACCOUNT_JSON`.

## API (`/v1/crm`, `Authorization: Bearer <admin or CRM session token>`)

`GET /me`, `GET /funnel`, `POST /stages`, `PATCH|DELETE /stages/:id`, `PUT /stages/order` (owner/support), `GET|POST /leads`,
`GET /leads/export.xlsx`, `GET|PATCH /leads/:id`, `POST /leads/:id/stage|notes|calls`, `GET /team`, `GET /sources`,
`POST /import/file|sheet`, `GET /import/jobs`, `GET /import/google`, `GET /reports`, `GET /reports/export.xlsx`, `POST /login`, `POST /password`.
Owner-only on the admin side: `POST /v1/admin/admins/:id/reset-password`; every signed-in admin: `POST /v1/admin/password`.

## Left for later (v2+)

Two-way Google Sheets sync; calls made by the server (A: companion app, C: GSM gateway) with automatic results; automatic stage
rules; several funnels (per product); the other modules (stock, production) have their own TZ. The area list in
`apps/admin/src/App.tsx` (`AREAS`) takes a new section as one more entry.
