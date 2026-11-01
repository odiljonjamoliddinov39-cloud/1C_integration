import { useState } from "react";

import { useAuth } from "../context.js";
import { ApiError } from "../lib/api.js";
import { errorText } from "../lib/i18n.js";

/** Sign-in with the person's own email and password (the ones of the admin dashboard); the owner gives them. */
export function SignIn({ onDone }: { onDone: (mustChangePassword: boolean) => void }) {
  const { api, words, lang, setLang } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(email, password);
      onDone(session.mustChangePassword);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : new ApiError("UNKNOWN", String(err));
      setError(errorText(words, apiError.code, apiError.message));
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <form className="stack signin" onSubmit={(e) => void submit(e)}>
        <h1>{words.title}</h1>
        <p className="hint">{words.signInHint}</p>
        <input
          className="field"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          placeholder={words.email}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="field"
          type="password"
          autoComplete="current-password"
          placeholder={words.password}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn" disabled={busy}>
          {words.signIn}
        </button>
        <button type="button" className="link" onClick={() => setLang(lang === "uz" ? "ru" : "uz")}>
          {lang === "uz" ? "Русский" : "Oʻzbekcha"}
        </button>
      </form>
    </div>
  );
}
