import { useState, type FormEvent } from "react";

import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Card, ErrorBox, Table } from "./ui";

interface AskResult {
  answer: string;
  sql: string;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

const EXAMPLES = ["Почему Касса в минусе?", "Kim bizga eng ko'p qarzdor?", "Top 5 customers by sales this year"];

export function AskBox() {
  const { companyId } = useSession();
  const [question, setQuestion] = useState("");
  const [anonymize, setAnonymize] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSql, setShowSql] = useState(false);

  async function ask(e?: FormEvent, text?: string) {
    e?.preventDefault();
    const q = text ?? question;
    if (!q.trim()) return;
    setQuestion(q);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<AskResult>("/api/ai/ask", { method: "POST", json: { question: q, company_id: companyId, anonymize } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Ask AI" actions={<span className="text-xs text-slate-500">Uzbek, Russian or English · read-only</span>}>
      <form onSubmit={ask} className="flex flex-col gap-2 sm:flex-row">
        <input className="input flex-1" placeholder="Why is Касса negative?" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <button className="btn-primary" disabled={busy}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {EXAMPLES.map((ex) => (
          <button key={ex} className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-600 hover:border-brand-500 dark:border-slate-700 dark:text-slate-300" onClick={() => ask(undefined, ex)} type="button">
            {ex}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1 text-slate-500">
          <input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} /> Hide names and INNs from Claude
        </label>
      </div>
      <div className="mt-3 space-y-3">
        <ErrorBox error={error} />
        {result && (
          <>
            <div className="whitespace-pre-wrap rounded-lg bg-brand-50 p-3 text-sm leading-relaxed dark:bg-brand-700/20">{result.answer}</div>
            <button className="link text-xs" onClick={() => setShowSql((s) => !s)}>
              {showSql ? "Hide" : "Show"} query and data ({result.rows.length}
              {result.truncated ? "+" : ""} rows)
            </button>
            {showSql && (
              <>
                <pre className="overflow-x-auto rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-800">{result.sql}</pre>
                <Table>
                  <thead>
                    <tr>{result.columns.map((c) => <th key={c} className="th">{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i}>{r.map((v, j) => <td key={j} className="td">{v === null ? "" : String(v)}</td>)}</tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
