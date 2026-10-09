import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ClipboardEvent, type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { type ChangePreview, EXTENSION_VERSION, isOlderExtension } from "@platform/shared";

import {
  ATTACHMENTS,
  type AssistantEvent,
  type AttachmentInfo,
  type AttachmentKind,
  type AuditCheckView,
  type AuditView,
  type BatchItem,
  type CompanyView,
  type Proposal,
  type ProposalOutcome,
  UiLanguage,
} from "../../../shared/ipc";
import { type ChatEntry, applyEvent } from "../../../shared/transcript";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Entry = ChatEntry;

/** The open chat of each company in this window. The main process keeps the model's copy and saves it. */
/** chatId is null until the first question of a new chat: then the window picks the id. */
type Transcript = { chatId: string | null; entries: Entry[]; busy: boolean };
type Transcripts = Record<string, Transcript>;

const NEW_CHAT: Transcript = { chatId: null, entries: [], busy: false };

function apply(transcripts: Transcripts, event: AssistantEvent): Transcripts {
  const current = transcripts[event.companyId] ?? NEW_CHAT;
  // "elapsed" comes after the task's "done" or "error": it does not make the chat busy again.
  const busy = event.type === "elapsed" ? current.busy : event.type !== "done" && event.type !== "error";
  return {
    ...transcripts,
    [event.companyId]: { ...current, entries: applyEvent(current.entries, event), busy },
  };
}

/** A file picked for the next question, read in the window and handed to the main process. */
interface PendingFile {
  name: string;
  size: number;
  data: Uint8Array<ArrayBuffer>;
}

function kindOf(name: string): AttachmentKind {
  const extension = name.toLowerCase().slice(name.lastIndexOf("."));
  if (extension === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) return "image";
  if (extension === ".xlsx") return "spreadsheet";
  if (extension === ".docx") return "document";
  if (extension === ".zip") return "archive";
  return "text";
}

/** Errors about an attached file; their message names the file and what is wrong with it. */
const FILE_ERRORS = ["FILE_TYPE", "FILE_TOO_LARGE", "FILE_UNREADABLE"];

const sizeText = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function AssistantScreen() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => window.platform.companies.list() });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Transcripts>({});

  useEffect(
    () =>
      window.platform.assistant.onEvent((e) => {
        setTranscripts((all) => apply(all, e));
        // The answer is saved: the chat list shows it (new chats, newest first).
        if (e.type === "done" || e.type === "error") {
          void queryClient.invalidateQueries({ queryKey: ["chats", e.companyId] });
        }
      }),
    [queryClient],
  );

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

  const transcript = transcripts[company.id] ?? NEW_CHAT;
  const setTranscript = (next: Transcript) => setTranscripts((all) => ({ ...all, [company.id]: next }));

  return (
    <div className="flex h-[calc(100vh-4rem)] w-full flex-col px-6 py-4">
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
        <div className="flex min-h-0 flex-1 flex-col">
          <ExtensionNotice company={company} />
          <div className="flex min-h-0 flex-1 gap-4">
            <ChatList
              company={company}
              transcript={transcript}
              onOpen={setTranscript}
              onAudit={(from, to) => {
                const chatId = crypto.randomUUID();
                setTranscript({ chatId, entries: [], busy: true });
                const language = UiLanguage.catch("ru").parse(i18n.language);
                void window.platform.assistant
                  .audit({ companyId: company.id, chatId, from, to, language })
                  .then(() => queryClient.invalidateQueries({ queryKey: ["chats", company.id] }));
              }}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <Chat
                company={company}
                transcript={transcript}
                onUserMessage={(chatId, text, files) =>
                  setTranscripts((all) => {
                    const current = all[company.id] ?? NEW_CHAT;
                    const entry: Entry = { kind: "user", text, ...(files.length > 0 ? { files } : {}) };
                    return {
                      ...all,
                      [company.id]: { chatId, entries: [...current.entries, entry], busy: true },
                    };
                  })
                }
                onReset={() => setTranscript(NEW_CHAT)}
              />
            </div>
          </div>
        </div>
      ) : (
        <Consent company={company} />
      )}
    </div>
  );
}

/**
 * The 1C base has an older PlatformAPI extension: questions work, but nothing can be created or
 * changed until the new one is loaded. Says how, and re-checks after.
 */
