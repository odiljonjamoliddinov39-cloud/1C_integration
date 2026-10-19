# Didox integration

Status: planned, blocked on API access. Nothing is built against Didox yet, because the API details
(login, document list, document fetch, signing) are not public to us and were not guessed.

## Goal

1. **Incoming**: the app fetches a company's incoming documents (invoices, acts, powers of attorney,
   waybills) from Didox itself. Nobody downloads zip archives. The assistant reads them (the XML has
   every field) and prepares the entries in 1C on a card the accountant confirms, as it does for
   archives today.
2. **Outgoing**: issued invoices and acts are sent from the app to Didox, after the accountant
   confirms and signs.

## What we need from Didox

Ask Didox support (or the partner manager) for:

- API access for a **partner/integrator** account, and a **test environment** with a test company.
- The API documentation: login, listing documents (incoming and outgoing, by period and status),
  fetching one document (JSON or XML, and the PDF), sending a document, document statuses.
- How a legal entity signs in for API use: **tax ID + password**, or only an **E-IMZO key**.
- How a document is **signed** for sending: E-IMZO (the local E-IMZO app on the PC) or a server-side
  key, and what the API expects (PKCS#7 of what).
- Rate limits, and whether there are **webhooks** for new incoming documents (otherwise we poll).
- The terms for a third-party app to act for a client company (their consent, our liability).

### Request text (Russian)

> Здравствуйте! Мы разрабатываем приложение «AI Accounting Assistant» для бухгалтеров (работает
> рядом с 1С и вводит документы в 1С после подтверждения бухгалтера). Хотим подключить Didox:
> получать входящие документы (счета-фактуры, акты, доверенности, ТТН) и отправлять исходящие.
> Просим: 1) доступ к API для партнёра и тестовую среду; 2) документацию API (авторизация, список
> документов, получение документа, отправка, статусы); 3) как организация авторизуется для API
> (ИНН и пароль или ключ E-IMZO) и как подписывается документ при отправке; 4) лимиты и наличие
> вебхуков; 5) условия работы стороннего приложения от имени клиента. Контакт: <имя, телефон>.

### Request text (Uzbek)

> Assalomu alaykum! Biz buxgalterlar uchun «AI Accounting Assistant» ilovasini ishlab chiqmoqdamiz
> (1C yonida ishlaydi va buxgalter tasdiqlagandan keyin hujjatlarni 1C ga kiritadi). Didox ni
> ulamoqchimiz: kiruvchi hujjatlarni (hisob-fakturalar, dalolatnomalar, ishonchnomalar, TTN) olish va
> chiquvchilarini yuborish. Iltimos: 1) hamkor uchun API ga kirish va test muhiti; 2) API hujjatlari
> (avtorizatsiya, hujjatlar roʻyxati, hujjatni olish, yuborish, holatlar); 3) tashkilot API uchun
> qanday avtorizatsiyadan oʻtadi (STIR va parol yoki E-IMZO kaliti) va yuborishda hujjat qanday
> imzolanadi; 4) limitlar va vebhuklar; 5) mijoz nomidan ishlaydigan uchinchi tomon ilovasi uchun
> shartlar. Aloqa: <ism, telefon>.

## The API (from the "DIDOX-1C-INTEGRATION" Postman collection, 2026-10-10)

