import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ChangePreview } from "@platform/shared";

import type { AssistantEvent, CompanyView, Proposal, ProposalOutcome } from "../../../shared/ipc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "proposal"; id: string; proposal: Proposal; outcome: ProposalOutcome | null }
  | { kind: "error"; code: string; message: string };

/** Conversations of this window, per company. The main process keeps the model's copy. */
type Transcripts = Record<string, { entries: Entry[]; busy: boolean }>;

function apply(transcripts: Transcripts, event: AssistantEvent): Transcripts {
  const current = transcripts[event.companyId] ?? { entries: [], busy: false };
  const entries = [...current.entries];
  const last = entries.at(-1);
  switch (event.type) {
    case "text":
      if (last?.kind === "assistant") entries[entries.length - 1] = { ...last, text: last.text + event.text };
      else entries.push({ kind: "assistant", text: event.text });
      return { ...transcripts, [event.companyId]: { entries, busy: true } };
    case "tool":
      entries.push({ kind: "tool", name: event.name, detail: event.detail });
      return { ...transcripts, [event.companyId]: { entries, busy: true } };
    case "error":
      entries.push({ kind: "error", code: event.code, message: event.message });
      return { ...transcripts, [event.companyId]: { entries, busy: false } };
    case "confirm":
      entries.push({ kind: "proposal", id: event.id, proposal: event.proposal, outcome: null });
      return { ...transcripts, [event.companyId]: { entries, busy: true } };
    case "decided": {
      const updated = entries.map((e) =>
        e.kind === "proposal" && e.id === event.id ? { ...e, outcome: event.outcome } : e,
      );
      return { ...transcripts, [event.companyId]: { entries: updated, busy: true } };
    }
    case "done":
      return { ...transcripts, [event.companyId]: { entries, busy: false } };
  }
}

export function AssistantScreen() {
  const { t } = useTranslation();
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => window.platform.companies.list() });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Transcripts>({});

  useEffect(() => window.platform.assistant.onEvent((e) => setTranscripts((all) => apply(all, e))), []);

  const list = companies.data ?? [];
  const company = list.find((c) => c.id === selectedId) ?? list[0];

  if (companies.isPending) return null;
  if (!company) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card className="p-10 text-center text-muted-foreground">{t("assistant.noCompanies")}</Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-4xl flex-col p-6">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("assistant.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("assistant.subtitle")}</p>
        </div>
        <select
          aria-label={t("assistant.company")}
          className="ml-auto h-9 rounded-lg border border-border bg-card px-2 text-sm"
          value={company.id}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {company.aiEnabled ? (
        <Chat
          company={company}
          transcript={transcripts[company.id] ?? { entries: [], busy: false }}
          onUserMessage={(text) =>
            setTranscripts((all) => ({
              ...all,
              [company.id]: {
                entries: [...(all[company.id]?.entries ?? []), { kind: "user", text }],
                busy: true,
              },
            }))
          }
          onReset={() => setTranscripts((all) => ({ ...all, [company.id]: { entries: [], busy: false } }))}
        />
      ) : (
        <Consent company={company} />
      )}
    </div>
  );
}

/** TD §11: the assistant is off by default; turning it on means agreeing that 1C data goes to the AI. */
function Consent({ company }: { company: CompanyView }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const enable = useMutation({
    mutationFn: () => window.platform.assistant.enable(company.id, true),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["companies"] }),
  });
  return (
    <Card className="space-y-3 p-6">
      <h2 className="font-semibold">{t("assistant.consentTitle", { name: company.name })}</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t("assistant.consentRead")}</li>
        <li>{t("assistant.consentSend")}</li>
        <li>{t("assistant.consentWrite")}</li>
      </ul>
      <Button onClick={() => enable.mutate()} disabled={enable.isPending}>
        {t("assistant.enable")}
      </Button>
    </Card>
  );
}

