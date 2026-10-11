import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { errorText } from "@/components/ConnectorStatus";
import { LanguageSelect } from "@/components/LanguageSelect";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, ErrorText } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

export function SignInScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ["info"], queryFn: () => window.platform.app.info() });
  const [creating, setCreating] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [accountName, setAccountName] = useState("");
  const server = serverUrl ?? info.data?.defaultServerUrl ?? "";

  const submit = useMutation({
    mutationFn: () =>
      creating
        ? window.platform.auth.register({ serverUrl: server, email, password, name, accountName })
        : window.platform.auth.signIn({ serverUrl: server, email, password }),
    onSuccess: (result) => {
      if (result.ok) void queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });
  const error = submit.data && !submit.data.ok ? errorText(t, submit.data.code, submit.data.message) : null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit.mutate();
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-linear-to-b from-indigo-50 to-background p-6">
      <div className="flex items-center gap-3">
        <Logo size={44} />
        <span className="text-2xl font-bold tracking-tight">{t("appName")}</span>
      </div>
      <Card className="w-full max-w-sm p-6 shadow-lg">
        <h1 className="text-xl font-semibold">{creating ? t("signIn.createTitle") : t("signIn.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("signIn.subtitle")}</p>
        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          {creating && (
            <>
              <div>
                <Label htmlFor="name">{t("signIn.name")}</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="accountName">{t("signIn.accountName")}</Label>
                <Input
                  id="accountName"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  required
                />
              </div>
            </>
          )}
          <div>
            <Label htmlFor="email">{t("signIn.email")}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="password">{t("signIn.password")}</Label>
            <Input
              id="password"
              type="password"
              autoComplete={creating ? "new-password" : "current-password"}
              minLength={creating ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <details className="text-xs text-muted-foreground" open={serverUrl !== null}>
            <summary className="cursor-pointer">
              {t("signIn.server")}: {server}
            </summary>
            <Input
              className="mt-2"
              id="server"
              value={server}
              onChange={(e) => setServerUrl(e.target.value)}
              required
            />
          </details>
          {error && <ErrorText>{error}</ErrorText>}
          <Button className="w-full" disabled={submit.isPending}>
            {creating ? t("signIn.create") : t("signIn.submit")}
          </Button>
        </form>
        <button className="mt-4 text-xs text-primary hover:underline" onClick={() => setCreating(!creating)}>
          {creating ? t("signIn.haveAccount") : t("signIn.noAccount")}
        </button>
      </Card>
      <div className="w-40">
        <LanguageSelect className="border-border bg-card text-foreground" />
      </div>
    </div>
  );
}
