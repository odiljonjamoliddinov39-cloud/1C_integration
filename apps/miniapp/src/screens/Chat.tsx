import type { CommandView } from "@platform/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "../components/Icon.js";
import { useApp } from "../context.js";
import { ApiError } from "../lib/api.js";
import { follow, isChatResult, isSummary, isTerminal } from "../lib/commands.js";
import { errorText } from "../lib/i18n.js";
import { haptic } from "../lib/telegram.js";

/** What this phone typed, by request id: the server keeps no text of a request after it is sent. */
const sentKey = (inn: string) => `sent:${inn}`;
function loadSent(inn: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(sentKey(inn)) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function saveSent(inn: string, sent: Record<string, string>): void {
  try {
    const entries = Object.entries(sent).slice(-60);
    localStorage.setItem(sentKey(inn), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Without storage the question shows as "sent from another device".
  }
}

export function ChatScreen() {
  const { api, t, lang, inn, device, go, setWaitingCount } = useApp();
  const [items, setItems] = useState<CommandView[]>([]);
  const [sent, setSent] = useState<Record<string, string>>(() => loadSent(inn));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef(new AbortController());
  const bottom = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const upsert = useCallback((view: CommandView) => {
    setItems((current) => {
      const rest = current.filter((c) => c.id !== view.id);
      return [...rest, view].sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
  }, []);

  // The recent messages of this company, and the ones still on their way.
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    void api
      .recent()
      .then((recent) => {
        const mine = recent.filter(
          (c) => c.company_inn === inn && (c.type === "chat.message" || c.type === "chat.attach"),
        );
        setItems(mine.sort((a, b) => a.created_at.localeCompare(b.created_at)));
        for (const c of mine) if (!isTerminal(c.state)) void follow(api, c.id, upsert, controller.signal);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [api, inn, upsert]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items]);

  const onDone = (view: CommandView | null) => {
    if (!view) return;
    if (view.state === "done") {
      haptic("success");
      const cards = isChatResult(view.result) ? view.result.cards.length : 0;
      if (cards > 0) setWaitingCount(cards);
    } else if (view.state === "failed") haptic("error");
  };

  async function submit(type: "chat.message" | "chat.attach", payload: unknown, label: string) {
    setBusy(true);
    setError(null);
    try {
      const view = await api.create({ type, inn, deviceId: device.device_id, payload });
      const next = { ...sent, [view.id]: label };
      setSent(next);
      saveSent(inn, next);
      upsert(view);
      void follow(api, view.id, upsert, abort.current.signal).then(onDone);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(errorText(lang, err.code, err.message));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const message = text.trim();
    if (!message || busy) return;
    setText("");
    await submit("chat.message", { text: message }, message);
  }

  async function attach(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await api.upload(file, device.device_id);
      setBusy(false);
      await submit(
        "chat.attach",
        { blob_id: blob.id, name: file.name },
        t("chat.fileSent", { name: file.name }),
      );
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(errorText(lang, err.code, err.message));
      setBusy(false);
    }
  }

  const cancel = (id: string) =>
    void api
      .cancel(id)
      .then(upsert)
      .catch(() => undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <div style={{ flex: 1 }}>
        {items.length === 0 && (
          <div className="empty">
            <span className="art">
              <Icon name="spark" size={30} />
            </span>
            <p>{t("chat.empty")}</p>
          </div>
        )}
        {items.map((c) => (
          <div key={c.id}>
            <div className="bubble me">{sent[c.id] ?? t("chat.fromOther")}</div>
            <Reply view={c} onCancel={() => cancel(c.id)} onWaiting={() => go("waiting")} />
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {error && <div className="err">{error}</div>}
      <div className="composer" style={{ position: "sticky", bottom: -18, background: "var(--page)" }}>
        <input ref={picker} type="file" hidden onChange={(e) => void attach(e.target.files?.[0])} />
        <button
          type="button"
          className="btn secondary round"
          aria-label={t("chat.attach")}
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <Icon name="clip" size={20} />
        </button>
        <textarea
          rows={1}
          value={text}
          placeholder={t("chat.placeholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="btn round"
          aria-label={t("chat.send")}
          disabled={busy || !text.trim()}
          onClick={() => void send()}
        >
          <Icon name="send" size={22} />
        </button>
      </div>
    </div>
  );
}

function Reply({
  view,
  onCancel,
  onWaiting,
}: {
  view: CommandView;
  onCancel: () => void;
  onWaiting: () => void;
}) {
  const { t, lang } = useApp();
  if (view.state === "done") {
    const reply = isChatResult(view.result)
      ? view.result.reply
      : isSummary(view.result)
        ? view.result.summary
        : "";
    const cards = isChatResult(view.result) ? view.result.cards.length : 0;
    const setAside = isChatResult(view.result) ? (view.result.set_aside ?? 0) : 0;
    return (
      <>
        {setAside > 0 && <div className="muted">{t("chat.setAside", { n: setAside })}</div>}
        {reply && <div className="bubble bot">{reply}</div>}
        {cards > 0 && (
          <div className="bubble bot">
            {t("chat.cards", { n: cards })}{" "}
            <button type="button" className="btn small" onClick={onWaiting}>
              {t("chat.openWaiting")}
            </button>
          </div>
        )}
      </>
    );
  }
  if (view.state === "failed")
    return <div className="bubble bot err">{errorText(lang, view.error?.code, view.error?.message)}</div>;
  const tone = view.state === "expired" || view.state === "cancelled" ? "bad" : "warn";
  return (
    <div className="muted progress">
      <span className={`chip ${tone}`}>{t(`state.${view.state}`)}</span>
      {(view.state === "running" || view.state === "delivered") && (
        <span className="working" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      {view.progress && <span>{view.progress}</span>}
      {view.state === "queued" && (
        <button type="button" className="btn small secondary" onClick={onCancel}>
          {t("cancel")}
        </button>
      )}
    </div>
  );
}
