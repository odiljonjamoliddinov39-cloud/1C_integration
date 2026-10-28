# Telegram remote control

What is built, how to switch it on, and what is still open. The design is "Telegram remote control for the desktop
app — Technical Design"; this file records how the code follows it.

A phone (Telegram bot and Mini App) leaves a request in a mailbox on the server. The desktop app opens an
**outbound** WebSocket to the server, takes what is waiting, runs it against 1C and sends the answer back. The server
never calls the PC, so the PC needs no open port, and a request sent while the PC is off simply waits. Telegram is an
input and output surface only; 1C stays on the PC.

## Where the code is

| Place                                              | What                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/shared/src/remote.ts`                    | Every schema the three halves import: commands, results, WebSocket messages, limits, texts    |
| `apps/api/src/remote/service.ts`                   | The mailbox: pairing, the state machine, idempotency, limits, audit, expiry                   |
| `apps/api/src/remote/hub.ts`                       | The devices' WebSockets (`/remote/device`), ping, delivery oldest first                       |
| `apps/api/src/remote/routes.ts`                    | `/remote/*` for the phone and the PC, and `/telegram/webhook`                                 |
| `apps/api/src/remote/telegram.ts`                  | Bot: `/start <code>`, `/status`, `/unlink`, notifications (counts only), initData check       |
| `apps/api/src/remote/blobs.ts`                     | Files: type and size check, sealed on disk, deleted after download or 24 hours                |
| `apps/api/src/remote/seal.ts`                      | AES-256-GCM for queued content (key: `REMOTE_ENCRYPTION_KEY`, else derived from `JWT_SECRET`) |
| `apps/desktop/src/main/remote/client.ts`           | The outbound WebSocket, reconnect with back-off, hello with `done_ids`, answers sent again    |
| `apps/desktop/src/main/remote/state.ts`            | The token (safeStorage), switches, PIN, `remote_inbox` (ids run + answers), the command log   |
| `apps/desktop/src/main/remote/commands.ts`         | Maps each command to the assistant, with every PC-side check                                  |
| `apps/desktop/src/main/remote/service.ts`          | Pairing from the desktop, links, kill switch, notifications                                   |
| `apps/desktop/src/renderer/src/screens/Remote.tsx` | Remote control screen: connect, phones, kill switch, PIN, ceiling, log                        |
| `apps/miniapp`                                     | The Mini App (Vite + React), served by the API at `/app/`; Uzbek, Russian, English            |

The remote layer adds no accounting logic. A message goes through `AssistantService.send`, a file through the same
attachment readers, a card is answered with the same `decide` as on the PC. 1C writes stay unposted, ExternalID is
checked first by the existing tools, and an error comes back as `{ code, message }`.

## Commands

| Command          | Class           | What runs on the PC                                                                        | Comes back                          |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- |
| `status.get`     | Read            | 1C connection, company, version, last import                                               | online, `onec_reachable`, …         |
| `proposal.list`  | Read            | The cards the assistant made and nobody has answered yet (with each card's hash)           | Cards and their status              |
| `report.make`    | Read            | Balance, debts (receivables + payables), VAT, audit → Excel or PDF, 24 hours on the server | Summary text and the file           |
| `chat.message`   | Read or Prepare | The message through the assistant, in the company's open chat                              | Reply and the cards it produced     |
| `chat.attach`    | Prepare         | The file is read as if attached on the PC (statement, GTD, invoice)                        | Summary; the proposals are unposted |
| `proposal.apply` | Apply           | The confirmed card is applied (documents created, unposted)                                | Created, skipped, refused, reasons  |

Nothing outside this list is accepted. Posting, deletion and marking for deletion are not available from the phone.
Cards that post, change existing documents or need the PC (Didox, removal of marked objects) are listed but cannot be
applied from the phone.

A card nobody has answered keeps the assistant waiting, so a new message meanwhile is refused with `CARD_WAITING`
(apply or decline the card first; the Mini App has a Decline button). `BUSY` means the assistant is really working.

A `chat.message` is a Prepare command when the link may prepare and a Read command when it may not; a Read message
whose answer would be a proposal is declined on the PC (`PREPARE_NOT_ALLOWED`).

## Lifecycle

`queued → delivered → running → done | failed`, and `expired`, `cancelled`. The request id is the command id, so the
same id sent twice (a double tap) is one command. Time to live: 24 hours for Read and Prepare, 2 hours for Apply.

- The PC drops before it acknowledges: back to `queued`.
- It drops while a **Read** runs: back to `queued`, runs again (Read changes nothing).
- It drops while **Prepare or Apply** runs: `failed`, `INTERRUPTED`; the user decides. A write is never repeated.
- The PC keeps every id it has run, with the answer, in `remote_inbox`. A delivery that arrives twice runs once and
  gets the same answer again; at each connection the PC says which ids it holds (`done_ids`) and sends again any
  answer the server may not have.
- Commands run one after another per PC. `status.get`, `proposal.list` and `report.make` may overtake a long one.

## What the PC checks itself (never trusting the server alone)

The kill switch; the time to live; the class against the command's type, the link's ceiling and the PC's own
ceiling; the company, found by its **INN** (a command for company A never runs in company B, whichever is open on
the PC); the license (read-only licenses and over-the-limit companies allow Read only); the payload's schema.

**Apply** also needs: the proposal is still waiting on the PC, its hash equals the hash the phone was shown (otherwise
`PROPOSAL_CHANGED`: the phone says why and shows the list again), the proposal can be applied from a phone, and the
**PIN** set on the PC (Settings → Remote control). With no PIN set an Apply is refused (`PIN_NOT_SET`); five wrong
PINs lock Apply for 15 minutes. The PIN travels with the Apply command over HTTPS to the server, which seals it
like any queued content and drops the whole request content (message, PIN) when the request ends.

## Security and data

- Pairing: the desktop shows a one-time code (8 characters, 10 minutes, single use; only its hash is stored) and a
  link `t.me/<bot>?start=<code>`. The server binds the Telegram id to the account and the PC.
- Who is the caller: the Mini App sends Telegram's signed `initData` (checked with the bot token, rejected when
  older than an hour); the webhook is trusted by its secret header; a Telegram id with no live link is refused.
- The device token is kept with `safeStorage` (Windows DPAPI); the server stores only its hash. The WebSocket carries
  it as the subprotocol `bearer.<token>`.
- **What Telegram sees:** bot messages carry counts only ("12 documents are ready. Open the app."), never an amount,
  name, INN or account number. Content travels only inside the Mini App, over HTTPS, to our server.
- The server holds queued content sealed (AES-256-GCM); a request's content is dropped when it ends (done, failed,
  expired, cancelled), its answer after a week, and the audit rows hold no content. Files: type and size
  checked (20 MB), sealed, deleted after the PC has downloaded them or after 24 hours; outputs live 24 hours.
- Limits: 30 commands a minute per link, 50 open commands per device.
- Kill switch: Settings → Remote control → "Disable remote control" closes the channel, and the server refuses every
  command for the PC. A phone is removed in the same screen or with `/unlink` in the bot.
- Every remote command is written on the PC to the company's operations journal (`Telegram @user: <type> (<id>)`,
  status, the code when it did not run) and to the Remote control screen's log; the server keeps the same audit row
  without content.

## Plans and billing

The plan feature `telegram` switches the channel on for an account (every paid plan; Free has none);
`telegramPriority` (support tier) is the tier whose replies are served first. A read-only license allows Read
commands only. A remote message uses the same AI question quota as one typed on the PC.

## Switching it on

1. Make a bot with @BotFather. In the repository secrets set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`
   (without `@`). The deploy writes them to the server's `.env`; `server-setup.sh` makes `REMOTE_ENCRYPTION_KEY` and
   `TELEGRAM_WEBHOOK_SECRET` once. **Keep `.env` backed up**: a new `REMOTE_ENCRYPTION_KEY` cannot read what the old
   one sealed (queued requests and files, which live a day at most).
2. On start the server registers the webhook (`https://<site>/telegram/webhook`) and the bot's menu button (opens
   `https://<site>/app/`). Without a token the whole remote channel answers `TELEGRAM_OFF`.
3. In the desktop app: **Remote control → Set a PIN → Connect Telegram**. The screen shows a QR code of the link (and the code and link as text): scan it with the phone's camera, Telegram opens and connects the PC.

Environment (apps/api): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, `MINIAPP_URL`,
`REMOTE_ENCRYPTION_KEY`, `REMOTE_BLOB_DIR` (a volume in `deploy/docker-compose.yml`), `REMOTE_JOBS` (`off` in tests:
no pings or sweeps).

## Decisions taken (the design's defaults)

1. Telegram chat shows status and counts only; content only in the Mini App.
2. Server-key encryption (so the server can hold a request while the PC is off), not end to end.
3. The phone may Prepare; Apply needs the Mini App's confirmation and the PIN set on the PC.
4. Statement upload from the phone: allowed, up to 20 MB, sealed, deleted after delivery. The assistant itself reads
   files up to 10 MB; a larger one is refused on the PC with `FILE_TOO_LARGE`.
5. One owner per company; a link's ceiling (`read | prepare | apply`) is chosen when the phone is connected. Roles
   (read-only accountants) are version 2.
6. Russian, Uzbek and English in the Mini App; the bot answers in the language of the user's Telegram.
7. Part of the paid plan; the AI quota is the same as on the PC.

## Acceptance tests

| #   | Test                       | Where it runs                                                                                           |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Offline, then online       | `apps/api/src/remote.test.ts`; `apps/desktop/src/main/remote/e2e.test.ts` (real server, real WebSocket) |
| 2   | Exactly once               | `remote.test.ts` (server rules); `client.test.ts` (inbox, interrupted writes, answers sent again)       |
| 3   | A statement from the phone | `e2e.test.ts`                                                                                           |
| 4   | Apply is guarded           | `commands.test.ts` (hash, PIN, gone); `e2e.test.ts` (stale hash refused, new hash applied)              |
| 5   | Wrong company              | `commands.test.ts` (company by INN)                                                                     |
| 6   | No content in Telegram     | `remote.test.ts`; `e2e.test.ts`                                                                         |
| 7   | Pairing                    | `remote.test.ts` (single use, 10 minutes, `/unlink`, kill switch)                                       |
| 8   | Forged caller              | `remote.test.ts` (initData signature and age, unlinked id, webhook secret)                              |
| 9   | Limits                     | `remote.test.ts` (31st command, 20 MB, read-only license and plan); `commands.test.ts`                  |
| 10  | Output file                | `remote.test.ts` (24 hours); `e2e.test.ts` (Excel downloaded)                                           |
| 11  | Idempotent create          | `remote.test.ts`                                                                                        |
| 12  | Audit                      | `remote.test.ts` (server rows, no content); `commands.test.ts` (journal on the PC)                      |

The desktop tests run against a fake assistant and a fake 1C; `e2e.test.ts` needs PostgreSQL
(`TEST_DATABASE_ADMIN_URL`) and is skipped without it. **Not yet run:** the first four against the real base, which
needs the PC with real 1C.

## Not in version 1

Voice messages, photos of paper documents (OCR), charts as images, a scheduled digest, posting from the phone,
roles, end-to-end encryption, Wake-on-LAN.

## Reliability: no "busy", and a link that comes back by itself

- **The phone is never told the assistant is busy.** A message (or a report) that comes while the assistant answers something else on the PC waits
  its turn (`freeAssistant` in `commands.ts`, up to 10 minutes, then `BUSY` with "send it again"). A card nobody has answered keeps the assistant
  waiting for a click; a new message from the phone **sets it aside** (declines it) and goes on, and the reply says how many were set aside
  (`set_aside`, shown in the Mini App). The `CARD_WAITING` error is no longer produced; the Mini App still knows the text for older PCs.
- **A dead link is found and dialled again.** The PC watches the silence on its WebSocket: when the server says nothing (no pong, no command) for
  longer than the server's own limit (60 s), the connection is dropped and dialled again at once (`client.ts`). A laptop that slept or changed network
  keeps a socket that never closes and never answers; before, it waited for a close event that did not come and the phone saw "the PC is off". The
  desktop also dials again when the laptop resumes or the screen unlocks (`powerMonitor` in `index.ts`, `RemoteService.reconnect`). A command that was
  delivered and not answered is handled by the usual reconnect rules; nothing runs twice (`remote_inbox`).
- **"Waiting" looks in every company.** A notification names no company, so the Mini App's "Waiting" lists the cards of every company on every PC that is
  online (with the company's name above each card when there are several), not only the one chosen at the top.
