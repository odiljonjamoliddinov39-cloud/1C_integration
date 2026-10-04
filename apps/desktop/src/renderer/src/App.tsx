import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { LicenseBadge, ReadOnlyBanner } from "@/components/LicenseBadge";
import { Button } from "@/components/ui/button";
import { LANGUAGES, type Language, setLanguage } from "@/lib/i18n";
import { CompaniesScreen } from "@/screens/Companies";
import { SignInScreen } from "@/screens/SignIn";

export function App() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: () => window.platform.auth.session() });
  const info = useQuery({ queryKey: ["info"], queryFn: () => window.platform.app.info() });
  const signOut = useMutation({
    mutationFn: () => window.platform.auth.signOut(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });

  if (session.isPending) return null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-card px-6 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
          1C
        </div>
        <span className="font-semibold">{t("appName")}</span>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {session.data && (
            <>
              <LicenseBadge license={session.data.license} />
              <span className="text-muted-foreground" title={session.data.serverUrl}>
                {session.data.email} · {session.data.accountName}
              </span>
            </>
          )}
          <select
            aria-label={t("header.language")}
            className="h-8 rounded-lg border border-border bg-card px-2"
            value={i18n.language}
            onChange={(e) => setLanguage(e.target.value as Language)}
          >
            {Object.entries(LANGUAGES).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          {session.data && (
            <Button variant="ghost" size="sm" onClick={() => signOut.mutate()}>
              {t("header.signOut")}
            </Button>
          )}
        </div>
      </header>
      {info.data?.demo1C && <div className="bg-warning/20 px-6 py-2 text-sm">{t("demoBanner")}</div>}
      {session.data && <ReadOnlyBanner license={session.data.license} />}
      <main className="flex-1">{session.data ? <CompaniesScreen /> : <SignInScreen />}</main>
    </div>
  );
}
