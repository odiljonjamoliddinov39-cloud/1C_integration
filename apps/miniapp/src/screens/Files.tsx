import type { BlobRef, CommandView } from "@platform/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { useApp } from "../context.js";
import { ApiError } from "../lib/api.js";
import { follow, formatBytes, isSummary, isTerminal } from "../lib/commands.js";
import { errorText } from "../lib/i18n.js";
import { deliverFile, haptic } from "../lib/telegram.js";

const REPORTS = ["balance", "debts", "vat", "audit"] as const;
const today = () => new Date().toISOString().slice(0, 10);

export function FilesScreen() {
  const { api, t, lang, inn, device } = useApp();
  const [report, setReport] = useState<(typeof REPORTS)[number]>("balance");
  const [format, setFormat] = useState<"xlsx" | "pdf">("xlsx");
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<CommandView | null>(null);
  const [recent, setRecent] = useState<CommandView[]>([]);
  const abort = useRef(new AbortController());

  const reload = useCallback(() => {
    void api
      .recent()
      .then((all) =>
        setRecent(all.filter((c) => c.company_inn === inn && c.type === "report.make" && c.blobs.length > 0)),
      )
      .catch(() => undefined);
  }, [api, inn]);

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    reload();
    return () => controller.abort();
  }, [reload]);

  async function make() {
    setBusy(true);
    setError(null);
    setCurrent(null);
    try {
      const withPeriod = report === "vat" || report === "audit";
      const view = await api.create({
        type: "report.make",
        inn,
        deviceId: device.device_id,
        payload: {
          report,
          format,
          lang,
          ...(withPeriod ? { from } : {}),
          to,
        },
      });
      setCurrent(view);
      const done = await follow(api, view.id, setCurrent, abort.current.signal);
      if (done?.state === "done") {
        haptic("success");
        reload();
      } else if (done?.state === "failed") haptic("error");
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(errorText(lang, err.code, err.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>{t("files.title")}</h2>
      <div className="card">
        <label htmlFor="report-kind">{t("files.report")}</label>
        <select
          id="report-kind"
          className="field"
          value={report}
          onChange={(e) => setReport(e.target.value as typeof report)}
        >
          {REPORTS.map((r) => (
            <option key={r} value={r}>
              {t(`files.reports.${r}`)}
            </option>
          ))}
        </select>
        <div className="row" style={{ alignItems: "flex-end" }}>
          {(report === "vat" || report === "audit") && (
            <div style={{ flex: 1 }}>
              <label htmlFor="report-from">{t("files.from")}</label>
              <input
                id="report-from"
                className="field"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
          )}
          <div style={{ flex: 1 }}>
            <label htmlFor="report-to">{t("files.to")}</label>
            <input
              id="report-to"
              className="field"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        <label htmlFor="report-format">{t("files.format")}</label>
        <select
          id="report-format"
          className="field"
          value={format}
          onChange={(e) => setFormat(e.target.value as typeof format)}
        >
          <option value="xlsx">Excel (.xlsx)</option>
          <option value="pdf">PDF</option>
        </select>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={busy} onClick={() => void make()}>
            {t("files.make")}
          </button>
        </div>
        {error && <div className="err">{error}</div>}
        {current && !isTerminal(current.state) && <p className="muted">{t(`state.${current.state}`)}</p>}
        {current?.state === "failed" && (
          <div className="err">{errorText(lang, current.error?.code, current.error?.message)}</div>
        )}
        {current?.state === "done" && (
          <div style={{ marginTop: 10 }}>
            {isSummary(current.result) && <p style={{ whiteSpace: "pre-wrap" }}>{current.result.summary}</p>}
            {current.blobs.map((b) => (
              <FileRow key={b.id} blob={b} />
            ))}
          </div>
        )}
      </div>
      <h2>{t("files.recent")}</h2>
      {recent.length === 0 && <p className="muted">{t("files.none")}</p>}
      {recent.map((c) =>
        c.blobs.map((b) => (
          <div className="card" key={b.id}>
            <FileRow blob={b} />
          </div>
        )),
      )}
    </>
  );
}

function FileRow({ blob }: { blob: BlobRef }) {
  const { api, t, lang } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await deliverFile(await api.download(blob.id), blob.name);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(
        err.code === "BLOB_EXPIRED" || err.status === 404
          ? t("files.expired")
          : errorText(lang, err.code, err.message),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="row">
        <span style={{ overflowWrap: "anywhere" }}>
          {blob.name} <span className="muted">{formatBytes(blob.size)}</span>
        </span>
        <button type="button" className="btn small" disabled={busy} onClick={() => void save()}>
          {busy ? t("files.sharing") : t("files.download")}
        </button>
      </div>
      {error && <div className="err">{error}</div>}
    </div>
  );
}