function Chat({
  company,
  transcript,
  onUserMessage,
  onReset,
}: {
  company: CompanyView;
  transcript: { entries: Entry[]; busy: boolean };
  onUserMessage: (text: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const examples = t("assistant.examples", { returnObjects: true }) as string[];

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [transcript.entries]);

  function ask(question: string) {
    const q = question.trim();
    if (!q || transcript.busy) return;
    onUserMessage(q);
    setText("");
    void window.platform.assistant.send({ companyId: company.id, text: q });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    ask(text);
  }

  async function turnOff() {
    await window.platform.assistant.enable(company.id, false);
    onReset();
    await queryClient.invalidateQueries({ queryKey: ["companies"] });
  }

  return (
    <>
      <Card className="flex-1 space-y-4 overflow-y-auto p-4">
        {transcript.entries.length === 0 && (
          <div className="space-y-2 py-6 text-center text-sm text-muted-foreground">
            <p>{t("assistant.empty")}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {examples.map((example) => (
                <Button key={example} variant="outline" size="sm" onClick={() => ask(example)}>
                  {example}
                </Button>
              ))}
            </div>
          </div>
        )}
        {transcript.entries.map((entry, i) => (
          <EntryView key={i} entry={entry} companyId={company.id} />
        ))}
        {transcript.busy && <div className="text-xs text-muted-foreground">{t("assistant.thinking")}</div>}
        <div ref={bottom} />
      </Card>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <textarea
          className="min-h-11 flex-1 resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm"
          rows={2}
          maxLength={4000}
          placeholder={t("assistant.placeholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(text);
            }
          }}
        />
        {transcript.busy ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void window.platform.assistant.stop(company.id)}
          >
            {t("assistant.stop")}
          </Button>
        ) : (
          <Button type="submit" disabled={!text.trim()}>
            {t("assistant.send")}
          </Button>
        )}
      </form>
      <div className="mt-2 flex gap-3 text-xs text-muted-foreground">
        <span>{t("assistant.readOnlyNote")}</span>
        <button
          className="ml-auto underline"
          disabled={transcript.busy}
          onClick={() => {
            void window.platform.assistant.reset(company.id);
            onReset();
          }}
        >
          {t("assistant.newChat")}
        </button>
        <button className="underline" onClick={() => void turnOff()}>
          {t("assistant.disable")}
        </button>
      </div>
    </>
  );
}

function EntryView({ entry, companyId }: { entry: Entry; companyId: string }) {
  const { t } = useTranslation();
  switch (entry.kind) {
    case "user":
      return (
        <div className="ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
          {entry.text}
        </div>
      );
    case "assistant":
      return (
        <div className="markdown max-w-full text-sm">
          <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
        </div>
      );
    case "tool":
      return (
        <div className="truncate font-mono text-xs text-muted-foreground" title={entry.detail}>
          {t(`assistant.tools.${entry.name}`)} {entry.detail}
        </div>
      );
    case "proposal":
      return <ProposalCard companyId={companyId} entry={entry} />;
    case "error": {
      const known = t(`errors.${entry.code}`);
      return (
        <div className={cn("rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive")}>
          {known === `errors.${entry.code}` ? entry.message : known}
        </div>
      );
    }
  }
}

const money = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
const day = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");

