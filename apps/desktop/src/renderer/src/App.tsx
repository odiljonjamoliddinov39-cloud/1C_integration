import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import spaceEngineering from "@/assets/space-engineering.webp";
import { LanguageSelect } from "@/components/LanguageSelect";
import { LimitProvider } from "@/components/Limit";
import { LicenseCard, ReadOnlyBanner } from "@/components/LicenseBadge";
import { Logo } from "@/components/Logo";
import { SPLASH_MIN_MS, SplashLoader } from "@/components/SplashLoader";
import { UpdateBanner, VersionButton, useUpdateState } from "@/components/Updates";
import { useBilling } from "@/lib/billing";
import { cn } from "@/lib/utils";
import { AssistantScreen } from "@/screens/Assistant";
import { CompaniesScreen } from "@/screens/Companies";
import { RemoteScreen } from "@/screens/Remote";
import { ReportsScreen } from "@/screens/Reports";
import { SignInScreen } from "@/screens/SignIn";

const SCREENS = ["companies", "assistant", "reports", "remote"] as const;
type Screen = (typeof SCREENS)[number];

const icons: Record<Screen, ReactNode> = {
  companies: (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="18" height="13" rx="3" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" />
    </svg>
  ),
  reports: (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  ),
  remote: (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  ),
  assistant: (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    </svg>
  ),
};

export function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<Screen>("companies");
  /** The company the assistant opens on, when it was reached from a company's card. */
  const [assistantFor, setAssistantFor] = useState<string | null>(null);
  const session = useQuery({ queryKey: ["session"], queryFn: () => window.platform.auth.session() });
  const info = useQuery({ queryKey: ["info"], queryFn: () => window.platform.app.info() });
  const update = useUpdateState();
  const billing = useBilling();
  const signOut = useMutation({
    mutationFn: () => window.platform.auth.signOut(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });

  // The start-up screen stays for a moment at least, and until the session is known.
  const [minShown, setMinShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setMinShown(true), SPLASH_MIN_MS);
    return () => clearTimeout(timer);
  }, []);
  const splash = <SplashLoader done={minShown && !session.isPending} />;
  if (session.isPending) return splash;
  const user = session.data;

  return (
    <LimitProvider>
      {splash}
      <div className="flex h-screen">
        {user && (
          <aside className="flex w-68 shrink-0 flex-col gap-5 overflow-y-auto bg-sidebar p-5 text-sidebar-foreground">
            <div className="flex items-center gap-3">
              <Logo size={40} className="shrink-0" />
              <div className="min-w-0">
                <div className="text-base leading-tight font-bold">{t("appName")}</div>
                {info.data && <VersionButton version={info.data.version} state={update} />}
              </div>
            </div>
            <nav className="flex flex-col gap-1.5">
              {SCREENS.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-current={screen === name ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-semibold transition-colors",
                    screen === name
                      ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30"
                      : "text-sidebar-foreground/85 hover:bg-white/10",
                  )}
                  onClick={() => {
                    if (name === "assistant") setAssistantFor(null);
                    setScreen(name);
                  }}
                >
                  {icons[name]}
                  {t(`nav.${name}`)}
                </button>
              ))}
            </nav>
            <LicenseCard license={user.license} billing={billing} />
            <div className="mt-auto space-y-3">
              <div>
                <div className="mb-1.5 px-1 text-xs text-sidebar-muted">{t("header.language")}</div>
                <LanguageSelect />
              </div>
              <div className="flex items-center gap-3 px-1" title={user.serverUrl}>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pink-500 text-base font-bold text-white">
                  {(user.name || user.email).slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 text-sm">
                  <div className="truncate font-semibold">{user.email}</div>
                  <div className="truncate text-xs text-sidebar-muted">{user.accountName}</div>
                </div>
              </div>
              <button
                type="button"
                className="h-11 w-full rounded-xl border border-white/15 text-sm font-semibold text-pink-300 hover:bg-white/10"
                onClick={() => signOut.mutate()}
              >
                {t("header.signOut")}
              </button>
              <div className="flex flex-col items-center gap-1.5 pt-1 text-[11px] text-sidebar-muted">
                <span>{t("splash.madeBy")}</span>
                <span className="flex items-center gap-2 font-semibold text-sidebar-foreground/90">
                  <img src={spaceEngineering} alt="" width={22} height={22} className="rounded-md" />
                  Space Engineering
                </span>
              </div>
            </div>
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <UpdateBanner state={update} />
          {info.data?.demo1C && <div className="bg-warning/20 px-6 py-2 text-sm">{t("demoBanner")}</div>}
          {user && <ReadOnlyBanner license={user.license} />}
          <main className="min-h-0 flex-1 overflow-y-auto">
            {!user ? (
              <SignInScreen />
            ) : screen === "assistant" ? (
              <AssistantScreen initialCompanyId={assistantFor} />
            ) : screen === "reports" ? (
              <ReportsScreen />
            ) : screen === "remote" ? (
              <RemoteScreen />
            ) : (
              <CompaniesScreen
                onOpenAssistant={(companyId) => {
                  setAssistantFor(companyId);
                  setScreen("assistant");
                }}
              />
            )}
          </main>
        </div>
      </div>
    </LimitProvider>
  );
}
