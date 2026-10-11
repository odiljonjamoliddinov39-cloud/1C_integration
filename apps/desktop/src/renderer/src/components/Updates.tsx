import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { UpdateState } from "../../../shared/ipc";
import { Button } from "@/components/ui/button";

/** The app's own update state, kept current by the main process. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  useEffect(() => {
    let live = true;
    void window.platform.update.state().then((current) => live && setState(current));
    const unsubscribe = window.platform.update.onState(setState);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return state;
}

const DownloadIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
  </svg>
);

/** A new version downloading in the background, or ready to install with one click. */
export function UpdateBanner({ state }: { state: UpdateState }) {
  const { t } = useTranslation();
  if (state.status !== "downloading" && state.status !== "ready") return null;
  const ready = state.status === "ready";
  return (
    <div className="mx-6 mt-4 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-sm">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
        <DownloadIcon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {ready
            ? t("update.ready", { version: state.version })
            : t("update.downloading", { version: state.version, percent: state.percent })}
        </div>
        {!ready && (
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-sky-600 transition-all"
              style={{ width: `${state.percent}%` }}
            />
          </div>
        )}
      </div>
      {ready && (
        <Button size="sm" onClick={() => void window.platform.update.install()}>
          {t("update.restart")}
        </Button>
      )}
    </div>
  );
}

/** The version in the header; a click looks for a newer one. */
export function VersionButton({ version, state }: { version: string; state: UpdateState }) {
  const { t } = useTranslation();
  const [asked, setAsked] = useState(false);
  const label = `v${version}`;
  if (state.status === "unsupported") return <span className="text-xs text-sidebar-muted">{label}</span>;
  const note =
    state.status === "checking"
      ? t("update.checking")
      : asked && state.status === "latest"
        ? t("update.latest")
        : asked && state.status === "error"
          ? t("update.error")
          : null;
  return (
    <button
      type="button"
      className="text-left text-xs text-sidebar-muted hover:text-sidebar-foreground disabled:opacity-60"
      title={state.status === "error" ? `${t("update.error")}: ${state.message}` : t("update.check")}
      disabled={state.status === "checking"}
      onClick={() => {
        setAsked(true);
        void window.platform.update.check();
      }}
    >
      {note ? `${label} · ${note}` : label}
    </button>
  );
}