Development server: `https://devapi.goodsign.biz/`. Requests carry `api-key` (a partner key) and
`user-key` (the user's token, to be confirmed), `Accept: application/json`.

**Sign-in with an E-IMZO key**

1. `GET /v1/auth/authId/{serialNumber}`: the key's serial number in hex gives an `authId`.
2. The app signs the JSON `{"authId": "..."}` with the key (PKCS#7).
   Didox refuses a signature with no time stamp (401 "Eimzo fail … timestamp is required", seen on a
   real key 2026-10-18), and E-IMZO does not stamp. So after signing, E-IMZO's `signature_hex` goes to
   `POST /v1/dsvs/gettimestamp`, which answers `{"success":true,"timeStampTokenB64":"…",
"isAttachedPkcs7":false}`, and E-IMZO attaches the token (`attach_timestamp_token_pkcs7`: the PKCS#7,
   the signer's `signer_serial_number`, the token). What the endpoint takes is not in the collection and
   it answers an empty token to what it does not understand (the PKCS#7 as plain text and as `{"pkcs7"}`
   both did), so the app tries the signature as JSON, the signature as text, the PKCS#7 as JSON and as
   text, and the first token wins; if none does, the error lists each answer.
   E-IMZO 6.4.7 on one PC answered `pkcs7.attach_timestamp_token_pkcs7: Функция не найдена или версия
E-IMZO устарела` (so Didox had given a token). The app then puts the token in itself (`cms.ts`): the
   PKCS#7 is read as a tree (E-IMZO writes BER with indefinite lengths), the token is added to the signer's
   unsigned attributes (id-aa-signatureTimeStampToken, which the signature does not cover), and the document
   is written with definite lengths; every signed byte is copied as it was. Checked with `openssl cms -verify`
   on a real BER signature and a real `openssl ts` token (the signature still verifies, the attribute is
   there); not yet with Didox's own verification.
   Seen next (2026-10-18, the build with that attach): Didox still answered `Invalid signature: Eimzo fail …
timestamp is required`. So the token is now read (`readTimestampToken`): a TimeStampResp is unwrapped to
   its token, and the token's message imprint (what it says it stamps) is compared with the hash of the
   signature value, so a token for other data is not used and the next request shape is tried. If Didox
   still refuses, the error ends with `[time stamp from <shape>: …, sha256 imprint …, stamps the signature:
yes/no/unknown]`.
   Then (same day): the test server accepted the time stamp but refused the real certificate for another
   reason (`failed to check certificate state … ocsp url is disallowed`: the test server cannot check a
   production key's status; use the production Didox with the partner key). On the production host
   `POST /v1/dsvs/gettimestamp` answered `405 Not Allowed` (nginx). So when every request shape meets
   404/405/501 the app takes it that this Didox has no time stamp service, signs again without one, and lets
   the sign-in say whether it wants one (the error then ends with `[no time stamp: this Didox has no
/v1/dsvs/gettimestamp]`).
   A company's own working 1C module (`uzbled_Операторы_Didox`) sends the token as `api-key`:
   `HTTPЗапрос.Заголовки.Вставить("api-key", Токен)`. So with no partner key configured the app sends the
   token under both `user-key` and `api-key`; with a partner key, `api-key` is the partner key.
   The address must be the API's, not the Didox site's: a `https://didox.uz/documents/…` page URL answers
   `405 Not Allowed` (nginx) to every API request, and an SPA may answer the sign-in's first GET with its HTML.
   The client now says so when Didox answers a web page ("… with a web page, not the API: … is the site's
   address").
3. `POST /v1/auth/login` with `{"serialNumber", "pkcs7"}` (the stamped PKCS#7): returns a token valid for 24 hours.
   `GET /v1/auth/token` (with the authId) extends it by 24 hours. `POST /v1/auth/register` registers a
   user by key (e-mail, mobile, acceptance of the offer at didox.uz/oferta); its token lives 200 seconds.

**Profile**: `GET /v1/profile`, `GET /v1/profile/{taxId}`, `/v1/profile/operators`, `/branches?tin=`,
`/productClasses` (list, bind, unbind, search).

**Documents**

- `GET /v1/documents`, filters: `doctype` (006 power of attorney, 061 power of attorney Didox-only,
  005 act, 001 invoice, 002 invoice without an act, 021 invoice return, 008/081 pharma, 000 free-form),
  `status` (0 created, 1 signed by self, 2 signed by partner, 3 signed, 4 rejected, 5 deleted, 6 waits
  for agent, 8 signed by agent, 40 not valid, 60 partner waits for agent), `owner` (0 incoming, 1
  outgoing), `page`, `limit` (default 20), `dateFrom`/`dateTo`, `partner` (tax number).
- `GET /v1/documents/statistics/all` (counts, same filters); `GET /v1/documents/{id}` (details).
- ~~`GET /v1/documents/{id}/downloadrequest`~~ (a link to the archive zip) is in an old Postman collection;
  production answers 500 "route … could not be found" and Didox's own 1C library never uses it. The
  library reads a document with `GET /v1/documents/{id}` (the data) and `GET /v1/documents/{id}/file/true`
  (`{file: {data: base64}}`, the print form), so the app does the same.
- Print forms: `/v1/documents/{id}/html/{locale}`, `/pdf/{locale}`, `/file/false`.
- Sending: `POST /v1/documents/{docType}/create` makes a draft (the body is Didox's structure; for an
  act `ActDoc`, `ContractDoc`, `SellerTin`, `BuyerTin`, `ProductList.Products[]` with `Name`,
  `MeasureId`, `Count`, `Summa`, `TotalSum`, `VatRate`, `VatSum`, `TotalSumWithVat`);
  `POST /v1/documents/{id}/update/{doctype}` updates a draft, `/delete/draft` deletes it.
- Signing: `GET /v1/documents/{id}/tosign` (body `{"action": "accept|cancel|reject"}`) says what to
  sign; `POST /v1/documents/{id}/sign` with `{"signature"}`; `/reject` with `{"signature","comment"}`;
  `/delete` with `{"signature"}`.
- Catalogs: `/v1/banks/all`, `/measures/all`, `/regions/all`, `/districts/all`; time stamp:
  `POST /v1/dsvs/gettimestamp`.

**Not in the collection** (to be seen on the dev server): the shape of the document list and of a
document's details, the shape of the login answer, and whether the token travels as `user-key`.

## The real protocol: Didox's own 1C library (given by Didox, 2026-10-19)

Didox gave "Библиотека электронных документов для Узбекистана" 3.0.15.1 (a 1C configuration, `uzbled_*`).
Its common module `uzbled_Операторы_Didox` and the operators catalog's data hold what the Postman collection
did not show. What the app now follows:

- **Servers**: production `api.didox.uz`, test `testapi2.didox.uz`, port 443 (the library switches by the
  constant `uzbled_ЭтоТест`). The site is `didox.uz`: it is not the API (it answers 405).
- **authId**: `GET v1/auth/authId/{serialNumber}` → `{authId}`.
- **Time stamp**: `POST v1/dsvs/timestamp` with JSON `{"pkcs7": "<E-IMZO's PKCS#7>", "signatureHex":
"<E-IMZO's signature_hex>"}` (both) → `{"success", "timeStampTokenB64", "isAttachedPkcs7"}`. With
  `isAttachedPkcs7` true the value is the PKCS#7 with the stamp in it and is used as it is; else it is a token
  that E-IMZO attaches (`attach_timestamp_token_pkcs7`, or the app's `cms.ts` when E-IMZO lacks it).
- **Sign-in with a key**: `POST v1/auth/{taxId}/token` with `{"serialNumber", "signature": "<stamped PKCS#7>"}` →
  `{"token", "related_companies"}`; `taxId` is the INN of the key (a company's key: the company's INN). For a
  person's key the company's token is then `POST v1/auth/company/{companyTin}/login` with the person's token
  as `api-key` and `user-key`. (The older `v1/auth/login` with `{"serialNumber", "pkcs7"}` is kept as a
  fallback.) Registration: `POST v1/auth/register`, the same body as the older login.
- **Every later request**: the token as both `api-key` and `user-key`. There is **no partner key** in the
  library.
- **Sign-in by INN and password** (no E-IMZO): `POST waltz/goodsign/0.0.1/user/{inn}/token` with
  `{"password"}`. Not built.
- **Documents**: `GET v1/documents?limit=100&page={page}`, `GET v1/documents/{id}`, `POST v1/documents/{id}/tosign`
  with `{"action": "accept|reject|cancel", "comment": ""}` → `{"data": <what to sign>}`, `POST
v1/documents/{id}/sign`, `/reject`, `/delete`, `POST v1/documents/{docType}/create`, `…/{id}/update/{docType}`,
  `GET v1/documents/{id}/file/true` (print form), `GET v1/profile`, `v1/profile/{taxId}`, `v1/profile/update`,
  `v1/profile/branches?tin=`, `v1/profile/taxGap/{tin}`, `v1/measures/all`, `v1/profile/productClasses`.

## E-IMZO (from https://github.com/qo0p/e-imzo-doc)

E-IMZO is a program on the accountant's PC. It has a local WebSocket service, and every call is one
short connection: connect to `ws://127.0.0.1:64646/service/cryptapi` (`wss://127.0.0.1:64443` from an
https page), send one JSON message, take one answer, close.

- `{plugin:"pfx", name:"list_all_certificates"}` lists key files: `disk`, `path`, `name`, `alias`. The
  alias holds `1.2.860.3.16.1.1` (INN), `1.2.860.3.16.1.2` (PINFL), `CN`, `O`, `SERIALNUMBER` (hex, what
  Didox calls the serial number), `VALIDFROM`, `VALIDTO`.
- `{plugin:"pfx", name:"load_key", arguments:[disk, path, name, alias]}` gives a `keyId`. **E-IMZO asks
  for the key's password in its own window**, and keeps it for the `keyId`'s session (the user can tick
  "remember for 6 hours"); the app never sees it. A `keyId` lives 24 hours.
- `{plugin:"pkcs7", name:"create_pkcs7", arguments:[dataBase64, keyId, "no"]}` gives `pkcs7_64`
  (`"no"`: the data is inside the document). ID cards and tokens use `"idcard"`, `"baikey"`, `"ckc"`
  instead of a `keyId` (not supported by the app yet).
- `{name:"apikey", arguments:[domain, key, ...]}`: an API key bound to a **domain**, issued by НИЦ НТ.
  The demo's `localhost` and `127.0.0.1` keys are only for a local page. For a test, E-IMZO's tray menu
  has a "developer mode". **Whether E-IMZO accepts a desktop app, which has no page and no domain, is
  not documented** and has to be tried on a PC (then ask НИЦ НТ what key an installed application uses).
  Seen 2026-10-18: on one PC E-IMZO 6.4.7 took the calls with no key; on another it answered
  `API-key для домена null недействителен` to the first call (the desktop app sends no Origin). The app
  now meets that refusal by repeating the call as from a local page: an `Origin: http://localhost`
  header and the guide's published `localhost`/`127.0.0.1` keys set first, on a connection of their own (E-IMZO
  closes a connection after one answer, so keys and call on one connection ended in "the connection closed",
  seen on the first try), and goes on that way. Whether E-IMZO accepts those for a desktop app is to be seen; if not, the error says
  so, and НИЦ НТ has to be asked for a key for the application.
- Test without a physical key: tray menu, Development, ID-card emulator (test only).

## Built

`apps/desktop/src/main/didox/`, with tests and fakes (`FakeDidox`, `FakeSigner`, a fake E-IMZO):

- `client.ts`: `DidoxClient` (sign-in through a `DidoxSigner`, listing, details, print form,
  create/sign/reject).
- `eimzo.ts`: `EImzoClient` (the local service above), `EImzoSigner` (picks the key by serial number or
  INN, else the only valid one; opens it once; signs; reopens it if E-IMZO forgot the id).

- `test-run.ts` and the **"Didox test" button** (Companies screen, top right): asks E-IMZO for its version
  and keys, signs in to Didox with the chosen key (E-IMZO opens its own password window), then reads
  the profile, the five newest incoming documents, the first one's data and its print form, showing each step's answer. It changes nothing. Address (empty: the dev server), the partner
  `api-key` and the key to use are fields of the dialog; nothing is saved.

Not wired into the app yet: no settings screen, no assistant tool.

## Needed next

1. A first run on a PC with E-IMZO and a test key, against `devapi.goodsign.biz`: to see whether E-IMZO
   accepts the app, and the shapes of the answers the collection does not show.
2. The partner `api-key` from Didox, and a test company on the dev server.

## Plan once access exists

1. **Client**: a `DidoxClient` in `packages/` behind an interface, with a fake for tests (the same
   pattern as `onec-client` and `FakePlatform`), so everything below is tested without Didox.
2. **Connection per company**: the company's Didox sign-in on the PC, stored encrypted like the 1C
   passwords. It never goes to our server.
3. **Incoming**: built: the tool `fetch_didox_documents` (reads only) pages through Didox's lists
   (`GET /v1/documents?owner=0|1&page=&limit=&dateFrom=`), reads each document (`GET /v1/documents/{id}`, or
   the JSON the list entry carries) and keeps those dated in the period. The ones where the company is the
   buyer join the chat exactly as attached Didox files do, so `propose_didox_invoices`, the checks and the
   resolver work on them unchanged; the ones where it is the seller are listed to be compared with 1C. No
   files from the accountant are needed. `dateTo` is not sent to Didox (it filters by the update date, which can
   be later than the document's own), the period end is applied to the document's own date.
4. **Outgoing**: step 1 is built: the tool `propose_didox_draft` makes an invoice that exists in 1C a **draft** in
   Didox, after the accountant confirms a card (seller, buyer, lines and the sums the app worked out). It never
   signs and never sends. The body follows Didox's own 1C library (`FacturaDoc`, `ContractDoc`, `Seller` and
   `Buyer` from Didox's profiles of the two INNs, `ProductList.Products[]`, the totals) and is created with
   `POST /v1/documents/002/create`. How a company reaches Didox (address and E-IMZO key serial, not secret) is
   saved from the Didox test dialog ("Save for this company"). Step 2, signing (`/tosign`, E-IMZO, `/sign`) and
   sending, comes only after a draft made this way has been checked on real Didox.
   Letters and other free-form documents go the same way with `propose_didox_document`: the text from the chat
   is printed to a PDF (a hidden Electron window), the body is Didox's free-form layout from its 1C library
   (`POST /v1/documents/000/create`, `data{Subtype, Document{DocumentNo, DocumentDate}, Seller, Buyer}` and
   `document` = the PDF in base64; Subtype 1 reconciliation act, 2 letter, 3 contract, 4 invoice for payment,
   5 act of work, 6 other, 7 request, 8 specification), as a draft only.
5. **Dedup**: a Didox document id is the `externalId` of the 1C record, so a document is never
   entered twice (the PlatformAPI already refuses a second one).

## Risks

- Signing: E-IMZO needs the accountant's key and a local helper; it is the largest unknown.
- A sent document is a legal act. Sending stays behind an explicit card, and the first version
  sends only invoices and acts that were issued from 1C.
- Didox may change the API; the client is one module so the change stays in one place.

## Importing Didox archives with no AI doing the reading

A zip from Didox's "download" (a zip of zips: for each document a JSON, its PDF picture, signatures
and a readme) is read by the desktop app itself (`apps/desktop/src/main/didox/`), not by the model:

1. **Read** (`document.ts`). The JSON of an invoice, act, contract, free-form document or
   reconciliation act becomes one record. Money is in whole tiyin (Didox sends numbers, strings and
   floats with noise like `892.8600000000000136`). Every line is checked: quantity × price against the
   amount, the amount's VAT, amount + VAT against the total. The supplier's figures are never changed;
   what does not add up is named. An act that repeats an invoice (same seller and number) is left out
   and checked against it; the PDFs, `.p7s` signatures and readme are not sent.
2. **Summary.** The model gets one compact text per attachment (the buyer once, documents by seller,
   a line per goods line, `OK` or `CHECK` per document), about a tenth of what the pages cost, and is
   told not to recalculate what is marked OK. Documents that are not entries in 1C (contracts,
   free-form, reconciliations) are listed, not sent.
3. **Enter** (`resolve.ts`, tool `propose_didox_invoices`). The model sends only a title. The app asks
   1C, in four queries for the whole batch, for the counterparties (by INN), the contracts (by number and
   date) and the items (by exact name, else by IKPU code), then puts every document it is certain of on
   one card. The Didox document id is the `externalId`, so entering the same document again creates
   nothing. What it cannot settle comes back to the model as short problems with candidates; the model
   answers with references and calls the tool again.

**IKPU is a kind of goods, not an item**: every size of a diaper has the same code. A goods line is
matched only when the supplier's name also fits (same words, and no volume or size the item has and the
supplier's name lacks); a service is free text under a category code, so one candidate is enough. The
1C extension (0.7.0) follows the same rule when asked by IKPU: several items with the code is
`ITEM_AMBIGUOUS` with the candidates, never the first one found. It also finds a contract by number and
date (`CONTRACT_NOT_FOUND` / `CONTRACT_AMBIGUOUS` list the counterparty's contracts).

The attribute that holds the IKPU code is found in the nomenclature's metadata by its name or its title
("Код из классификатора" under ЭДО on the form). If a configuration has none, only exact names match.

Documents whose buyer is not this base's company are named and not entered. An act with no invoice is
for the model to enter as a receipt of services.