function ExtensionNotice({ company }: { company: CompanyView }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["companies"] });
  const recheck = useMutation({
    mutationFn: () => window.platform.companies.checkStatus(company.id),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: () => window.platform.companies.updateExtension(company.id),
    onSettled: refresh,
  });
  const status = company.lastStatus;
  const version = status?.ok ? status.ping.extensionVersion : null;
  if (update.data?.ok) {
    return (
      <div className="mb-3 rounded-lg bg-success/15 px-4 py-3 text-sm font-medium text-success">
        {t("assistant.extensionUpdated", { version: EXTENSION_VERSION })}
      </div>
    );
  }
  if (!version || !isOlderExtension(version)) return null;
  const failed = update.data && !update.data.ok ? update.data : null;
  const known = failed ? t(`errors.${failed.code}`) : "";
  return (
    <div className="mb-3 space-y-2 rounded-lg border border-warning/50 bg-warning/15 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-medium">
            {t("assistant.oldExtension", { version, needed: EXTENSION_VERSION })}
          </div>
          <div className="text-muted-foreground">
            {update.isPending ? t("assistant.extensionUpdating") : t("assistant.oldExtensionHow")}
          </div>
        </div>
        <Button
          size="sm"
          disabled={update.isPending}
          onClick={() => {
            if (window.confirm(t("assistant.extensionConfirm", { name: company.name }))) update.mutate();
          }}
        >
          {update.isPending ? t("assistant.extensionUpdatingShort") : t("assistant.extensionUpdate")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={recheck.isPending || update.isPending}
          onClick={() => recheck.mutate()}
        >
          {recheck.isPending ? t("assistant.rechecking") : t("assistant.recheck")}
        </Button>
      </div>
      {failed && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
          {known === `errors.${failed.code}`
            ? failed.message
            : // 1C's own words help when it refused for a reason we cannot name.
              ["EXTENSION_UPDATE_FAILED", "EXTENSION_NO_RIGHTS", "EXTENSION_NOT_UPDATED"].includes(
                  failed.code,
                )
              ? `${known} ${failed.message}`
              : known}
        </div>
      )}
    </div>
  );
}

/** Saved chats of the company, newest first; one click reopens a chat to continue it. */
function ChatList({
  company,
  transcript,
  onOpen,
  onAudit,
}: {
  company: CompanyView;
  transcript: Transcript;
  onOpen: (transcript: Transcript) => void;
  onAudit: (from: string, to: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const chats = useQuery({
    queryKey: ["chats", company.id],
    queryFn: () => window.platform.assistant.chats(company.id),
  });
  const [error, setError] = useState<string | null>(null);

  async function open(chatId: string) {
    if (chatId === transcript.chatId) return;
    const result = await window.platform.assistant.openChat(company.id, chatId);
    if (result.ok) {
      setError(null);
      onOpen({ chatId, entries: result.data.entries, busy: false });
    } else {
      setError(result.message);
      await queryClient.invalidateQueries({ queryKey: ["chats", company.id] });
    }
  }

  async function remove(chatId: string) {
    if (!window.confirm(t("assistant.deleteConfirm"))) return;
    const result = await window.platform.assistant.deleteChat(company.id, chatId);
    if (!result.ok) return setError(result.message);
    if (chatId === transcript.chatId) onOpen(NEW_CHAT);
    await queryClient.invalidateQueries({ queryKey: ["chats", company.id] });
  }

  // dd.mm.yyyy hh:mm in every language, like the rest of the app (Uzbek month names are not in every build).
  const date = (iso: string) =>
    new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

  return (
    <Card className="flex w-60 shrink-0 flex-col p-2">
      <Button size="sm" variant="outline" disabled={transcript.busy} onClick={() => onOpen(NEW_CHAT)}>
        + {t("assistant.newChat")}
      </Button>
      <AuditStart busy={transcript.busy} onStart={onAudit} />
      <div className="mt-2 px-1 text-xs font-medium text-muted-foreground">{t("assistant.history")}</div>
      <nav aria-label={t("assistant.history")} className="mt-1 flex-1 space-y-0.5 overflow-y-auto">
        {(chats.data ?? []).length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t("assistant.noChats")}</p>
        )}
        {(chats.data ?? []).map((chat) => (
          <div
            key={chat.id}
            className={cn(
              "group flex items-start gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-muted",
              chat.id === transcript.chatId && "bg-muted",
            )}
          >
            <button
              className="min-w-0 flex-1 text-left disabled:opacity-50"
              disabled={transcript.busy && chat.id !== transcript.chatId}
              aria-current={chat.id === transcript.chatId ? "true" : undefined}
              onClick={() => void open(chat.id)}
            >
              <div className="truncate">{chat.title}</div>
              <div className="text-xs text-muted-foreground">{date(chat.updatedAt)}</div>
            </button>
            <button
              className="invisible px-1 text-muted-foreground group-hover:visible hover:text-destructive focus:visible"
              title={t("assistant.deleteChat")}
              aria-label={t("assistant.deleteChat")}
              disabled={transcript.busy && chat.id === transcript.chatId}
              onClick={() => void remove(chat.id)}
            >
              ×
            </button>
          </div>
        ))}
      </nav>
      {error && <p className="px-1 text-xs text-destructive">{error}</p>}
      <p className="px-1 pt-2 text-xs text-muted-foreground">{t("assistant.historyNote")}</p>
    </Card>
  );
}

