import { useCallback, useEffect, useState } from "react";

import { CALL_RESULTS, type CallResult, type CrmLeadDetail } from "@platform/shared";

import { useApp } from "../context.js";
import { ApiError } from "../lib/api.js";
import { errorText } from "../lib/i18n.js";
import { haptic } from "../lib/telegram.js";
import { Card } from "./Card.js";
import { Stage, dateTime, duration } from "./parts.js";

/** One lead: the call button, the result of the call, the stage, the notes and what happened so far. */
export function LeadCard({ id, onBack }: { id: string; onBack: () => void }) {
  const { api, words, funnel, reloadFunnel, toast } = useApp();
  const [detail, setDetail] = useState<CrmLeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [minutes, setMinutes] = useState("");
  const [callNote, setCallNote] = useState("");
  const [note, setNote] = useState("");

  const fail = useCallback(
    (e: unknown) => {
      haptic("error");
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(errorText(words, err.code, err.message));
    },
    [words],
  );
  const load = useCallback(async () => {
    try {
      setDetail(await api.lead(id));
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, [api, id, fail]);
  useEffect(() => {
    void load();
  }, [load]);

  const move = async (stageId: string) => {
    try {
      await api.moveLead(id, stageId);
      haptic("success");
      toast(words.stageMoved);
      await Promise.all([load(), reloadFunnel()]);
    } catch (e) {
      fail(e);
    }
  };
  const saveCall = async () => {
    if (!result) return;
    try {
      await api.addCall(
        id,
        result,
        minutes ? Math.round(Number(minutes) * 60) : undefined,
        callNote.trim() || undefined,
      );
      haptic("success");
      setLogging(false);
      setResult(null);
      setMinutes("");
      setCallNote("");
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const saveNote = async () => {
    if (!note.trim()) return;
    try {
      await api.addNote(id, note.trim());
      setNote("");
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const lead = detail?.lead;
  return (
    <>
      <header className="bar">
        <button type="button" className="link" onClick={onBack}>
          ‹ {words.back}
        </button>
        <h1>{lead?.name ?? ""}</h1>
        <span />
      </header>
      {error && <p className="error pad">{error}</p>}
      {!detail && !error && <p className="hint pad">{words.loading}</p>}
      {lead && detail && (
        <div className="pad stack">
          <section className="card">
            <div className="between">
              <Stage name={lead.stageName} color={lead.stageColor} />
              <span className="hint">
                {words.lastContact}: {lead.lastContactAt ? dateTime(lead.lastContactAt) : words.never}
              </span>
            </div>
            <div className="phone">{lead.phone}</div>
            {(lead.company || lead.source) && (
              <div className="hint">{[lead.company, lead.source].filter(Boolean).join(" · ")}</div>
            )}
            {/* A plain tel: link: the phone's own dialer opens; what came of the call is written down after. */}
            <a className="btn call" href={`tel:${lead.phone}`} onClick={() => setLogging(true)}>
              {words.call}
            </a>
          </section>

          {logging ? (
            <section className="card stack">
              <strong>{words.callResult}</strong>
              <span className="hint">{words.callHint}</span>
              <div className="results">
                {CALL_RESULTS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={result === r ? "chip on" : "chip"}
                    onClick={() => setResult(r)}
                  >
                    {words.results[r]}
                  </button>
                ))}
              </div>
              <input
                className="field"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                placeholder={words.minutes}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
              <input
                className="field"
                placeholder={words.whatSaid}
                value={callNote}
                onChange={(e) => setCallNote(e.target.value)}
              />
              <button type="button" className="btn" disabled={!result} onClick={() => void saveCall()}>
                {words.save}
              </button>
            </section>
          ) : (
            <button type="button" className="btn ghost" onClick={() => setLogging(true)}>
              {words.addCallResult}
            </button>
          )}

          <Card
            key={JSON.stringify(detail.values)}
            leadId={id}
            saved={detail.values}
            onSaved={() => void load()}
          />

          <section className="card stack">
            <strong>{words.stage}</strong>
            <div className="results">
              {funnel.stages.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={s.id === lead.stageId ? "chip on" : "chip"}
                  style={
                    s.id === lead.stageId ? { backgroundColor: s.color, borderColor: s.color } : undefined
                  }
                  onClick={() => s.id !== lead.stageId && void move(s.id)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </section>

          <section className="card stack">
            <strong>{words.notes}</strong>
            <div className="inline">
              <input
                className="field"
                placeholder={words.writeNote}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="btn small"
                disabled={!note.trim()}
                onClick={() => void saveNote()}
              >
                {words.add}
              </button>
            </div>
            {detail.notes.length === 0 && <span className="hint">{words.noNotes}</span>}
            {detail.notes.map((n) => (
              <div key={n.id} className="entry">
                <div>{n.text}</div>
                <span className="hint">
                  {n.authorName} · {dateTime(n.createdAt)}
                </span>
              </div>
            ))}
          </section>

          <section className="card stack">
            <strong>{words.calls}</strong>
            {detail.calls.length === 0 && <span className="hint">{words.noCalls}</span>}
            {detail.calls.map((c) => (
              <div key={c.id} className="entry">
                <div>
                  {words.results[c.result]}{" "}
                  {c.durationSec !== null && <span className="hint">{duration(c.durationSec)}</span>}
                </div>
                {c.note && <div className="hint">{c.note}</div>}
                <span className="hint">
                  {c.byName} · {dateTime(c.startedAt)}
                </span>
              </div>
            ))}
          </section>

          <section className="card stack">
            <strong>{words.history}</strong>
            {detail.history.map((h) => (
              <div key={h.id} className="entry">
                <div>{h.fromStage ? `${h.fromStage} → ${h.toStage}` : `${words.addedTo} ${h.toStage}`}</div>
                <span className="hint">
                  {h.byName} · {dateTime(h.at)}
                </span>
              </div>
            ))}
          </section>
        </div>
      )}
    </>
  );
}
