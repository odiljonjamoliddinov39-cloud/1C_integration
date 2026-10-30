import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "@/lib/i18n";

import { LanguageSelect } from "@/components/LanguageSelect";
import { Logo } from "@/components/Logo";
import { Button, Card, ErrorText, Input } from "@/components/ui";
import { api, setToken } from "@/lib/api";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (session) => setToken(session.accessToken),
  });
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-linear-to-b from-indigo-50 to-background p-4 dark:from-sidebar">
      <div className="flex items-center gap-3">
        <Logo size={44} />
        <div>
          <div className="text-xl leading-tight font-bold">{t("AI Accounting Assistant")}</div>
          <div className="text-xs font-semibold tracking-wider text-amber-600 uppercase">{t("Admin")}</div>
        </div>
      </div>
      <LanguageSelect className="w-full max-w-sm" />
      <Card className="w-full max-w-sm p-6 shadow-lg">
        <h1 className="text-lg font-bold">{t("Sign in")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("For our staff only.")}</p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <Input
            className="w-full"
            type="email"
            autoComplete="username"
            placeholder={t("Email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            className="w-full"
            type="password"
            autoComplete="current-password"
            placeholder={t("Password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <ErrorText error={login.error} />
          <Button className="w-full" disabled={login.isPending}>
            {t("Sign in")}
          </Button>
        </form>
      </Card>
    </div>
  );
}
