import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { LanguageSelect } from "@/components/LanguageSelect";
import { Logo } from "@/components/Logo";
import { Button, Card, ErrorText, Input } from "@/components/ui";
import { api, setToken } from "@/lib/api";
import { t } from "@/lib/i18n";

/** The first sign-in with a one-time password: nothing else opens until it is changed. */
export function ChangePasswordPage() {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: (me) => queryClient.setQueryData(["me"], me),
  });
  const mismatch = again !== "" && again !== next;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-linear-to-b from-indigo-50 to-background p-4 dark:from-sidebar">
      <div className="flex items-center gap-3">
        <Logo size={44} />
        <div className="text-xl leading-tight font-bold">{t("AI Accounting Assistant")}</div>
      </div>
      <LanguageSelect className="w-full max-w-sm" />
      <Card className="w-full max-w-sm p-6 shadow-lg">
        <h1 className="text-lg font-bold">{t("Choose your own password")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("You signed in with a one-time password. Set a password of your own to go on.")}
        </p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mismatch) change.mutate();
          }}
        >
          <Input
            className="w-full"
            type="password"
            autoComplete="current-password"
            placeholder={t("One-time password")}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
          <Input
            className="w-full"
            type="password"
            autoComplete="new-password"
            placeholder={t("New password (10+ characters)")}
            minLength={10}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
          <Input
            className="w-full"
            type="password"
            autoComplete="new-password"
            placeholder={t("New password again")}
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            required
          />
          {mismatch && <div className="text-sm text-destructive">{t("The passwords differ.")}</div>}
          <ErrorText error={change.error} />
          <Button className="w-full" disabled={change.isPending || mismatch}>
            {t("Save password")}
          </Button>
        </form>
        <button
          className="mt-4 w-full text-center text-sm text-muted-foreground hover:underline"
          onClick={() => setToken(null)}
        >
          {t("Sign out")}
        </button>
      </Card>
    </div>
  );
}
