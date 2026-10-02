import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { LanguageSwitcher, useT, type Key } from "../lib/i18n";
import { useSession } from "../lib/session";
import { Badge } from "./ui";

const NAV: { to: string; label: Key; end?: boolean }[] = [
  { to: "/", label: "nav.dashboard", end: true },
  { to: "/documents", label: "nav.documents" },
  { to: "/findings", label: "nav.findings" },
  { to: "/fixes", label: "nav.fixes" },
  { to: "/invoices", label: "nav.invoices" },
  { to: "/ask", label: "nav.ask" },
];

export function CompanySwitcher() {
  const { companies, companyId, setCompanyId } = useSession();
  const { t } = useT();
  return (
    <select
      className="input w-auto max-w-[16rem] py-1"
      value={companyId ?? ""}
      onChange={(e) => setCompanyId(e.target.value ? Number(e.target.value) : null)}
      aria-label={t("common.company")}
    >
      <option value="">{t("common.allCompanies", { n: companies.length })}</option>
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
  const { t } = useT();
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
        <Badge tone="amber">{company ? t("header.offlineOne") : t("header.offlineMany", { n: offline.length })}</Badge>
      ) : (
        <Badge tone="green">{t("header.online")}</Badge>
      )}
      <span title={t("header.lastSyncedTitle")}>{t("header.lastSynced", { time: fmtDateTime(oldest) })}</span>
      {canWrite && company && (
        <button className="btn-secondary px-2 py-0.5 text-xs" onClick={syncNow} disabled={busy}>
          {busy ? t("header.queued") : t("header.syncNow")}
        </button>
      )}
    </div>
  );
}

export function Layout() {
  const { user, logout, isOwner } = useSession();
  const { t } = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const links: { to: string; label: Key; end?: boolean }[] = [
    ...NAV,
    ...(isOwner ? [{ to: "/admin", label: "nav.admin" as Key }] : []),
    { to: "/settings", label: "nav.settings" },
  ];

  return (
    <div className="min-h-screen lg:flex">
      <aside className={`${menuOpen ? "block" : "hidden"} border-b border-slate-200 bg-white lg:block lg:w-56 lg:shrink-0 lg:border-r lg:border-b-0 dark:border-slate-800 dark:bg-slate-900`}>
        <div className="hidden h-14 items-center gap-2 px-4 font-semibold lg:flex">
          <span className="grid size-7 place-items-center rounded-md bg-brand-600 text-xs font-bold text-white">1C</span>
          {t("app.name")}
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end ?? false}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? "bg-brand-50 text-brand-700 dark:bg-brand-700/25 dark:text-brand-100" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}`
              }
            >
              {t(l.label)}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <button className="btn-ghost px-2 lg:hidden" onClick={() => setMenuOpen((o) => !o)} aria-label={t("nav.menu")}>
            ☰
          </button>
          <CompanySwitcher />
          <SyncStatus />
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="hidden text-slate-500 sm:inline dark:text-slate-400">
              {user?.email} · {user ? t(`role.${user.role}`) : ""}
            </span>
            <LanguageSwitcher />
            <button className="btn-ghost" onClick={logout}>
              {t("header.logout")}
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
