import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useSession } from "../lib/session";
import { Badge } from "./ui";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/documents", label: "Documents" },
  { to: "/findings", label: "Audit findings" },
  { to: "/fixes", label: "Corrections" },
  { to: "/invoices", label: "Schet-faktura" },
  { to: "/ask", label: "Ask AI" },
];

export function CompanySwitcher() {
  const { companies, companyId, setCompanyId } = useSession();
  return (
    <select
      className="input w-auto max-w-[16rem] py-1"
      value={companyId ?? ""}
      onChange={(e) => setCompanyId(e.target.value ? Number(e.target.value) : null)}
      aria-label="Company"
    >
      <option value="">All companies ({companies.length})</option>
      {companies.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function SyncStatus() {
  const { company, companies, canWrite, reloadCompanies } = useSession();
  const [busy, setBusy] = useState(false);
  const scope = company ? [company] : companies;
  if (scope.length === 0) return null;
  const offline = scope.filter((c) => c.agent_online === false);
  const oldest = scope.map((c) => c.last_synced_at).filter(Boolean).sort()[0] ?? null;

  async function syncNow() {
    if (!company) return;
    setBusy(true);
    try {
      await api(`/api/companies/${company.id}/sync`, { method: "POST" });
      setTimeout(() => void reloadCompanies(), 3000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      {offline.length > 0 ? (
        <Badge tone="amber">{company ? "1C offline" : `${offline.length} offline`} · showing mirror</Badge>
      ) : (
        <Badge tone="green">1C online</Badge>
      )}
      <span title="Oldest last sync in the current view">Last synced {fmtDateTime(oldest)}</span>
      {canWrite && company && (
        <button className="btn-secondary px-2 py-0.5 text-xs" onClick={syncNow} disabled={busy}>
          {busy ? "Queued…" : "Sync now"}
        </button>
      )}
    </div>
  );
}

export function Layout() {
  const { user, logout, isOwner } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const links = [...NAV, ...(isOwner ? [{ to: "/admin", label: "Admin" }] : []), { to: "/settings", label: "Settings" }];

  return (
    <div className="min-h-screen lg:flex">
      <aside className={`${menuOpen ? "block" : "hidden"} border-b border-slate-200 bg-white lg:block lg:w-56 lg:shrink-0 lg:border-r lg:border-b-0 dark:border-slate-800 dark:bg-slate-900`}>
        <div className="hidden h-14 items-center gap-2 px-4 font-semibold lg:flex">
          <span className="grid size-7 place-items-center rounded-md bg-brand-600 text-xs font-bold text-white">1C</span>
          Integration
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={"end" in l ? l.end : false}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? "bg-brand-50 text-brand-700 dark:bg-brand-700/25 dark:text-brand-100" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <button className="btn-ghost px-2 lg:hidden" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
            ☰
          </button>
          <CompanySwitcher />
          <SyncStatus />
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="hidden text-slate-500 sm:inline dark:text-slate-400">
              {user?.email} · {user?.role}
            </span>
            <button className="btn-ghost" onClick={logout}>
              Log out
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
