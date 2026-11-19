# TD: find the infobase + credentials instead of asking for them

## Problem

Step one of onboarding is "Connect company" (`ConnectCompanyDialog.tsx`): a blank form asking for
the infobase location and, often, a 1C login/password. Most accountants don't know that
login/password — someone else set the base up once, and they just double-click a shortcut that
logs them in automatically. Today's form has nothing to offer them but a blank field and, if they
give up, "ask whoever installed 1C."

## What's already true in the code (not new)

- `ConnectionInput` (`apps/desktop/src/shared/ipc.ts`) already allows blank `user`/`password` —
  neither field is `.min(1)`.
- `connection-string.ts` already omits `Usr=`/`Pwd=` entirely when they're empty:
  `if (user) parts.push(...)`. An empty-credential connection already falls through to whatever
  the base itself does with no explicit login — OS authentication, or no authentication
  configured at all. Both are common on small/SMB bases.
- `ConnectCompanyDialog.tsx` already doesn't mark `user`/`password` as `required`.

So the "try with nothing" path already works end-to-end today. The gap is entirely UX: nothing
tells the user to try it, and nothing pre-fills the form from something that's already sitting on
their machine, proving a working connection every single day.

## Design: read it off the machine, don't ask the human

Every computer that runs 1C daily already has at least one of:

1. **A desktop/Start Menu shortcut** whose target launches `1cv8.exe`/`1cv8c.exe` with a full
   connection — frequently including `/N"user"` and `/P"password"` baked in, because whoever set
   it up specifically wanted nobody to have to type anything.
2. **1C's own known-bases list**, `ibases.v8i` — an INI-like file 1C itself writes, per-user at
   `%APPDATA%\1C\1CEStart\ibases.v8i` and shared at `%PROGRAMDATA%\1C\1CEStart\ibases.v8i` — with
   a `Connect=` string per base, in the same `File=...;Usr=...;Pwd=...` / `Srvr=...;Ref=...`
   grammar `connection-string.ts` already parses (today only in the write direction; this needs
   the read/parse direction too).

Both are plaintext, already readable by the Windows account the app is running under (the same
account that already opens 1C fine), so reading them crosses no new trust boundary — it's the
same tier of access the existing folder-picker already has.

### New main-process capability: `discoverInfobases()`

- Windows-only; returns `[]` immediately elsewhere (same guard style as `registerComConnector`).
- Scans, in order: Desktop (current user + Public), Start Menu (current user + ProgramData) for
  `.lnk` files targeting `1cv8*.exe`; both `ibases.v8i` locations.
- Resolves each `.lnk`'s target + arguments via a short PowerShell one-liner over
  `WScript.Shell` (`(New-Object -COM WScript.Shell).CreateShortcut($path)`) — no new native
  dependency, PowerShell is always present on the Windows versions 1C itself supports.
- Parses `1cv8` launch arguments (`/F`, `/S`, `/N`, `/P`) and `ibases.v8i`'s `Connect=` strings
  into `InfobaseInput` + optional `user`/`password`, mirroring `connection-string.ts` in reverse.
- De-duplicates by normalized location; returns
  `{ infobase: InfobaseInput; user: string; password: string; source: "shortcut" | "ibases"; label: string }[]`.

### IPC + UI

- New channel `discoverInfobases` (`handlers.ts`, `preload/index.ts`, `ipc.ts`), same pattern as
  `pickFolder`.
- `ConnectCompanyDialog` calls it on open. Found candidates render as clickable cards above the
  form ("TEST_CRYSTAL — found on your computer"); clicking one pre-fills the form and immediately
  runs `testConnection`.
- Nothing found, or the user ignores the cards: today's manual form, unchanged, but the
  user/password hint changes from implying they're needed to "most setups don't need this — leave
  blank and hit Test first."
- `testConnection`/`save` paths are untouched. A discovered password is held in memory exactly
  like a typed one and follows the existing `safeStorage` path on save — no new persistence code.

### Explicitly out of scope for this TD

- Detecting a currently-running 1C process's live session (stretch; skip for v1).
- Having the app provision its *own* 1C user once it has any working access (the "stop depending
  on the human's credentials at all" idea) — bigger change, its own TD if we come back to it.
- macOS/Linux — the COM transport is Windows-only already (TD §5); discovery is too.

### Fallback, unchanged

Discovery empty, blank-credential test fails, and the human genuinely doesn't know anything:
that's still "go ask whoever set this up" — now the rare last resort instead of the first thing
everyone hits.

### Tests

- Discovery's parsing (shortcut target/args, `ibases.v8i` entries) is pure string/file parsing —
  fixture files in a temp dir, asserted against like `connection-string.test.ts`, no real Windows
  API needed, runs in CI same as everything else.
- The live scan itself (actually walking Desktop/Start Menu, shelling to PowerShell) gets a thin
  injectable wrapper, same shape as `loadWinax()`'s test seam in `com-transport.ts`.

## Rough sizing

- Discovery module (scan + parse): ~1 day
- IPC + UI (candidate cards, pre-fill, re-worded fallback copy): ~1 day
- Tests: ~0.5 day