/** A document the assistant prepared. Nothing is written to 1C until "Create in 1C" is pressed. */
function ProposalCard({
  companyId,
  entry,
}: {
  companyId: string;
  entry: Extract<Entry, { kind: "proposal" }>;
}) {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  const { proposal, outcome } = entry;
  const decide = (approve: boolean) => {
    setSent(true);
    void window.platform.assistant.decide(companyId, entry.id, approve);
  };
  const row = (label: string, value: string) => (
    <div className="flex gap-2">
      <span className="w-48 shrink-0 text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );

  return (
    <Card className="space-y-3 border-primary/40 p-4 text-sm">
      {proposal.kind === "change" ? (
        <ChangeBody preview={proposal.preview} />
      ) : proposal.kind === "invoice_issued" ? (
        <>
          <div>
            <div className="font-semibold">{t("assistant.proposal.issuedTitle")}</div>
            <div className="text-muted-foreground">
              {t("assistant.proposal.issuedBasis", {
                number: proposal.sale.number,
                date: day(proposal.sale.date),
              })}
            </div>
          </div>
          <div className="space-y-1">
            {row(t("assistant.proposal.organization"), proposal.sale.organization ?? "—")}
            {row(t("assistant.proposal.counterparty"), proposal.sale.counterparty ?? "—")}
            {row(t("assistant.proposal.amount"), money(proposal.sale.amount))}
            {row(
              t("assistant.proposal.salePosted"),
              t(proposal.sale.posted ? "assistant.proposal.yes" : "assistant.proposal.no"),
            )}
          </div>
        </>
      ) : (
        <>
          <div>
            <div className="font-semibold">{t("assistant.proposal.receivedTitle")}</div>
            <div className="text-muted-foreground">
              {t("assistant.proposal.receivedBasis", {
                number: proposal.invoice.number,
                date: day(proposal.invoice.date),
              })}
            </div>
          </div>
          {row(t("assistant.proposal.counterpartyInn"), proposal.invoice.counterparty.inn ?? "—")}
          <table className="w-full text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="py-1 font-medium">{t("assistant.proposal.item")}</th>
                <th className="py-1 text-right font-medium">{t("assistant.proposal.quantity")}</th>
                <th className="py-1 text-right font-medium">{t("assistant.proposal.price")}</th>
                <th className="py-1 text-right font-medium">{t("assistant.proposal.vat")}</th>
                <th className="py-1 text-right font-medium">{t("assistant.proposal.total")}</th>
              </tr>
            </thead>
            <tbody>
              {proposal.invoice.lines.map((line, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1">{line.item.name ?? line.item.ikpu ?? line.item.ref}</td>
                  <td className="py-1 text-right">{money(line.quantity)}</td>
                  <td className="py-1 text-right">{money(line.price)}</td>
                  <td className="py-1 text-right">{line.vatRate}%</td>
                  <td className="py-1 text-right">{money(line.total)}</td>
                </tr>
              ))}
              <tr className="border-t border-border font-semibold">
                <td className="py-1" colSpan={4}>
                  {t("assistant.proposal.total")}
                </td>
                <td className="py-1 text-right">
                  {money(proposal.invoice.lines.reduce((sum, line) => sum + line.total, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}
      {proposal.kind !== "change" && (
        <p className="text-xs text-muted-foreground">
          {t(
            proposal.kind === "invoice_issued"
              ? "assistant.proposal.note"
              : "assistant.proposal.noteReceived",
          )}
        </p>
      )}
      {outcome === null ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={sent} onClick={() => decide(true)}>
            {t(proposal.kind === "change" ? "assistant.proposal.apply" : "assistant.proposal.create")}
          </Button>
          <Button size="sm" variant="outline" disabled={sent} onClick={() => decide(false)}>
            {t("assistant.proposal.cancel")}
          </Button>
        </div>
      ) : outcome.status === "created" ? (
        <div className="rounded-lg bg-success/15 px-3 py-2 font-medium text-success">
          {t(outcome.document.duplicate ? "assistant.proposal.existed" : "assistant.proposal.created", {
            number: outcome.document.number,
            date: day(outcome.document.date),
          })}
        </div>
      ) : outcome.status === "applied" ? (
        <div className="rounded-lg bg-success/15 px-3 py-2 font-medium text-success">
          {t("assistant.proposal.applied", { presentation: outcome.state.presentation })}
          {outcome.state.posted ? ` ${t("assistant.proposal.isPosted")}` : ""}
          {outcome.state.deletionMark ? ` ${t("assistant.proposal.isMarked")}` : ""}
        </div>
      ) : outcome.status === "declined" ? (
        <div className="text-muted-foreground">{t("assistant.proposal.declined")}</div>
      ) : (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{outcome.message}</div>
      )}
    </Card>
  );
}

/** Shows a value from 1C as text: references by name, dates as dd.mm.yyyy. */
function show(value: unknown, t: (key: string) => string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return money(value);
  if (typeof value === "boolean") return t(value ? "assistant.proposal.yes" : "assistant.proposal.no");
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(value)) return day(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value))
    return `${day(value)} ${value.slice(11, 16)}`;
  if (typeof value === "object" && value && "name" in value) return String((value as { name: unknown }).name);
  return String(value);
}

/** A change to any document or directory item: what, field by field, and what happens to posting. */
function ChangeBody({ preview }: { preview: ChangePreview }) {
  const { t } = useTranslation();
  const isDocument = preview.object.startsWith("Документ.");
  const posting = !isDocument
    ? null
    : preview.action === "delete" && preview.posted
      ? "assistant.proposal.postingDeleteUnposts"
      : preview.willPost && preview.posted
        ? "assistant.proposal.postingRepost"
        : preview.willPost
          ? "assistant.proposal.postingPost"
          : preview.posted && preview.action === "update"
            ? "assistant.proposal.postingUnpost"
            : preview.action === "create" || preview.action === "update"
              ? "assistant.proposal.postingNone"
              : null;
  return (
    <>
      <div>
        <div className="font-semibold">
          {t(`assistant.proposal.action.${preview.action}`)} · {preview.object}
        </div>
        <div className="text-muted-foreground">{preview.presentation}</div>
      </div>
      {preview.changes.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              <th className="py-1 font-medium">{t("assistant.proposal.field")}</th>
              <th className="py-1 font-medium">{t("assistant.proposal.before")}</th>
              <th className="py-1 font-medium">{t("assistant.proposal.after")}</th>
            </tr>
          </thead>
          <tbody>
            {preview.changes.map((change) => (
              <tr key={change.field} className="border-t border-border align-top">
                <td className="py-1 pr-2 text-muted-foreground">{change.field}</td>
                <td className="py-1 pr-2 line-through decoration-muted-foreground/60">
                  {show(change.before, t)}
                </td>
                <td className="py-1 font-medium">{show(change.after, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview.tables.map((table) => {
        const columns = [...new Set(table.rows.flatMap((row) => Object.keys(row)))].slice(0, 6);
        return (
          <div key={table.table} className="space-y-1">
            <div className="text-xs text-muted-foreground">
              {t("assistant.proposal.tableRows", {
                table: table.table,
                before: table.rowsBefore,
                after: table.rowsAfter,
              })}
            </div>
            <table className="w-full text-xs tabular-nums">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  {columns.map((column) => (
                    <th key={column} className="py-1 pr-2 font-medium">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.slice(0, 10).map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {columns.map((column) => (
                      <td key={column} className="py-1 pr-2">
                        {show(row[column], t)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {posting && <div className="text-xs font-medium">{t(posting)}</div>}
      {preview.warnings.length > 0 && (
        <ul className="list-disc rounded-lg bg-warning/15 py-2 pr-3 pl-7 text-xs">
          {preview.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}
    </>
  );
}
