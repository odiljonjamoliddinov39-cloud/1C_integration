# Soliq-Service (soliqservis.uz) integration

Status: researched, blocked on credentials. Nothing is built yet.

Source: the OpenAPI (Swagger 2.0) file of https://github.com/galabeketov/soliq-docs (`app/swagger.json`,
81 paths), read on 2026-10-10. It is a third-party copy of the provider's documentation, so what is
below is "as documented there", to be confirmed with Soliq-Service.

Soliq-Service is the second electronic document exchange (with Didox, see `didox.md`) that issues
invoices (счёт-фактура), acts, contracts, powers of attorney, waybills and reconciliation acts to the
tax system. The app's sources list already has `soliq-service`.

## Access: what the documentation says about keys

- **Servers:** the spec says host `v3.soliqservis.uz:3443`; the repo's README names
  `https://v3.soliqservis.uz:2443` as production and a `staging.soliqservis.uz:2443`. The ports differ
  between the two, so which one is the real production address is to be confirmed.
- **Authentication:** HTTP **Basic** (a login and a password) on most requests. A second scheme,
  **`ApiKeyAuth`**, is used by 17 requests (registering a client, the "allow companies" consent
  calls, and others) **but is not defined anywhere in the file**: its header name and format are not
  documented. Neither is **how a login, a password or an API key is obtained**.
- **Who to ask:** the spec's contact is Call Center **1198**, **servis@soliq.uz**; the terms of service
  are at https://new.soliqservis.uz/factura/publicOffer/0 and the portal is https://new.soliqservis.uz/.
- **Language:** most requests need a `lang` header (`ru` or `uz`).

So the keys are issued by Soliq-Service to a registered integrator (a "provider"); the repo cannot
give them. See "Request" below.

## What the API offers (as documented)

- `GET /api/ping` answers "pong" (no authentication): a way to see that the service is up.
- **Reading:** `GET /api/get-all-docs` (filters: `ownerTin` or `parentTin` is required, `docType`,
  `docStatus`, `fromDate`/`toDate`, `partnerTin`, `docNo`, `limit`, `offset`, …),
  `POST /api/doc-list-basic?doc_type=` (body `{"ids": [...]}`), `GET /api/factura-get/{id}`,
  `GET /api/act-get/{id}`, `/contract-get/{id}`, `/empowerment-get/{id}`, `/empowerment2-get/…`,
  `/waybill2-get/{id}`, `GET /api/get/pdf?doc_id=&doc_type=&lang=`.
- **Companies:** `GET /api/np1/bytin?tinOrPinfl=` (company data), `/np1/vat/status`,
  `/np1/bytin/get-accounts`, `/get-branches-basic`.
- **Sending:** `POST /api/factura-create` (body `{ip, sign}`, the invoice JSON is signed), and
  likewise `act-create`, `contract-create`, `empowerment-create`, `waybill2-create`, `vAct-create`,
  plus `…-save`, `…-cancel` and the signature fetch requests (`factura-seller-sign-basic` and
  its buyer/agent siblings). The JSON structure of an invoice is in a Google document linked from the
  spec ("Структура JSON – Счёт-фактура").
- **Signing:** documents are signed with an E-IMZO key (PKCS#7): `GET /api/utils/timestamp`,
  `POST /frontend/pkcs7/join`, `POST /frontend/timestamp/pkcs7`. The E-IMZO side is already built
  (`apps/desktop/src/main/didox/eimzo.ts`).
- **Consent between companies:** `POST /api/allow-companies/{company_tin}` and
  `PATCH /api/allow-companies/{id}` (a company signs a text, "I agree that company X sees my
  documents", with its tax number and the date), `GET /api/allow/companies`. And
  `POST /api/register-basic/{tinOrPinfl}` with `{sign}` binds a client to the provider
  (`GET /api/provider/api/register/providerbinding/{clientTin}`). **So reading a company's documents
  likely needs that company's signed consent and binding to our provider account.**
- The spec gives no response shapes for the lists and documents (they are unresolved references).

## Request to send to Soliq-Service

Ask (call 1198, or write to servis@soliq.uz):

1. How an integrator ("provider") registers, and the **production and test addresses** (ports 2443
   or 3443).
2. **A login and password (Basic)** for the integrator, and **the API key** of the `ApiKeyAuth`
   scheme: its header name, and how to get one.
3. A **test company** with test documents.
4. How a client company is **bound to us** (`register-basic`) and gives consent (`allow-companies`),
   and what the client has to do (sign with E-IMZO, in whose interface).
5. The **JSON structures** of the documents and of the lists, and the document statuses.
6. Limits (the spec shows a 429 "Rouming Error") and the terms for a third-party app that acts for
   clients.

### Russian

> Здравствуйте! Мы разрабатываем приложение «AI Accounting Assistant» для бухгалтеров (работает
> рядом с 1С, вводит документы в 1С после подтверждения бухгалтера). Хотим подключить Soliq-Service
> API: получать входящие документы (счета-фактуры, акты, доверенности, накладные) и отправлять
> исходящие. Просим: 1) порядок регистрации интегратора (провайдера), адреса production и тестовой
> среды; 2) логин и пароль (Basic) и API-ключ (схема ApiKeyAuth: имя заголовка и как получить); 3) тестовую компанию с документами; 4) как привязывается клиент (register-basic) и даёт согласие
> (allow-companies); 5) структуры JSON документов и списков, статусы; 6) лимиты и условия работы
> стороннего приложения от имени клиента. Контакт: <имя, телефон>.

### Uzbek

> Assalomu alaykum! Biz buxgalterlar uchun «AI Accounting Assistant» ilovasini ishlab chiqmoqdamiz
> (1C yonida ishlaydi, buxgalter tasdiqlagandan keyin hujjatlarni 1C ga kiritadi). Soliq-Servis
> API ni ulamoqchimiz: kiruvchi hujjatlarni (hisob-fakturalar, dalolatnomalar, ishonchnomalar,
> yuk xatlari) olish va chiquvchilarini yuborish. Iltimos: 1) integrator (provayder) roʻyxatdan
> oʻtish tartibi, production va test muhit manzillari; 2) login va parol (Basic) hamda API-kalit
> (ApiKeyAuth sxemasi: sarlavha nomi va qanday olish); 3) hujjatlari bor test kompaniya; 4) mijoz
> qanday bogʻlanadi (register-basic) va rozilik beradi (allow-companies); 5) hujjat va roʻyxatlarning
> JSON tuzilmalari, holatlar; 6) limitlar va mijoz nomidan ishlaydigan uchinchi tomon ilovasi uchun
> shartlar. Aloqa: <ism, telefon>.

## Plan once access exists

The same shape as Didox: a `SoliqClient` behind an interface, with a fake server and tests, Basic
credentials kept encrypted on the PC (never on our server), the incoming documents read by the
assistant and entered in 1C on a confirmed card, outgoing ones signed with the E-IMZO signer after
a confirmation card. First a run against the test environment to learn the response shapes and to see
how the consent step works for a real client.
