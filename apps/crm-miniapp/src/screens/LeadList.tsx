import { useCallback, useEffect, useState } from "react";

import type { CrmLeadRow } from "@platform/shared";

import { useApp } from "../context.js";
import { ApiError } from "../lib/api.js";
import { errorText } from "../lib/i18n.js";
import { Stage, since } from "./parts.js";

/** The operator's list: a search, the funnel's stages as filters, and the leads (their own, for a manager). */
export function LeadList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { api, words, funnel, me, lang, setLang } = useApp();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [stageId, setStageId] = useState("");
  const [leads, setLeads] = useState<CrmLeadRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The search asks once the typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = useCallback(
    async (offset: number) => {
      try {
        const page = await api.leads(search, stageId, offset);
        setError(null);
        setTotal(page.total);
        setLeads((current) => (offset === 0 ? page.leads : [...(current ?? []), ...page.leads]));
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
        setError(errorText(words, err.code, err.message));
      }
    },
    [api, search, stageId, words],
  );
  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <>
      <header className="bar">
        <span />
        <h1>
          {words.title}
          <small>{me.name}</small>
        </h1>
        <button type="button" className="link" onClick={() => setLang(lang === "uz" ? "ru" : "uz")}>
          {lang === "uz" ? "RU" : "UZ"}
        </button>
      </header>
      <div className="pad">
        <input
          className="field"
          type="search"
          placeholder={words.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="chips" role="tablist">
        <button type="button" className={stageId === "" ? "chip on" : "chip"} onClick={() => setStageId("")}>
          {words.all}
        </button>
        {funnel.stages.map((s) => (
          <button
            key={s.id}
            type="button"
            className={stageId === s.id ? "chip on" : "chip"}
            onClick={() => setStageId(s.id)}
          >
            {s.name} <b>{s.leads}</b>
          </button>
        ))}
      </div>
      {error && <p className="error pad">{error}</p>}
      {leads === null && !error && <p className="hint pad">{words.loading}</p>}
      {leads?.length === 0 && <p className="hint pad">{words.noLeads}</p>}
      <ul className="list">
        {leads?.map((l) => (
          <li key={l.id}>
            <button type="button" className="row" onClick={() => onOpen(l.id)}>
              <span className="main">
                <strong>{l.name}</strong>
                <span className="hint">{l.phone}</span>
              </span>
              <span className="side">
                <Stage name={l.stageName} color={l.stageColor} />
                <span className="hint">{since(l.lastContactAt, words.never)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {leads && leads.length < total && (
        <div className="pad">
          <button type="button" className="btn ghost" onClick={() => void load(leads.length)}>
            {words.more}
          </button>
        </div>
      )}
      <button type="button" className="fab" aria-label={words.newLead} onClick={onNew}>
        +
      </button>
    </>
  );
}
