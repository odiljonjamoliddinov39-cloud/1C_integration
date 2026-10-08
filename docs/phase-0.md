# Phase 0: Foundation

Goal (TD §13): prove that our code can write one document into 1C. Gate: **a test Счет-фактура
written from Node**.

| Task (TD §13)                                                            | Done                    | Where                                                                                      |
| ------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------ |
| Monorepo skeleton (pnpm, Turborepo, TS strict, ESLint, Prettier, Vitest) | ✔                       | root, `.github/workflows/ci.yml`                                                           |
| Read БУ для Узбекистана 3.0 metadata and write the document field map    | script ✔, real names ☐  | `GetMetadata`, `pnpm --filter @platform/onec-client metadata`, `onec/mapping/bu-uz-3.0.md` |
| Build the PlatformAPI extension with Ping and GetOrganizations           | ✔ (BSL) ☐ (built in 1C) | `onec/extension`                                                                           |
| Call Ping from a Node script through winax on a test copy                | script ✔, run ☐         | `pnpm --filter @platform/onec-client ping`                                                 |
| Add CreateInvoiceReceived and write one unposted Счет-фактура from JSON  | ✔ code, run ☐           | `PlatformAPI.bsl`, `create-invoice` script                                                 |
| Electron shell: sign-in stub, Companies screen, connector status         | ✔                       | `apps/desktop`                                                                             |

☐ = needs the Windows PC with 1C. Nothing here has run against real 1C yet.

## Run the gate on the Windows PC

1. **Copy a base**, e.g. `TEST_CRYSTAL`. Never use a live base for phase 0.
2. **Create the extension** in the Configurator: [`onec/extension/README.md`](../onec/extension/README.md) §1.
3. **Register the COM connector** (64-bit platform, as administrator):
   `regsvr32 "C:\Program Files\1cv8\<version>\bin\comcntr.dll"`.
4. **Install:** Node 24 x64 (`winax` does not compile on Node 22), pnpm, and **Visual Studio Build Tools 2022** with "Desktop development with C++" (for `winax`; the node-gyp bundled with pnpm does not recognize Visual Studio 2026 yet). Then run `pnpm install` in the repo.
5. **Run the checks:**
   ```powershell
   $env:ONEC_PASSWORD = "..."
   pnpm --filter @platform/onec-client ping -- --file "D:\Bases\TEST_CRYSTAL" --user Admin
   pnpm --filter @platform/onec-client metadata -- --file "D:\Bases\TEST_CRYSTAL" --user Admin
   ```
6. **Confirm the field map.** Compare `onec/mapping/*.metadata.json` with `PlatformAPI_Map.bsl`, fix
   any name that differs, and mark the names ✔ in `onec/mapping/bu-uz-3.0.md`.
7. **Write the test invoice.** Edit `packages/onec-client/fixtures/invoice-received.sample.json` so it
   uses a supplier INN and an item that exist in the copy, then run:
   ```powershell
   pnpm --filter @platform/onec-client create-invoice -- --file "D:\Bases\TEST_CRYSTAL" --user Admin fixtures/invoice-received.sample.json
   ```
   Check in 1C that one **unposted** Счет-фактура полученный appeared, and that it has a
   `PlatformLog` record. Run the command again: it must answer `"duplicate": true` and create nothing.
8. **Check the desktop app:** `pnpm --filter @platform/desktop rebuild:native`, then
   `pnpm --filter @platform/desktop dev`. Connect the copy and check that the status shows
   **Connected**.

When step 7 passes, the core is proven and phase 1 (Didox import, bank files, inbox, review,
control system) can start.

## Open questions that block phase 1 (TD §14)

Didox API access and test account · bank export formats of the first five companies · enough 1C
licenses for app + users · product name and domain · plans and prices · Payme merchant account ·
hosting in Uzbekistan · code-signing certificate.
