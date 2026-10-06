import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import { api, getToken, onTokenChange, setToken } from "@/lib/api";
import { href, useRoute } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AdminsPage } from "@/pages/Admins";
import { AiModelPage } from "@/pages/AiModel";
import { AuditPage } from "@/pages/Audit";
import { CustomerPage } from "@/pages/Customer";
import { CustomersPage } from "@/pages/Customers";
import { LoginPage } from "@/pages/Login";
import { OverviewPage } from "@/pages/Overview";
import { UsagePage } from "@/pages/Usage";

const NAV = [
  { path: "", label: "Overview" },
  { path: "customers", label: "Customers" },
  { path: "usage", label: "AI usage" },
  { path: "ai", label: "AI model" },
  { path: "audit", label: "Audit log" },
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
  const nav = me.data?.role === "owner" ? [...NAV, { path: "admins", label: "Admins" } as const] : NAV;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-1 px-4 py-2">
          <span className="mr-4 flex items-center gap-2 font-semibold">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs text-primary-foreground">
              1C
            </span>
            Admin
          </span>
          {nav.map((item) => (
            <a
              key={item.path}
              href={href(item.path)}
              aria-current={section === item.path ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm hover:bg-muted",
                section === item.path && "bg-muted font-medium",
              )}
            >
              {item.label}
            </a>
          ))}
          <span className="ml-auto text-sm text-muted-foreground">
            {me.data?.email} {me.data && `(${me.data.role})`}
          </span>
          <button className="rounded-md px-3 py-1.5 text-sm hover:bg-muted" onClick={() => setToken(null)}>
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4">
        {!me.data ? null : section === "customers" && id ? (
          <CustomerPage id={id} me={me.data} />
        ) : section === "customers" ? (
          <CustomersPage />
        ) : section === "usage" ? (
          <UsagePage />
        ) : section === "ai" ? (
          <AiModelPage me={me.data} />
        ) : section === "audit" ? (
          <AuditPage />
        ) : section === "admins" && me.data.role === "owner" ? (
          <AdminsPage me={me.data} />
        ) : (
          <OverviewPage />
        )}
      </main>
    </div>
  );
}
