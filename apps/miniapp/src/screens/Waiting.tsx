import type { CommandView, ProposalCard } from "@platform/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "../components/Icon.js";
import { useApp } from "../context.js";
import { ApiError, type DeviceInfo } from "../lib/api.js";
import { follow, isApplyResult, isCardsResult } from "../lib/commands.js";
import { errorText } from "../lib/i18n.js";
import { haptic } from "../lib/telegram.js";

const SHOWN_LINES = 8;

/** A company the phone may ask on its PC, with the PC it lives on. */
interface Target {
  inn: string;
  name: string;
  device: DeviceInfo;
}
interface Item {
  card: ProposalCard;
  target: Target;
}

export function WaitingScreen() {
  const { api, t, lang, me, device, setWaitingCount } = useApp();
  const [items, setItems] = useState<Item[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<Item | null>(null);
  const abort = useRef(new AbortController());

  // Every company on every PC that is online, not only the one chosen at the top: a notification names no company, so what is
  // waiting is looked for in all of them.
  const targets: Target[] = me.devices.flatMap((d) =>
    d.online ? d.companies.map((c) => ({ inn: c.inn, name: c.name, device: d })) : [],
  );
  const key = targets.map((x) => `${x.device.device_id}:${x.inn}`).join(",");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const found = await Promise.all(
        targets.map(async (target) => {
          const view = await api.create({
            type: "proposal.list",
            inn: target.inn,
            deviceId: target.device.device_id,
            payload: {},
          });
          const done = await follow(api, view.id, () => undefined, abort.current.signal);
          if (!done) return { items: [] as Item[], error: null };
          if (done.state === "done" && isCardsResult(done.result))
            return { items: done.result.cards.map((card) => ({ card, target })), error: null };
          return { items: [] as Item[], error: errorText(lang, done.error?.code, done.error?.message) };
        }),
      );
      const all = found.flatMap((f) => f.items);
      setItems(all);
      setWaitingCount(all.filter((i) => i.card.status === "waiting").length);
      const firstError = found.find((f) => f.error)?.error;
      if (firstError) setError(firstError);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(errorText(lang, err.code, err.message));
    } finally {
      setLoading(false);
    }
    // `key` stands for the list of targets: a new PC or company is looked at again.
  }, [api, key, lang, setWaitingCount]);

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    void load();
    // Coming back to the app (from the notification, from another app) shows what is waiting now.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const cards = items;
  const severalCompanies = targets.length > 1;

  return (
    <>
      <div className="row">
        <h2>{t("waiting.title")}</h2>
        <button type="button" className="btn small secondary" disabled={loading} onClick={() => void load()}>
          {loading ? t("loading") : t("waiting.refresh")}
        </button>
      </div>
      {targets.length === 0 && !device.online && <p className="muted">{t("pc.offline")}</p>}
      {error && <div className="err">{error}</div>}
      {cards === null && loading && (
        <>
          <div className="skeleton" />
          <div className="skeleton" />
        </>
      )}
      {cards?.length === 0 && (
        <div className="empty">
          <span className="art">
            <Icon name="inbox" size={30} />
          </span>
          <p>{t("waiting.empty")}</p>
        </div>
      )}
      {cards && cards.some((i) => i.target.device.ceiling !== "apply") && (
        <p className="muted">{t("waiting.needsApply")}</p>
      )}
      {cards?.map((item) => (
        <Card
          key={`${item.target.inn}-${item.card.id}`}
          card={item.card}
          target={item.target}
          heading={severalCompanies ? item.target.name : null}
          canApply={item.target.device.ceiling === "apply"}
          onApply={() => setApplying(item)}
          onDeclined={() => void load()}
        />
      ))}
      {applying && (
        <ApplySheet
          card={applying.card}
          target={applying.target}
          onClose={() => setApplying(null)}
          onFinished={(refresh) => {
            setApplying(null);
            if (refresh) void load();
          }}
        />
      )}
    </>
  );
}

