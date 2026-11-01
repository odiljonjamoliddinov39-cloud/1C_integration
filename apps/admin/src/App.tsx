import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminView } from "@platform/shared";
import { useEffect, useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";

import { LanguageSelect } from "@/components/LanguageSelect";
import { Logo } from "@/components/Logo";
import { api, getToken, onTokenChange, setToken } from "@/lib/api";
import { type AreaId, href, useRoute } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AdminsPage } from "@/pages/Admins";
import { ChangePasswordPage } from "@/pages/ChangePassword";
import { CrmSettingsPage } from "@/pages/crm/Settings";
import { FunnelPage } from "@/pages/crm/Funnel";
import { LeadPage } from "@/pages/crm/Lead";
import { LeadsPage } from "@/pages/crm/Leads";
import { ReportsPage } from "@/pages/crm/Reports";
import { AiModelPage } from "@/pages/AiModel";
import { AuditPage } from "@/pages/Audit";
import { CustomerPage } from "@/pages/Customer";
import { CostPage } from "@/pages/Cost";
import { CustomersPage } from "@/pages/Customers";
import { LoginPage } from "@/pages/Login";
import { OverviewPage } from "@/pages/Overview";
import { CreditsPage } from "@/pages/Credits";
import { PlansPage } from "@/pages/Plans";
import { PromoPage } from "@/pages/Promo";
import { RevenuePage } from "@/pages/Revenue";
import { SubscriptionsPage } from "@/pages/Subscriptions";
import { PoliciesPage } from "@/pages/Policies";
import { TemplatesPage } from "@/pages/Templates";
import { UsagePage } from "@/pages/Usage";

/**
 * The dashboard is split into areas, each with its own menu and pages (docs/crm.md): the accounting product's 12 pages, and
 * the CRM. A new area is one more entry here; `roles` says who sees it (a sales manager has the CRM only).
 */
interface NavItem {
  path: string;
  label: string;
  /** Who sees the item; every role of the area when absent. */
  roles?: readonly AdminView["role"][];
}
interface Area {
  id: AreaId;
  label: string;
  roles: readonly AdminView["role"][];
  nav: readonly NavItem[];
}

const AREAS: readonly Area[] = [
  {
    id: "buxgalteriya",
    label: t("Accounting"),
    roles: ["owner", "support"],
    nav: [
      { path: "", label: t("Overview") },
      { path: "customers", label: t("Customers") },
      { path: "subscriptions", label: t("Subscriptions") },
      { path: "revenue", label: t("Revenue") },
      { path: "plans", label: t("Plans") },
      { path: "credits", label: t("AI credits") },
      { path: "promo", label: t("Promo codes") },
      { path: "usage", label: t("AI usage") },
      { path: "cost", label: t("AI cost") },
      { path: "ai", label: t("AI model") },
      { path: "limits", label: t("AI limits") },
      { path: "templates", label: t("Templates") },
      { path: "audit", label: t("Audit log") },
      { path: "admins", label: t("Admins"), roles: ["owner"] },
    ],
  },
  {
    id: "crm",
    label: t("CRM"),
    roles: ["owner", "support", "manager"],
    nav: [
      { path: "leads", label: t("Leads") },
      { path: "funnel", label: t("Funnel") },
      { path: "reports", label: t("Reports") },
      { path: "settings", label: t("Settings"), roles: ["owner", "support"] },
    ],
  },
];

export function App() {
  const token = useSyncExternalStore(onTokenChange, getToken);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!token) queryClient.clear();
  }, [token, queryClient]);
  return token ? <Shell /> : <LoginPage />;
}