/** Today as YYYY-MM-DD on this PC's calendar. */
function localIsoDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The audit button: asks for the period (the year so far by default), then starts it. */
function AuditStart({ busy, onStart }: { busy: boolean; onStart: (from: string, to: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const today = localIsoDate();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  if (!open) {
    return (
      <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => setOpen(true)}>
        {t("audit.start")}
      </Button>
    );
  }
  const valid = from !== "" && to !== "" && from <= to;
  return (
    <form
      className="mt-2 space-y-2 rounded-lg border border-border p-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || busy) return;
        setOpen(false);
        onStart(from, to);
      }}
    >
      <div className="font-medium">{t("audit.period")}</div>
      <label className="flex items-center gap-2">
        <span className="w-8 text-muted-foreground">{t("audit.from")}</span>
        <input
          type="date"
          className="h-8 min-w-0 flex-1 rounded border border-border bg-card px-1"
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-8 text-muted-foreground">{t("audit.to")}</span>
        <input
          type="date"
          className="h-8 min-w-0 flex-1 rounded border border-border bg-card px-1"
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
      <p className="text-muted-foreground">{t("audit.hint")}</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="flex-1" disabled={!valid || busy}>
          {t("audit.run")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          {t("audit.cancel")}
        </Button>
      </div>
    </form>
  );
}

const STATUS_ICON: Record<AuditCheckView["status"], { icon: string; className: string }> = {
  pending: { icon: "○", className: "text-muted-foreground" },
  running: { icon: "◐", className: "animate-pulse text-primary" },
  ok: { icon: "✓", className: "text-success" },
  issues: { icon: "!", className: "font-bold text-warning" },
  not_applicable: { icon: "–", className: "text-muted-foreground" },
  failed: { icon: "✕", className: "text-destructive" },
};

const dmy = (iso: string) => iso.split("-").reverse().join(".");

/** An audit's checks as they run, and what each found; downloadable when finished. */
function AuditCard({
  audit,
  companyId,
  chatId,
}: {
  audit: AuditView;
  companyId: string;
  chatId: string | null;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<string | null>(null);
  const done = audit.checks.filter((c) => !["pending", "running"].includes(c.status)).length;
  const problems = audit.checks.reduce((n, c) => n + (c.findings?.length ?? 0), 0);
  const withIssues = audit.checks.filter((c) => c.status === "issues").length;
  const sections = [...new Set(audit.checks.map((c) => c.section))];

  async function download() {
    if (!chatId) return;
    const result = await window.platform.assistant.exportAudit(companyId, chatId);
    setSaved(result.ok ? (result.data.saved ? t("audit.saved") : null) : result.message);
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {t("audit.title", { from: dmy(audit.from), to: dmy(audit.to) })}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("audit.progress", { done, total: audit.checks.length })}
            {done > 0 && ` · ${t("audit.summary", { checks: withIssues, problems })}`}
          </div>
        </div>
        {audit.finished && chatId && (
          <Button size="sm" variant="outline" onClick={() => void download()}>
            {t("audit.download")}
          </Button>
        )}
      </div>
      {saved && <div className="text-xs text-muted-foreground">{saved}</div>}
      <div className="h-1.5 overflow-hidden rounded bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${(done / Math.max(1, audit.checks.length)) * 100}%` }}
        />
      </div>
      {sections.map((section) => (
        <div key={section} className="space-y-1">
          <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{section}</div>
          {audit.checks
            .filter((c) => c.section === section)
            .map((check) => (
              <AuditCheckRow key={check.id} check={check} />
            ))}
        </div>
      ))}
    </Card>
  );
}

