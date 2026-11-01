import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CrmMe, CrmPipelineView } from "@platform/shared";

import { Ctx } from "./context.js";
import { Api, ApiError } from "./lib/api.js";
import { DICTIONARIES, type Lang, errorText, pickLanguage } from "./lib/i18n.js";
import { initData, insideTelegram, telegramLanguage } from "./lib/telegram.js";
import { LeadCard } from "./screens/LeadCard.js";
import { LeadList } from "./screens/LeadList.js";
import { NewLead } from "./screens/NewLead.js";

type View = { name: "list" } | { name: "new" } | { name: "lead"; id: string };

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function App() {
  const api = useMemo(() => new Api(initData), []);
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

  const start = useCallback(async () => {
    try {
      setError(null);
      setMe(await api.session());
      await reloadFunnel();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError({ code: err.code, message: err.message });
    }
  }, [api, reloadFunnel]);
  useEffect(() => {
    if (insideTelegram()) void start();
  }, [start]);

  if (!insideTelegram()) return <div className="centered">{words.notTelegram}</div>;
  if (error)
    return (
      <div className="centered">
        <div>
          <p>{error.code === "NOT_LINKED" ? words.notLinked : errorText(words, error.code, error.message)}</p>
          <button type="button" className="btn" onClick={() => void start()}>
            {words.tryAgain}
          </button>
        </div>
      </div>
    );
  if (!me || !funnel) return <div className="centered">{words.loading}</div>;

  return (
    <Ctx.Provider value={{ api, words, lang, setLang, me, funnel, reloadFunnel, toast }}>
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