function Shell() {
  const [routeArea, routeSection = "", id] = useRoute();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const role = me.data?.role;
  const staff = role !== undefined && role !== "manager";
  const requests = useQuery({
    queryKey: ["credits-report"],
    queryFn: api.creditsReport,
    refetchInterval: 60_000,
    enabled: staff,
  });
  const pending = requests.data?.pendingRequests ?? 0;
  const allowed = AREAS.filter((a) => role && a.roles.includes(role));
  // An area the person may not open (a manager asking for the accounting) is the first one they may.
  const area = allowed.find((a) => a.id === routeArea) ?? allowed[0];
  const section = area?.id === routeArea ? routeSection : "";
  const nav =
    area?.nav.filter((item) => !item.roles || (role !== undefined && item.roles.includes(role))) ?? [];

  if (me.data?.mustChangePassword) return <ChangePasswordPage />;

  return (
    <div className="min-h-screen lg:flex">
      <aside className="bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col">
        <div className="flex items-center gap-3 px-5 py-4 lg:py-6">
          <Logo size={40} className="shrink-0" />
          <div className="min-w-0">
            <div className="text-sm leading-tight font-bold">{t("AI Accounting Assistant")}</div>
            <div className="text-xs font-semibold tracking-wider text-amber-300 uppercase">{t("Admin")}</div>
          </div>
        </div>
        {allowed.length > 1 && (
          <div className="mx-3 mb-2 flex gap-1 rounded-xl bg-white/10 p-1" role="tablist">
            {allowed.map((a) => (
              <a
                key={a.id}
                role="tab"
                aria-selected={a.id === area?.id}
                href={href("", a.id)}
                className={cn(
                  "flex-1 rounded-lg px-3 py-1.5 text-center text-sm font-semibold transition-colors",
                  a.id === area?.id
                    ? "bg-white text-sidebar shadow"
                    : "text-sidebar-foreground/85 hover:bg-white/10",
                )}
              >
                {a.label}
              </a>
            ))}
          </div>
        )}
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:overflow-y-auto">
          {nav.map((item) => (
            <a
              key={item.path}
              href={href(item.path, area?.id)}
              aria-current={section === item.path ? "page" : undefined}
              className={cn(
                "rounded-xl px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors",
                section === item.path
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30"
                  : "text-sidebar-foreground/85 hover:bg-white/10",
              )}
            >
              {item.label}
              {area?.id === "buxgalteriya" && item.path === "credits" && pending > 0 && (
                <span className="ml-2 rounded-full bg-amber-400 px-2 py-0.5 text-xs font-bold text-black">
                  {pending}
                </span>
              )}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-3 border-t border-white/10 px-5 py-3 lg:flex-col lg:items-stretch lg:py-4">
          <div className="min-w-0 text-xs text-sidebar-muted">
            <div className="truncate font-semibold text-sidebar-foreground">{me.data?.email}</div>
            {me.data && <div>{t(me.data.role)}</div>}
          </div>
          <LanguageSelect className="w-full text-foreground" />
          <button
            className="ml-auto rounded-xl border border-white/15 px-3 py-2 text-sm font-semibold text-pink-300 hover:bg-white/10 lg:ml-0"
            onClick={() => setToken(null)}
          >
            {t("Sign out")}
          </button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-7xl p-4 lg:p-8">
          {!me.data ? null : area?.id === "crm" ? (
            <CrmPages me={me.data} section={section} id={id} />
          ) : (
            <AccountingPages me={me.data} section={section} id={id} />
          )}
        </main>
      </div>
    </div>
  );
}

function CrmPages({ me, section, id }: { me: AdminView; section: string; id: string | undefined }) {
  if (section === "leads" && id) return <LeadPage id={id} me={me} />;
  if (section === "funnel") return <FunnelPage me={me} />;
  if (section === "reports") return <ReportsPage me={me} />;
  if (section === "settings" && me.role !== "manager") return <CrmSettingsPage me={me} />;
  return <LeadsPage me={me} />;
}

function AccountingPages({ me, section, id }: { me: AdminView; section: string; id: string | undefined }) {
  switch (section) {
    case "customers":
      return id ? <CustomerPage id={id} me={me} /> : <CustomersPage />;
    case "subscriptions":
      return <SubscriptionsPage accountId={id ?? null} />;
    case "revenue":
      return <RevenuePage />;
    case "plans":
      return <PlansPage me={me} />;
    case "credits":
      return <CreditsPage me={me} />;
    case "promo":
      return <PromoPage me={me} />;
    case "usage":
      return <UsagePage />;
    case "cost":
      return <CostPage />;
    case "ai":
      return <AiModelPage me={me} />;
    case "limits":
      return <PoliciesPage me={me} />;
    case "templates":
      return <TemplatesPage me={me} />;
    case "audit":
      return <AuditPage />;
    case "admins":
      return me.role === "owner" ? <AdminsPage me={me} /> : <OverviewPage />;
    default:
      return <OverviewPage />;
  }
}
