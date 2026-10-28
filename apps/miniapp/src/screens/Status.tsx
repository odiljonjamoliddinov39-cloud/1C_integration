import type { CommandView } from "@platform/shared";
import { useEffect, useRef, useState } from "react";

import { useApp } from "../context.js";
import { ApiError } from "../lib/api.js";
import { follow, isStatus } from "../lib/commands.js";
import { type Key, LANGS, LANG_NAMES, errorText } from "../lib/i18n.js";

/** The dictionary key of a request type ("chat.message" is "status.types.chat_message": a dot would split the key). */
const typeKey = (type: string) => `status.types.${type.replace(".", "_")}` as Key;

export function StatusScreen() {
  const { api, t, lang, setLang, inn, device, me, companyName } = useApp();
  const [status, setStatus] = useState<CommandView | null>(null);
  const [recent, setRecent] = useState<CommandView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    void api
      .recent()
      .then((all) => setRecent(all.filter((c) => c.company_inn === inn).slice(0, 15)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [api, inn]);

  async function check() {
    setError(null);
    setStatus(null);
    try {
      const view = await api.create({ type: "status.get", inn, deviceId: device.device_id, payload: {} });
      setStatus(view);
      await follow(api, view.id, setStatus, abort.current.signal);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(errorText(lang, err.code, err.message));
    }
  }

  const result = status?.state === "done" && isStatus(status.result) ? status.result : null;

  return (
    <>
      <h2>{t("status.title")}</h2>
      <div className="card">
        <div className="row">
          <strong>{device.device}</strong>
          <span className={`chip ${device.online ? "ok" : "bad"}`}>
            {device.online ? t("pc.online") : t("pc.offline")}
          </span>
        </div>
        <p className="muted">
          {companyName}
          {device.last_seen_at && !device.online
            ? ` · ${t("pc.lastSeen", { time: new Date(device.last_seen_at).toLocaleString(lang) })}`
            : ""}
        </p>
        <button type="button" className="btn" onClick={() => void check()}>
          {t("status.check")}
        </button>
        {error && <div className="err">{error}</div>}
        {status && !result && status.state !== "failed" && (
          <p className="muted">{t(`state.${status.state}`)}</p>
        )}
        {status?.state === "failed" && (
          <div className="err">{errorText(lang, status.error?.code, status.error?.message)}</div>
        )}
        {result && (
          <ul className="lines">
            <li>
              {t("status.onec")}: {result.onec_reachable ? t("status.reachable") : t("status.unreachable")}
            </li>
            <li>
              {t("status.version")}: {result.app_version}
            </li>
            <li>
              {t("status.lastImport")}:{" "}
              {result.last_import ? new Date(result.last_import).toLocaleString(lang) : t("status.never")}
            </li>
          </ul>
        )}
      </div>
      <div className="card">
        <label htmlFor="language">{t("status.language")}</label>
        <select
          id="language"
          className="field"
          value={lang}
          onChange={(e) => setLang(e.target.value as typeof lang)}
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {LANG_NAMES[l]}
            </option>
          ))}
        </select>
        <p className="muted">@{me.user.username ?? me.user.id}</p>
      </div>
      <h2>{t("status.recent")}</h2>
      {recent.length === 0 && <p className="muted">{t("status.none")}</p>}
      {recent.map((c) => (
        <div className="row card" key={c.id}>
          <div>
            <div>{t(typeKey(c.type))}</div>
            <div className="muted">{new Date(c.created_at).toLocaleString(lang)}</div>
          </div>
          <span
            className={`chip ${c.state === "done" ? "ok" : c.state === "failed" || c.state === "expired" ? "bad" : "warn"}`}
          >
            {t(`state.${c.state}`)}
          </span>
        </div>
      ))}
    </>
  );
}
