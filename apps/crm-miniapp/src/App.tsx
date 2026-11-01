import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CrmMe, CrmPipelineView } from "@platform/shared";

import { Ctx } from "./context.js";
import { Api, ApiError } from "./lib/api.js";
import { DICTIONARIES, type Lang, errorText, pickLanguage } from "./lib/i18n.js";
import { telegramLanguage } from "./lib/telegram.js";
import { ChangePassword } from "./screens/ChangePassword.js";
import { LeadCard } from "./screens/LeadCard.js";
import { LeadList } from "./screens/LeadList.js";
import { NewLead } from "./screens/NewLead.js";
import { SignIn } from "./screens/SignIn.js";

type View = { name: "list" } | { name: "new" } | { name: "lead"; id: string };
/** Where the person is: signing in, choosing their own password, or at work. */
type Phase = "checking" | "signin" | "password" | "work";

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function App() {
  const api = useMemo(() => new Api(), []);
  const [lang, setLangState] = useState<Lang>(() => pickLanguage(read("lang"), telegramLanguage()));
  const words = DICTIONARIES[lang];
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem("lang", next);
    } catch {
      // The choice is kept for this visit only.
    }
  }, []);
  const [phase, setPhase] = useState<Phase>(api.signedIn ? "checking" : "signin");
  const [me, setMe] = useState<CrmMe | null>(null);
  const [funnel, setFunnel] = useState<CrmPipelineView | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [view, setView] = useState<View>({ name: "list" });
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback((text: string) => {
    setMessage(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 2600);
  }, []);
  const reloadFunnel = useCallback(async () => setFunnel(await api.funnel()), [api]);
  const signOut = useCallback(() => {
    api.signOut();
    setMe(null);
    setFunnel(null);
    setView({ name: "list" });
    setPhase("signin");
  }, [api]);

  /** Loads who the person is and the funnel; a refused token or a one-time password sends them to the right screen. */
  const start = useCallback(async () => {
    try {
      setError(null);
      setMe(await api.me());
      await reloadFunnel();
      setPhase("work");
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      if (err.status === 401) setPhase("signin");
      else if (err.code === "PASSWORD_CHANGE_REQUIRED") setPhase("password");
      else setError({ code: err.code, message: err.message });
    }
  }, [api, reloadFunnel]);
  useEffect(() => {
    if (api.signedIn) void start();
  }, [api, start]);

  const auth = { api, words, lang, setLang };

  if (phase === "signin")
    return (
      <Ctx.Provider value={auth}>
        <SignIn onDone={(mustChange) => (mustChange ? setPhase("password") : void start())} />
      </Ctx.Provider>
    );
  if (phase === "password")
    return (
      <Ctx.Provider value={auth}>
        <ChangePassword onDone={signOut} onSignOut={signOut} />
      </Ctx.Provider>
    );
  if (error)
    return (
      <div className="centered">
        <div>
          <p>{errorText(words, error.code, error.message)}</p>
          <button type="button" className="btn" onClick={() => void start()}>
            {words.tryAgain}
          </button>
        </div>
      </div>
    );
  if (phase === "checking" || !me || !funnel) return <div className="centered">{words.loading}</div>;

  const app = { ...auth, me, funnel, reloadFunnel, signOut, toast };
  return (
    <Ctx.Provider value={app}>
      <div className="app">
        {view.name === "list" && (
          <LeadList onOpen={(id) => setView({ name: "lead", id })} onNew={() => setView({ name: "new" })} />
        )}
        {view.name === "new" && (
          <NewLead onBack={() => setView({ name: "list" })} onOpen={(id) => setView({ name: "lead", id })} />
        )}
        {view.name === "lead" && <LeadCard id={view.id} onBack={() => setView({ name: "list" })} />}
        {message && <div className="toast">{message}</div>}
      </div>
    </Ctx.Provider>
  );
}