function Card({
  card,
  target,
  heading,
  canApply,
  onApply,
  onDeclined,
}: {
  card: ProposalCard;
  target: Target;
  /** The company's name above the card when the phone has several. */
  heading: string | null;
  canApply: boolean;
  onApply: () => void;
  onDeclined: () => void;
}) {
  const { t, lang, api } = useApp();
  const { inn, device } = target;
  const [all, setAll] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A card waiting on the PC keeps the assistant from taking new messages: it can be declined from here.
  const mayDecline = device.ceiling !== "read" && (card.status === "waiting" || card.status === "refused");
  async function decline() {
    setDeclining(true);
    setError(null);
    try {
      const view = await api.create({
        type: "proposal.decline",
        inn,
        deviceId: device.device_id,
        payload: { proposal_id: card.id },
      });
      const done = await follow(api, view.id, () => undefined);
      if (done?.state === "done") onDeclined();
      else setError(errorText(lang, done?.error?.code, done?.error?.message));
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(errorText(lang, err.code, err.message));
    } finally {
      setDeclining(false);
    }
  }
  const lines = all ? card.lines : card.lines.slice(0, SHOWN_LINES);
  return (
    <div className="card">
      {heading && <div className="muted">{heading}</div>}
      <div className="row">
        <strong>{card.title}</strong>
        <span
          className={`chip ${card.status === "waiting" ? "warn" : card.status === "applied" ? "ok" : ""}`}
        >
          {t(`waiting.status.${card.status}`)}
        </span>
      </div>
      <ul className="lines">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      {card.lines.length > SHOWN_LINES && (
        <button
          type="button"
          className="btn small secondary"
          style={{ marginTop: 8 }}
          onClick={() => setAll(!all)}
        >
          {all ? t("waiting.less") : t("waiting.more", { n: card.lines.length })}
        </button>
      )}
      {error && <div className="err">{error}</div>}
      <div className="row" style={{ marginTop: 10, justifyContent: "flex-start" }}>
        {card.status === "waiting" && canApply && (
          <button type="button" className="btn" onClick={onApply}>
            {t("waiting.apply")}
          </button>
        )}
        {mayDecline && (
          <button type="button" className="btn secondary" disabled={declining} onClick={() => void decline()}>
            {t("waiting.decline")}
          </button>
        )}
      </div>
    </div>
  );
}

function ApplySheet({
  card,
  target,
  onClose,
  onFinished,
}: {
  card: ProposalCard;
  target: Target;
  onClose: () => void;
  onFinished: (refresh: boolean) => void;
}) {
  const { api, t, lang } = useApp();
  const { inn, device } = target;
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const abort = useRef(new AbortController());
  useEffect(() => () => abort.current.abort(), []);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      // One id for this tap: a second tap while the first is on its way makes no second command.
      const view = await api.create({
        type: "proposal.apply",
        inn,
        deviceId: device.device_id,
        payload: { proposal_id: card.id, pin },
        proposalHash: card.hash,
        requestId: requestIdFor(card),
      });
      const done: CommandView | null = await follow(api, view.id, () => undefined, abort.current.signal);
      // It ended: the next tap (another PIN, a second try) is a new request.
      forgetTap(card);
      if (!done) return;
      if (done.state === "done" && isApplyResult(done.result)) {
        haptic("success");
        setResult(
          t("waiting.result", {
            created: done.result.created,
            skipped: done.result.skipped,
            refused: done.result.refused,
          }) + (done.result.reasons.length ? `\n${done.result.reasons.join("\n")}` : ""),
        );
      } else {
        haptic("error");
        const code = done.error?.code;
        setError(errorText(lang, code ?? done.state.toUpperCase(), done.error?.message));
        // The proposal changed or is gone: the list is read again so the phone shows what the PC has.
        if (code === "PROPOSAL_CHANGED" || code === "PROPOSAL_GONE") setTimeout(() => onFinished(true), 1800);
      }
    } catch (e) {
      forgetTap(card);
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(errorText(lang, err.code, err.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true">
      <div>
        <h2>{t("waiting.applyTitle")}</h2>
        <p className="muted">{card.title}</p>
        {result ? (
          <>
            <p style={{ whiteSpace: "pre-wrap" }}>{result}</p>
            <button type="button" className="btn" onClick={() => onFinished(true)}>
              {t("waiting.close")}
            </button>
          </>
        ) : (
          <>
            <p className="muted">{t("waiting.applyHelp")}</p>
            <label htmlFor="apply-pin">{t("waiting.pin")}</label>
            <input
              id="apply-pin"
              className="field"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
            {error && <div className="err">{error}</div>}
            <div className="row" style={{ marginTop: 14 }}>
              <button type="button" className="btn secondary" onClick={onClose}>
                {t("waiting.close")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || pin.length < 4}
                onClick={() => void apply()}
              >
                {t("waiting.confirm")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** While a card's Apply is on its way it has one request id, so a double tap is one command; when it ends the id is dropped. */
const taps = new Map<string, string>();
const tapKey = (card: ProposalCard) => `${card.id}:${card.hash}`;
function requestIdFor(card: ProposalCard): string {
  const known = taps.get(tapKey(card));
  if (known) return known;
  const id = crypto.randomUUID();
  taps.set(tapKey(card), id);
  return id;
}
function forgetTap(card: ProposalCard): void {
  taps.delete(tapKey(card));
}
