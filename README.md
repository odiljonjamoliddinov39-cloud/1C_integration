# 1C Accounting Automation Platform

Removes manual data entry from accounting in Uzbekistan. Data flows from the tax portal, EDO
operators and banks straight into 1C, checked and correct, and an AI assistant audits the books.
The design is in [`docs/technical-design.pdf`](docs/technical-design.pdf).

Three systems in one TypeScript monorepo, plus the 1C extension:

| Part                                                                             | Where                                    | Status        |
| -------------------------------------------------------------------------------- | ---------------------------------------- | ------------- |
| Desktop app (Electron) on the accountant's PC: imports, review, audit, AI chat   | `apps/desktop`                           | Phase 0 shell |
| 1C connector: `PlatformAPI` extension + COM client                               | `onec/extension`, `packages/onec-client` | Phase 0       |
| Shared types and JSON contracts                                                  | `packages/shared`                        | Phase 0       |
| Control system (Fastify): accounts, licenses, billing, AI proxy, admin dashboard | `apps/api`, `apps/admin`                 | Prototype     |
| Marketing website and customer cabinet (Astro, on Vercel)                        | `apps/web`                               | Prototype     |

Accounting data stays on the client's PC and in their 1C. The cloud only handles accounts,
licenses, payments and AI requests.

## Phase 0: prove we can write one document into 1C

TD §13. Status: [`docs/phase-0.md`](docs/phase-0.md).

- [x] Monorepo skeleton (pnpm, Turborepo, TypeScript strict, ESLint, Prettier, Vitest, CI)
- [x] `PlatformAPI` extension with `Ping`, `GetOrganizations`, `GetMetadata`, `RunQuery` (read-only), `CreateInvoiceReceived`
- [x] Node scripts that call it through `winax` (ping, metadata dump, create invoice)
- [x] Electron shell: sign-in stub, Companies screen, connect company, connector status
- [ ] **On a Windows PC with 1C:** read the real metadata and confirm the field map; run Ping; write one
      unposted Счет-фактура from JSON (the gate). Steps: [`onec/extension/README.md`](onec/extension/README.md)

## AI assistant (prototype of TD §7, phase 1)

Read-only chat about a company's books, in the desktop app's **Assistant** tab. It is off per company
until the accountant agrees that 1C data goes to the AI.

```
Desktop app ──question + 1C rows──▶ control system /v1/ai/chat ──▶ Claude API (key on the server)
     ▲   runs the model's 1C queries locally          checks subscription and token quota,
     └── (RunQuery, GetMetadata, GetOrganizations)    adds the prompt and tools, records tokens
```

- Server: `apps/api/src/ai/` (prompt and tools, Claude call, quota). Model `claude-sonnet-5-5` (TD §8),
  `AI_MODEL` to change it; per-account daily cap `AI_DAILY_TOKENS`; plan quota `plans.ai_token_quota`.
- Desktop: `apps/desktop/src/main/assistant.ts` (the tool loop) and `screens/Assistant.tsx`.
- Files: PDF and images go to the model as they are (photos scaled to 1568 px); Excel (.xlsx), Word
  (.docx), CSV and text files are read on the PC and sent as text (`main/attachments.ts`). Up to 5
  files of 10 MB per question; the server accepts files inline only.
- Chat history: each chat is saved on the PC, encrypted with Windows DPAPI like the 1C passwords,
  newest 200 per company (`main/chats.ts`); a reopened chat continues where it stopped.
- The API key reaches the server from the `ANTHROPIC_API_KEY` repository secret on deploy
  ([`docs/deploy.md`](docs/deploy.md)).

### AI cost engine

Keeps AI spend per account predictable without making answers worse. A question stops at the first
step that can answer it; every limit is a row in the `ai_policies` table, edited in the admin
dashboard (**AI limits**), enforced on the server, only read by the app. Until the tariffs are set
there are no spend caps and no read limit (the defaults); the plan's test-plan numbers are $50 a month
per account, $5 a day per user and 8 reads per question.

1. **Budget guard** (`api/src/ai/budget.ts`): per-account monthly and per-user daily USD caps
   (`ai_budgets`, `ai_usage.cost_usd`), a warning at 80 %, a clear stop at 100 %; an owner can set this
   month's cap for one customer on its page (an add-on). `0` is no cap.
