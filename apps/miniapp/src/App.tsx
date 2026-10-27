import { useCallback, useEffect, useMemo, useState } from "react";

import { Ctx } from "./context.js";
import { Api, ApiError, type Me } from "./lib/api.js";
import { type Lang, errorText, pickLanguage, translator } from "./lib/i18n.js";
import { insideTelegram, telegramLanguage } from "./lib/telegram.js";
import { ChatScreen } from "./screens/Chat.js";
import { FilesScreen } from "./screens/Files.js";
import { StatusScreen } from "./screens/Status.js";
import { WaitingScreen } from "./screens/Waiting.js";

type Tab = "chat" | "waiting" | "files" | "status";
const TABS: Tab[] = ["chat", "waiting", "files", "status"];

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice is kept for this visit only.
  }
};

export function App() {
  const api = useMemo(() => new Api(), []);
  const [lang, setLangState] = useState<Lang>(() => pickLanguage(read("lang"), telegramLanguage()));
  const t = useMemo(() => translator(lang), [lang]);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    write("lang", next);
  }, []);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [inn, setInn] = useState<string | null>(() => read("company"));
  const [waitingCount, setWaitingCount] = useState(0);

  const reloadMe = useCallback(async () => {
    try {
      setMe(await api.me());
      setError(null);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError({ code: err.code, message: err.message });
    }
  }, [api]);

  useEffect(() => {
    if (!insideTelegram()) return;
    void reloadMe();
    // The PC comes and goes: the dot follows.
    const timer = setInterval(() => void reloadMe(), 30_000);
    return () => clearInterval(timer);
  }, [reloadMe]);

  if (!insideTelegram()) return <div className="centered">{t("notTelegram")}</div>;
  if (error && !me)
    return (
      <div className="centered">
        <div>
          <p>{error.code === "NOT_LINKED" ? t("notLinked") : errorText(lang, error.code, error.message)}</p>
          <button type="button" className="btn" onClick={() => void reloadMe()}>
            {t("retry")}
          </button>
        </div>
      </div>
    );
  if (!me) return <div className="centered">{t("loading")}</div>;

  // The companies of every PC this phone is connected to, each with the PC it lives on.
  const companies = me.devices.flatMap((device) =>
    device.companies.map((company) => ({ ...company, device })),
  );
  const chosen =
    companies.find((c) => c.inn === inn) ??
    companies.find((c) => c.inn === me.devices[0]?.active_company) ??
    companies[0];
  if (!chosen) return <div className="centered">{t("noCompanies")}</div>;

  const choose = (next: string) => {
    setInn(next);
    write("company", next);
    const target = companies.find((c) => c.inn === next);
    if (target) void api.setActiveCompany(next, target.device.device_id).catch(() => undefined);
  };

  return (
    <Ctx.Provider
      value={{
        api,
        lang,
        setLang,
        t,
        me,
        device: chosen.device,
        inn: chosen.inn,
        companyName: chosen.name,
        reloadMe,
        go: setTab,
        waitingCount,
        setWaitingCount,
      }}
    >
      <div className="app">
        <div className="topbar">
          <span className={`dot${chosen.device.online ? " on" : ""}`} title={chosen.device.device} />
          <select aria-label={t("company")} value={chosen.inn} onChange={(e) => choose(e.target.value)}>
            {companies.map((c) => (
              <option key={`${c.device.device_id}-${c.inn}`} value={c.inn}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {!chosen.device.online && <div className="pc-note">{t("pc.offline")}</div>}
        {/* Each screen is keyed by the company: a message never carries over to another company's chat. */}
        <div className="content" key={`${chosen.device.device_id}-${chosen.inn}`}>
          {tab === "chat" && <ChatScreen />}
          {tab === "waiting" && <WaitingScreen />}
          {tab === "files" && <FilesScreen />}
          {tab === "status" && <StatusScreen />}
        </div>
        <nav className="tabs">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              aria-current={tab === name ? "page" : undefined}
              onClick={() => setTab(name)}
            >
              {t(`tabs.${name}`)}
              {name === "waiting" && waitingCount > 0 && <span className="badge">{waitingCount}</span>}
            </button>
          ))}
        </nav>
      </div>
    </Ctx.Provider>
  );
}
