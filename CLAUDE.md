# Notes for working in this repo

- The design is in `docs/technical-design.pdf`; phases and their gates are in TD §13. Keep to the
  current phase (see `docs/phase-0.md`).
- TypeScript is strict everywhere. Shared contracts live in `packages/shared` as Zod schemas, and
  the 1C extension must answer exactly those shapes (`packages/shared/src/platform-api.ts`).
- 1C writes: unposted only, `ExternalID` checked first, one transaction, a `PlatformLog` record.
  Errors are `{code, message, details}`, never a bare 1C exception.
- Secrets (1C passwords, tokens) never go into plain files, logs or SQLite: use `safeStorage`.
- Accounting data never leaves the client PC, except AI requests through our proxy (phase 1+).
- Before pushing, run `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check && pnpm build`.