2. **Query templates** (`ai/templates.ts` on the PC, `query_templates` table, admin **Templates**): a
   question the rules recognize is answered by a fixed 1C query, 0 tokens, labelled with an
   "Ask AI anyway" button. The matcher is strict: a longer or conditional question goes to the model.
   No template ships enabled: take them from the dearest-questions list on **AI cost**.
3. **Answer cache** (`api/src/ai/cache.ts`, `ai_answer_cache`): a read-only first question of a chat,
   same company, same question, same data version, within `cacheTtlMinutes`. The data version is the
   day, this run of the app and the writes the app made; another user's changes in 1C are covered
   only by the expiry.
4. **Router** (`api/src/ai/router.ts`): simple lookups may use `simpleModel` (off until a test set
   passes); a failed tool step, a declined card or an audit check always uses the default model.
5. **Context** (`api/src/ai/proxy.ts`): prompt order tools → instructions → company structure digest
   (`metadata_digests`, built by `ai/digest.ts` once per configuration version) → day's context →
   chat; cached prefix; clearing of old 1C results at 40K and summarizing (numbers, dates and
   documents kept word for word) above `compactionThreshold`.
6. **Loop guard** (`api/src/ai/loop.ts`): at most `maxToolCalls` 1C reads per question, counted from the
   chat; then the model gets no tools and answers with what it found. Row limits (`defaultRows`,
   `maxRows`) and the compact table format (`ai/toon.ts`, `ai/trim.ts`) apply on the PC.
7. **Logger** (`api/src/ai/usage.ts`): one `ai_usage` row per model call and per free answer
   (feature, route, tool calls, question), shown on **AI cost** with the five engine metrics.

Not built: the batch lane (nothing yet needs a nightly job) and reading the 1C event log for the data
version (needs a PlatformAPI function).

## Prototype deployment

The server (control system) and the Windows installer: [`docs/deploy.md`](docs/deploy.md). Both are
built by GitHub Actions ("Deploy server" and "Desktop app (Windows .exe)").

## Develop

Needs Node 24 and pnpm 10 (`corepack enable`). The 1C COM bridge (`winax`) does not compile on Node 22.

```bash
pnpm install
pnpm test          # unit tests (no 1C needed: a fake PlatformAPI stands in)
pnpm lint && pnpm typecheck && pnpm format:check
pnpm build

# Control system API (needs PostgreSQL)
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/platform JWT_SECRET=$(openssl rand -hex 32)
export LICENSE_PRIVATE_KEY="$(pnpm --silent --filter @platform/api keygen 2>/dev/null)"
export ANTHROPIC_API_KEY=sk-ant-...        # optional: the AI assistant
pnpm --filter @platform/api dev            # http://localhost:3000

# Desktop app (signs in to PLATFORM_API_URL, default http://localhost:3000)
pnpm --filter @platform/desktop dev:demo   # in-memory 1C, on any OS
pnpm --filter @platform/desktop dev        # real 1C over COM (Windows, 64-bit 1C, comcntr.dll registered)

# Website (forwards /api to API_URL, default http://localhost:3000)
pnpm --filter @platform/web dev            # http://localhost:4321
```

On Windows, `pnpm install` builds `winax`, the COM bridge to 1C. For the Electron app, rebuild it
against Electron once: `pnpm --filter @platform/desktop rebuild:native`.

## Layout

```
apps/api/              control system: Fastify, Drizzle/PostgreSQL, licenses (Ed25519), Dockerfile
apps/admin/            admin dashboard (Vite + React), served by the API at /admin/
apps/desktop/          Electron: main/ (1C, storage, IPC, sign-in), preload/ (typed bridge), renderer/ (React UI)
deploy/                docker-compose (PostgreSQL, API, Caddy HTTPS, backups), server setup script
packages/shared/       Zod schemas: PlatformAPI contract, SourceItem
packages/onec-client/  PlatformAPI client, COM transport (winax), fake 1C for tests, phase-0 scripts
onec/extension/        PlatformAPI extension: BSL sources, build script, setup steps
onec/mapping/          field map of БУ для Узбекистана 3.0 and the metadata dumps
docs/                  technical design, phase notes
```
