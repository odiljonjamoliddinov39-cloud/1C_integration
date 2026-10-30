import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";

import { LanguageSelect } from "@/components/LanguageSelect";
import { Logo } from "@/components/Logo";
import { api, getToken, onTokenChange, setToken } from "@/lib/api";
import { href, useRoute } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AdminsPage } from "@/pages/Admins";
import { AiModelPage } from "@/pages/AiModel";
import { AuditPage } from "@/pages/Audit";
import { CustomerPage } from "@/pages/Customer";
import { CostPage } from "@/pages/Cost";
import { CustomersPage } from "@/pages/Customers";
import { LoginPage } from "@/pages/Login";
import { OverviewPage } from "@/pages/Overview";
import { PlansPage } from "@/pages/Plans";
import { PromoPage } from "@/pages/Promo";
import { RevenuePage } from "@/pages/Revenue";
import { SubscriptionsPage } from "@/pages/Subscriptions";
import { PoliciesPage } from "@/pages/Policies";
import { TemplatesPage } from "@/pages/Templates";
import { UsagePage } from "@/pages/Usage";

const NAV = [
  { path: "", label: t("Overview") },
  { path: "customers", label: t("Customers") },
  { path: "subscriptions", label: t("Subscriptions") },
  { path: "revenue", label: t("Revenue") },
  { path: "plans", label: t("Plans") },
  { path: "promo", label: t("Promo codes") },
  { path: "usage", label: t("AI usage") },
  { path: "cost", label: t("AI cost") },
  { path: "ai", label: t("AI model") },
  { path: "limits", label: t("AI limits") },
  { path: "templates", label: t("Templates") },
  { path: "audit", label: t("Audit log") },
] as const;

export function App() {
  const token = useSyncExternalStore(onTokenChange, getToken);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!token) queryClient.clear();
  }, [token, queryClient]);
  return token ? <Shell /> : <LoginPage />;
}

function Shell() {
  const route = useRoute();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const [section = "", id] = route;
  const nav = me.data?.role === "owner" ? [...NAV, { path: "admins", label: t("Admins") } as const] : NAV;

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
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:overflow-y-auto">
          {nav.map((item) => (
            <a
              key={item.path}
              href={href(item.path)}
              aria-current={section === item.path ? "page" : undefined}
              className={cn(
                "rounded-xl px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors",
                section === item.path
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30"
                  : "text-sidebar-foreground/85 hover:bg-white/10",
              )}
            >
              {item.label}
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
          {!me.data ? null : section === "customers" && id ? (
            <CustomerPage id={id} me={me.data} />
          ) : section === "customers" ? (
            <CustomersPage />
          ) : section === "subscriptions" ? (
            <SubscriptionsPage accountId={id ?? null} />
          ) : section === "revenue" ? (
            <RevenuePage />
          ) : section === "plans" ? (
            <PlansPage me={me.data} />
          ) : section === "promo" ? (
            <PromoPage me={me.data} />
          ) : section === "usage" ? (
            <UsagePage />
          ) : section === "cost" ? (
            <CostPage />
          ) : section === "ai" ? (
            <AiModelPage me={me.data} />
          ) : section === "limits" ? (
            <PoliciesPage me={me.data} />
          ) : section === "templates" ? (
            <TemplatesPage me={me.data} />
          ) : section === "audit" ? (
            <AuditPage />
          ) : section === "admins" && me.data.role === "owner" ? (
            <AdminsPage me={me.data} />
          ) : (
            <OverviewPage />
          )}
        </main>
      </div>
    </div>
  );
}
