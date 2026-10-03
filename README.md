# 1C Accounting Automation Platform

Removes manual data entry from accounting in Uzbekistan. Data flows from the tax portal, EDO
operators and banks straight into 1C, checked and correct, and an AI assistant audits the books.
The design is in [`docs/technical-design.pdf`](docs/technical-design.pdf).

Three systems in one TypeScript monorepo, plus the 1C extension:

| Part                                                                           | Where                                    | Status        |
| ------------------------------------------------------------------------------ | ---------------------------------------- | ------------- |
| Desktop app (Electron) on the accountant's PC: imports, review, audit, AI chat | `apps/desktop`                           | Phase 0 shell |
| 1C connector: `PlatformAPI` extension + COM client                             | `onec/extension`, `packages/onec-client` | Phase 0       |
| Shared types and JSON contracts                                                | `packages/shared`                        | Phase 0       |
| Control system (Fastify): accounts, licenses, billing, AI proxy                | `apps/api`, `apps/admin`                 | Phase 1       |
| Marketing website (Astro)                                                      | `apps/web`                               | Phase 1       |

Accounting data stays on the client's PC and in their 1C. The cloud only handles accounts,
licenses, payments and AI requests.

## Phase 0: prove we can write one document into 1C

TD §13. Status: [`docs/phase-0.md`](docs/phase-0.md).

- [x] Monorepo skeleton (pnpm, Turborepo, TypeScript strict, ESLint, Prettier, Vitest, CI)
- [x] `PlatformAPI` extension with `Ping`, `GetOrganizations`, `GetMetadata`, `CreateInvoiceReceived`
- [x] Node scripts that call it through `winax` (ping, metadata dump, create invoice)
- [x] Electron shell: sign-in stub, Companies screen, connect company, connector status
- [ ] **On a Windows PC with 1C:** read the real metadata and confirm the field map; run Ping; write one
      unposted Счет-фактура from JSON (the gate). Steps: [`onec/extension/README.md`](onec/extension/README.md)

## Develop

Needs Node 22 and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm test          # unit tests (no 1C needed: a fake PlatformAPI stands in)
pnpm lint && pnpm typecheck && pnpm format:check
pnpm build

# Desktop app
pnpm --filter @platform/desktop dev:demo   # in-memory 1C, on any OS
pnpm --filter @platform/desktop dev        # real 1C over COM (Windows, 64-bit 1C, comcntr.dll registered)
```

On Windows, `pnpm install` builds `winax`, the COM bridge to 1C. For the Electron app, rebuild it
against Electron once: `pnpm --filter @platform/desktop rebuild:native`.

## Layout

```
apps/desktop/          Electron: main/ (1C, storage, IPC), preload/ (typed bridge), renderer/ (React UI)
packages/shared/       Zod schemas: PlatformAPI contract, SourceItem
packages/onec-client/  PlatformAPI client, COM transport (winax), fake 1C for tests, phase-0 scripts
onec/extension/        PlatformAPI extension: BSL sources, build script, setup steps
onec/mapping/          field map of БУ для Узбекистана 3.0 and the metadata dumps
docs/                  technical design, phase notes
```
