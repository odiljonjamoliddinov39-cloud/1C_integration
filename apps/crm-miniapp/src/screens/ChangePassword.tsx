import { useState } from "react";

import { useAuth } from "../context.js";
import { ApiError } from "../lib/api.js";
import { errorText } from "../lib/i18n.js";

/** The first sign-in is with a one-time password: nothing else opens until the person chooses their own. */
export function ChangePassword({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const { api, words } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = again !== "" && again !== next;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      onDone();
    } catch (err) {
      const apiError = err instanceof ApiError ? err : new ApiError("UNKNOWN", String(err));
      setError(errorText(words, apiError.code, apiError.message));
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <form className="stack signin" onSubmit={(e) => void submit(e)}>
        <h1>{words.newPasswordTitle}</h1>
        <p className="hint">{words.newPasswordHint}</p>
        <input
          className="field"
          type="password"
          autoComplete="current-password"
          placeholder={words.oneTimePassword}
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          placeholder={words.newPassword}
          minLength={10}
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          placeholder={words.newPasswordAgain}
          required
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
        {mismatch && <p className="error">{words.passwordsDiffer}</p>}
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn" disabled={busy || mismatch}>
          {words.save}
        </button>
        <button type="button" className="link" onClick={onSignOut}>
          {words.signOut}
        </button>
      </form>
    </div>
  );
}
