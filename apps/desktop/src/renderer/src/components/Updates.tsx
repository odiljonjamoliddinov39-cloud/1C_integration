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

/** A new version downloading in the background, or ready to install with one click. */
export function UpdateBanner({ state }: { state: UpdateState }) {
  const { t } = useTranslation();
  if (state.status === "downloading")
    return (
      <div className="bg-muted px-6 py-2 text-sm text-muted-foreground">
        {t("update.downloading", { version: state.version, percent: state.percent })}
      </div>
    );
  if (state.status !== "ready") return null;
  return (
    <div className="flex items-center gap-3 bg-primary/10 px-6 py-2 text-sm">
      <span>{t("update.ready", { version: state.version })}</span>
      <Button size="sm" className="ml-auto" onClick={() => void window.platform.update.install()}>
        {t("update.restart")}
      </Button>
    </div>
  );
}

/** The version in the header; a click looks for a newer one. */
export function VersionButton({ version, state }: { version: string; state: UpdateState }) {
  const { t } = useTranslation();
  const [asked, setAsked] = useState(false);
  const label = `v${version}`;
  if (state.status === "unsupported") return <span className="text-muted-foreground">{label}</span>;
  const note =
    state.status === "checking"
      ? t("update.checking")
      : asked && state.status === "latest"
        ? t("update.latest")
        : asked && state.status === "error"
          ? t("update.error")
          : null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      title={state.status === "error" ? `${t("update.error")}: ${state.message}` : t("update.check")}
      disabled={state.status === "checking"}
      onClick={() => {
        setAsked(true);
        void window.platform.update.check();
      }}
    >
      {note ? `${label} · ${note}` : label}
    </Button>
  );
}
