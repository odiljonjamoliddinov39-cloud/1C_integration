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

## Plan once access exists

1. **Client**: a `DidoxClient` in `packages/` behind an interface, with a fake for tests (the same
   pattern as `onec-client` and `FakePlatform`), so everything below is tested without Didox.
2. **Connection per company**: the company's Didox sign-in on the PC, stored encrypted like the 1C
   passwords. It never goes to our server.
3. **Incoming**: tools for the assistant to list and read incoming documents; the existing
   received-invoice, services and change tools do the entering. Documents whose buyer is another
   organization are listed, not entered (already in the prompt).
4. **Outgoing**: a proposal card for sending (what, to whom, the amounts), the accountant confirms,
   the document is signed (E-IMZO) and sent; the status comes back to the chat. Nothing is sent
   without that confirmation.
5. **Dedup**: a Didox document id is the `externalId` of the 1C record, so a document is never
   entered twice (the PlatformAPI already refuses a second one).

## Risks

- Signing: E-IMZO needs the accountant's key and a local helper; it is the largest unknown.
- A sent document is a legal act. Sending stays behind an explicit card, and the first version
  sends only invoices and acts that were issued from 1C.
- Didox may change the API; the client is one module so the change stays in one place.