function AuditCheckRow({ check }: { check: AuditCheckView }) {
  const { t } = useTranslation();
  const status = STATUS_ICON[check.status];
  const findings = check.findings ?? [];
  const head = (
    <div className="flex items-start gap-2 text-sm">
      <span
        className={cn("w-4 shrink-0 text-center", status.className)}
        title={t(`audit.status.${check.status}`)}
      >
        {status.icon}
      </span>
      <div className="min-w-0 flex-1">
        <span className="font-medium">{check.title}</span>
        {findings.length > 0 && (
          <span className="ml-2 rounded bg-warning/20 px-1.5 text-xs">
            {t("audit.findings", { count: findings.length })}
          </span>
        )}
        {check.status === "running" && check.activity && (
          <div className="truncate font-mono text-xs text-muted-foreground">{check.activity}</div>
        )}
        {check.summary && <div className="text-xs text-muted-foreground">{check.summary}</div>}
      </div>
      {check.ms !== undefined && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {Math.max(1, Math.round(check.ms / 1000))} s
        </span>
      )}
    </div>
  );
  if (findings.length === 0) return head;
  return (
    <details className="rounded-lg hover:bg-muted/40">
      <summary className="cursor-pointer list-none">{head}</summary>
      <div className="overflow-x-auto pb-2 pl-6">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-2 font-medium">{t("audit.columns.severity")}</th>
              <th className="py-1 pr-2 font-medium">{t("audit.columns.problem")}</th>
              <th className="py-1 pr-2 text-right font-medium">{t("audit.columns.amount")}</th>
              <th className="py-1 pr-2 font-medium">{t("audit.columns.where")}</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f, i) => (
              <tr key={i} className="border-t border-border align-top">
                <td className="py-1 pr-2">
                  <span
                    className={cn(
                      "rounded px-1.5",
                      f.severity === "high" && "bg-destructive/15 text-destructive",
                      f.severity === "medium" && "bg-warning/20",
                      f.severity === "low" && "bg-muted",
                    )}
                  >
                    {t(`audit.severity.${f.severity}`)}
                  </span>
                </td>
                <td className="py-1 pr-2">
                  <div className="font-medium">{f.title}</div>
                  {f.detail && <div className="text-muted-foreground">{f.detail}</div>}
                </td>
                <td className="py-1 pr-2 text-right whitespace-nowrap">
                  {f.amount !== undefined ? money(f.amount) : ""}
                </td>
                <td className="py-1 pr-2 text-muted-foreground">
                  {[f.date, f.counterparty, f.document].filter(Boolean).join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
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
  transcript: Transcript;
  onUserMessage: (chatId: string, text: string, files: AttachmentInfo[]) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const examples = t("assistant.examples", { returnObjects: true }) as string[];

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [transcript.entries]);

  /** Checks and reads files picked, dropped or pasted; the main process reads their content. */
  async function addFiles(list: FileList | File[]) {
    const picked = [...list];
    if (picked.length === 0) return;
    if (files.length + picked.length > ATTACHMENTS.maxFiles) return setFileError(t("errors.TOO_MANY_FILES"));
    const allowed: readonly string[] = ATTACHMENTS.extensions;
    for (const file of picked) {
      const extension = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
      // Pasted screenshots have no useful name.
      if (!allowed.includes(extension) && !file.type.startsWith("image/"))
        return setFileError(t("errors.FILE_TYPE"));
      if (file.size > ATTACHMENTS.maxBytes) return setFileError(t("errors.FILE_TOO_LARGE"));
    }
    setFileError(null);
    const read = await Promise.all(
      picked.map(async (file) => ({
        name: file.name && file.name !== "image.png" ? file.name : `screenshot-${Date.now()}.png`,
        size: file.size,
        data: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    setFiles((current) => [...current, ...read].slice(0, ATTACHMENTS.maxFiles));
  }

  function ask(question: string) {
    const q = question.trim();
    if ((!q && files.length === 0) || transcript.busy) return;
    const sending = files;
    const chatId = transcript.chatId ?? crypto.randomUUID();
    onUserMessage(
      chatId,
      q,
      sending.map((file) => ({ name: file.name, kind: kindOf(file.name), size: file.size })),
    );
    setText("");
    setFiles([]);
    setFileError(null);
    void window.platform.assistant.send({
      companyId: company.id,
      chatId,
      text: q,
      files: sending.map(({ name, data }) => ({ name, data })),
    });
  }

  /** The question again, to the model even though a template or a saved answer could answer it. */
  function askAnyway(question: string, learnedCode?: string) {
    if (transcript.busy || !transcript.chatId) return;
    onUserMessage(transcript.chatId, question, []);
    void window.platform.assistant.send({
      companyId: company.id,
      chatId: transcript.chatId,
      text: question,
      skipFree: true,
      // A learned template that was not wanted is turned off.
      ...(learnedCode ? { rejectTemplate: learnedCode } : {}),
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    ask(text);
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!transcript.busy) void addFiles(e.dataTransfer.files);
  }

  function paste(e: ClipboardEvent) {
    if (e.clipboardData.files.length === 0) return;
    e.preventDefault();
    void addFiles(e.clipboardData.files);
  }

  async function turnOff() {
    await window.platform.assistant.enable(company.id, false);
    onReset();
    await queryClient.invalidateQueries({ queryKey: ["companies"] });
  }

  return (
    <>
      <Card
        className={cn("relative flex-1 space-y-4 overflow-y-auto p-4", dragging && "ring-2 ring-primary")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/80 text-sm font-medium">
            {t("assistant.dropHere")}
          </div>
        )}
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
          <EntryView
            key={i}
            entry={entry}
            companyId={company.id}
            chatId={transcript.chatId}
            onAskAnyway={
              entry.kind === "route" &&
              !transcript.busy &&
              i === transcript.entries.findLastIndex((e) => e.kind === "route")
                ? () => askAnyway(entry.question, entry.learnedCode)
                : undefined
            }
          />
        ))}
        {transcript.busy && <div className="text-xs text-muted-foreground">{t("assistant.thinking")}</div>}
        <div ref={bottom} />
      </Card>
      {(files.length > 0 || fileError) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {files.map((file, i) => (
            <span
              key={`${file.name}-${i}`}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-xs"
            >
              <FileIcon kind={kindOf(file.name)} />
              <span className="max-w-48 truncate">{file.name}</span>
              <span className="text-muted-foreground">{sizeText(file.size)}</span>
              <button
                type="button"
                className="ml-1 text-muted-foreground hover:text-destructive"
                aria-label={`${t("assistant.removeFile")} ${file.name}`}
                onClick={() => setFiles((current) => current.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
          {fileError && <span className="text-xs text-destructive">{fileError}</span>}
        </div>
      )}
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={ATTACHMENTS.extensions.join(",")}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          className="h-auto px-3"
          title={`${t("assistant.attach")}: ${t("assistant.attachHint")}`}
          aria-label={t("assistant.attach")}
          disabled={transcript.busy || files.length >= ATTACHMENTS.maxFiles}
          onClick={() => picker.current?.click()}
        >
          <PaperclipIcon />
        </Button>
        <textarea
          className="min-h-11 flex-1 resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm"
          rows={2}
          maxLength={4000}
          placeholder={t("assistant.placeholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={paste}
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
          <Button type="submit" disabled={!text.trim() && files.length === 0}>
            {t("assistant.send")}
          </Button>
        )}
      </form>
      <div className="mt-2 flex gap-3 text-xs text-muted-foreground">
        <span>{t("assistant.readOnlyNote")}</span>
        <button className="ml-auto underline" onClick={() => void turnOff()}>
          {t("assistant.disable")}
        </button>
      </div>
    </>
  );
}

function PaperclipIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path
        d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon({ kind }: { kind: AttachmentKind }) {
  const label = {
    image: "IMG",
    pdf: "PDF",
    spreadsheet: "XLS",
    document: "DOC",
    text: "TXT",
    archive: "ZIP",
  }[kind];
  return (
    <span className="rounded bg-muted px-1 font-mono text-[10px] font-semibold text-muted-foreground">
      {label}
    </span>
  );
}

/** 2h 5m · 1m 42s · 12s, in the window's language. */
function durationText(ms: number, t: (key: string) => string): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const part = (n: number, unit: string) => `${n} ${t(`assistant.units.${unit}`)}`;
  if (h > 0) return [part(h, "h"), m > 0 ? part(m, "m") : ""].filter(Boolean).join(" ");
  if (m > 0) return [part(m, "m"), s > 0 ? part(s, "s") : ""].filter(Boolean).join(" ");
  return part(s, "s");
}

function EntryView({
  entry,
  companyId,
  chatId,
  onAskAnyway,
}: {
  entry: Entry;
  companyId: string;
  chatId: string | null;
  onAskAnyway?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  switch (entry.kind) {
    case "user":
      return (
        <div className="ml-auto flex max-w-[80%] flex-col items-end gap-1">
          {entry.files && entry.files.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1">
              {entry.files.map((file, i) => (
                <span
                  key={`${file.name}-${i}`}
                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-xs"
                >
                  <FileIcon kind={file.kind} />
                  <span className="max-w-56 truncate">{file.name}</span>
                  <span className="text-muted-foreground">{sizeText(file.size)}</span>
                </span>
              ))}
            </div>
          )}
          {entry.text && (
            <div className="rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
              {entry.text}
            </div>
          )}
        </div>
      );
    case "assistant":
      return (
        <div className="markdown max-w-full text-sm">
          <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
        </div>
      );
    case "note":
      return entry.text.trim() ? (
        <div className="text-xs whitespace-pre-wrap text-muted-foreground italic">{entry.text.trim()}</div>
      ) : null;
    case "tool":
      return (
        <div className="truncate font-mono text-xs text-muted-foreground" title={entry.detail}>
          {t(`assistant.tools.${entry.name}`)} {entry.detail}
        </div>
      );
    case "audit":
      return <AuditCard audit={entry.audit} companyId={companyId} chatId={chatId} />;
    case "elapsed":
      return (
        <div className="text-xs text-muted-foreground">
          {t("assistant.elapsed", { time: durationText(entry.ms, t) })}
        </div>
      );
    case "notice": {
      const known = t(`assistant.notices.${entry.code}`);
      return (
        <div className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {known === `assistant.notices.${entry.code}` ? entry.message : known}
        </div>
      );
    }
    case "route":
      return (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {entry.route === "template"
              ? t("assistant.route.template", { title: entry.title })
              : t("assistant.route.cache", { age: durationText((entry.ageSeconds ?? 0) * 1000, t) })}
          </span>
          {onAskAnyway && (
            <button className="underline hover:text-foreground" onClick={onAskAnyway}>
              {t("assistant.route.askAnyway")}
            </button>
          )}
        </div>
      );
    case "proposal":
      return <ProposalCard companyId={companyId} entry={entry} />;
    case "error": {
      const known = t(`errors.${entry.code}`);
      return (
        <div className={cn("rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive")}>
          {known === `errors.${entry.code}` ? entry.message : known}
          {FILE_ERRORS.includes(entry.code) && known !== entry.message && (
            <div className="mt-1 text-xs opacity-80">{entry.message}</div>
          )}
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
      {proposal.kind === "batch" ? (
        <BatchBody proposal={proposal} outcome={outcome} />
      ) : proposal.kind === "change" ? (
        <ChangeBody preview={proposal.preview} />
      ) : proposal.kind === "delete_marked" ? (
        <>
          <div>
            <div className="font-semibold">{t("assistant.proposal.removeTitle")}</div>
            <div className="text-muted-foreground">
              {t("assistant.proposal.removeTotal", { count: proposal.preview.total })}
            </div>
          </div>
          <table className="w-full text-xs tabular-nums">
            <tbody>
              {proposal.preview.types.map((group) => (
                <tr key={group.type} className="border-t border-border">
                  <td className="py-1">{group.presentation}</td>
                  <td className="py-1 text-right font-medium">{group.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {proposal.preview.otherSessions.length > 0 && (
            <div className="rounded-lg bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              {t("assistant.proposal.removeBusy")}{" "}
              {proposal.preview.otherSessions
                .map((s) => `${s.computer} · ${s.application} · #${s.number}`)
                .join("; ")}
            </div>
          )}
        </>
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
      {proposal.kind !== "change" && proposal.kind !== "batch" && (
        <p
          className={cn(
            "text-xs",
            proposal.kind === "delete_marked" ? "font-medium text-destructive" : "text-muted-foreground",
          )}
        >
          {t(
            proposal.kind === "invoice_issued"
              ? "assistant.proposal.note"
              : proposal.kind === "delete_marked"
                ? "assistant.proposal.noteRemove"
                : "assistant.proposal.noteReceived",
          )}
        </p>
      )}
      {outcome === null ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={sent}
            className={
              proposal.kind === "delete_marked"
                ? "bg-destructive text-white hover:bg-destructive/90"
                : undefined
            }
            onClick={() => decide(true)}
          >
            {proposal.kind === "delete_marked"
              ? sent
                ? t("assistant.proposal.removing")
                : t("assistant.proposal.remove", { count: proposal.preview.total })
              : sent && proposal.kind === "batch"
                ? t("assistant.proposal.batchApplying")
                : proposal.kind === "batch"
                  ? t("assistant.proposal.batchApply", {
                      count: proposal.items.filter((item) => item.preview).length,
                    })
                  : t(proposal.kind === "change" ? "assistant.proposal.apply" : "assistant.proposal.create")}
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
      ) : outcome.status === "removed" ? (
        <div className="rounded-lg bg-success/15 px-3 py-2 font-medium text-success">
          {t("assistant.proposal.removed", {
            deleted: outcome.result.deleted,
            total: outcome.result.total,
          })}
          {outcome.result.kept > 0 && (
            <div className="mt-1 font-normal text-foreground">
              {t("assistant.proposal.removeKept", { count: outcome.result.kept })}
              {outcome.result.reasons[0] ? ` ${outcome.result.reasons[0]}` : ""}
            </div>
          )}
        </div>
      ) : outcome.status === "batch" ? (
        <div className="rounded-lg bg-success/15 px-3 py-2 font-medium text-success">
          {t("assistant.proposal.batchDone", {
            ok: outcome.results.filter((r) => r?.ok).length,
            count: outcome.results.length,
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

/** A batch: one row per change, what 1C checked, and after confirmation what happened to each. */
function BatchBody({
  proposal,
  outcome,
}: {
  proposal: Extract<Proposal, { kind: "batch" }>;
  outcome: ProposalOutcome | null;
}) {
  const { t } = useTranslation();
  const results = outcome?.status === "batch" ? outcome.results : null;
  const refused = proposal.items.filter((item) => item.error).length;
  const summary = (item: BatchItem) =>
    item.preview
      ? item.preview.changes
          .slice(0, 3)
          .map((c) => `${c.field}: ${show(c.after, t)}`)
          .join(" · ")
      : "";
  return (
    <>
      <div>
        <div className="font-semibold">{proposal.title}</div>
        <div className="text-muted-foreground">
          {t("assistant.proposal.batchCount", { count: proposal.items.length })}
          {refused > 0 && ` · ${t("assistant.proposal.batchRefused", { count: refused })}`}
        </div>
      </div>
      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr className="text-left">
              <th className="py-1 pr-2 font-medium">#</th>
              <th className="py-1 pr-2 font-medium">{t("assistant.proposal.batchWhat")}</th>
              <th className="py-1 pr-2 font-medium">{t("assistant.proposal.batchDetails")}</th>
              <th className="py-1 font-medium">{t("assistant.proposal.batchStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {proposal.items.map((item, i) => {
              const result = results?.[i];
              return (
                <tr key={i} className="border-t border-border align-top">
                  <td className="py-1 pr-2 text-muted-foreground">{i + 1}</td>
                  <td className="py-1 pr-2">
                    <div className="font-medium">
                      {t(`assistant.proposal.action.${item.action}`)} · {item.object.split(".").at(-1)}
                    </div>
                    <div className="text-muted-foreground">{item.preview?.presentation}</div>
                  </td>
                  <td className="py-1 pr-2">
                    {summary(item)}
                    {item.preview && item.preview.warnings.length > 0 && (
                      <div className="text-warning">{item.preview.warnings.join("; ")}</div>
                    )}
                  </td>
                  <td className="py-1">
                    {item.error ? (
                      <span className="text-destructive" title={item.error.message}>
                        {t("assistant.proposal.batchSkipped")}: {item.error.message}
                      </span>
                    ) : result?.ok ? (
                      <span className="text-success">✓ {result.state.presentation}</span>
                    ) : result ? (
                      <span className="text-destructive">✗ {result.message}</span>
                    ) : (
                      <span className="text-muted-foreground">{t("assistant.proposal.batchReady")}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {proposal.items.some((item) => item.preview?.willPost) && (
        <div className="text-xs font-medium">{t("assistant.proposal.batchPosting")}</div>
      )}
    </>
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
