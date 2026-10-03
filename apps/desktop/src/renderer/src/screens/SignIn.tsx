import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, ErrorText } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

export function SignInScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useMutation({
    mutationFn: () => window.platform.auth.signIn({ email, password }),
    onSuccess: (result) => {
      if (result.ok) void queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });
  const error = signIn.data && !signIn.data.ok ? signIn.data.message : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    signIn.mutate();
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center p-6">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-xl font-semibold">{t("signIn.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("signIn.subtitle")}</p>
        <form onSubmit={submit} className="mt-5 space-y-3">
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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          <Button className="w-full" disabled={signIn.isPending}>
            {t("signIn.submit")}
          </Button>
        </form>
        <p className="mt-4 text-xs text-muted-foreground">{t("signIn.stub")}</p>
      </Card>
    </div>
  );
}
