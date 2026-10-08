import { type FormEvent, useEffect, useState } from "react";

import { ApiError, login, register, signedIn } from "../lib/api";
import { type Locale, dict, href } from "../lib/i18n";

const field =
  "h-10 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-primary";

/** Sign-up (14-day trial) and sign-in. The same account signs in to the desktop app. */
export function AuthForm({ locale, mode }: { locale: Locale; mode: "signup" | "login" }) {
  const t = dict(locale).auth;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cabinet = href(locale, "/cabinet");

  useEffect(() => {
    if (signedIn()) window.location.replace(cabinet);
  }, [cabinet]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "");
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        await register({
          name: value("name"),
          accountName: value("accountName"),
          email: value("email"),
          password: value("password"),
        });
      } else {
        await login(value("email"), value("password"));
      }
      window.location.assign(cabinet);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "default";
      setError(t.errors[code as keyof typeof t.errors] ?? t.errors.default);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {mode === "signup" && (
        <>
          <label className="block space-y-1 text-sm">
            <span>{t.name}</span>
            <input name="name" required autoComplete="name" className={field} />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t.accountName}</span>
            <input name="accountName" required autoComplete="organization" className={field} />
          </label>
        </>
      )}
      <label className="block space-y-1 text-sm">
        <span>{t.email}</span>
        <input name="email" type="email" required autoComplete="email" className={field} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>{t.password}</span>
        <input
          name="password"
          type="password"
          required
          minLength={mode === "signup" ? 10 : 1}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          className={field}
        />
        {mode === "signup" && <span className="text-xs text-muted-foreground">{t.passwordHint}</span>}
      </label>
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="h-10 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
      >
        {busy ? t.working : mode === "signup" ? t.submitSignup : t.submitLogin}
      </button>
      <p className="text-center text-sm">
        <a className="text-primary underline" href={href(locale, mode === "signup" ? "/login" : "/signup")}>
          {mode === "signup" ? t.haveAccount : t.noAccount}
        </a>
      </p>
    </form>
  );
}
