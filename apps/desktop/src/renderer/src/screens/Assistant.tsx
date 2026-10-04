import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { AssistantEvent, CompanyView } from "../../../shared/ipc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail: string }
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
          <EntryView key={i} entry={entry} />
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

function EntryView({ entry }: { entry: Entry }) {
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
