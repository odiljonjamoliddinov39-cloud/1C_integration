import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RemoteStateView } from "../../../shared/ipc";
import { errorText } from "@/components/ConnectorStatus";
import { Button } from "@/components/ui/button";
import { Badge, Card, ErrorText } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { formatTime } from "@/lib/format";

const CEILINGS = ["read", "prepare", "apply"] as const;

/** Settings → Remote control: connect a phone, see and disconnect phones, the kill switch, the PIN, the log. */
export function RemoteScreen() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ["remote", "state"], queryFn: () => window.platform.remote.state() });
  const links = useQuery({
    queryKey: ["remote", "links"],
    queryFn: () => window.platform.remote.links(),
    enabled: state.data?.paired === true,
  });
  const log = useQuery({
    queryKey: ["remote", "log"],
    queryFn: () => window.platform.remote.log(),
    refetchInterval: 10_000,
  });

  // The connection comes and goes: the screen follows.
  useEffect(
    () =>
      window.platform.remote.onChange((view) => {
        queryClient.setQueryData(["remote", "state"], view);
        void queryClient.invalidateQueries({ queryKey: ["remote", "log"] });
      }),
    [queryClient],
  );

  const [pin, setPin] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (
    result: { ok: true; data: RemoteStateView } | { ok: false; code: string; message: string },
  ) => {
    if (result.ok) {
      setError(null);
      queryClient.setQueryData(["remote", "state"], result.data);
    } else setError(errorText(t, result.code, result.message));
  };

  const connect = useMutation({
    mutationFn: () => window.platform.remote.connect(),
    onSuccess: (result) => {
      if (!result.ok) setError(errorText(t, result.code, result.message));
      else setError(null);
      void queryClient.invalidateQueries({ queryKey: ["remote"] });
    },
  });
  const enable = useMutation({
    mutationFn: (enabled: boolean) => window.platform.remote.enable(enabled),
    onSuccess: apply,
  });
  const ceiling = useMutation({
    mutationFn: (value: (typeof CEILINGS)[number]) => window.platform.remote.setCeiling(value),
    onSuccess: apply,
  });
  const savePin = useMutation({
    mutationFn: (value: string | null) => window.platform.remote.setPin(value),
    onSuccess: (result) => {
      apply(result);
      if (result.ok) setPin("");
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => window.platform.remote.revoke(id),
    onSuccess: (result) => {
      if (!result.ok) setError(errorText(t, result.code, result.message));
      void queryClient.invalidateQueries({ queryKey: ["remote", "links"] });
    },
  });

  const view = state.data;
  const pairing = connect.data?.ok ? connect.data.data : null;
  const status = !view
    ? null
    : !view.enabled
      ? { tone: "warning" as const, text: t("remote.status.off") }
      : !view.paired
        ? { tone: "muted" as const, text: t("remote.status.notPaired") }
        : view.connected
          ? { tone: "success" as const, text: t("remote.status.connected") }
          : { tone: "danger" as const, text: t("remote.status.offline") };

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The link stays on screen to be copied by hand.
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-8">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{t("remote.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("remote.subtitle")}</p>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold">{t("remote.switchTitle")}</h2>
            {status && <Badge tone={status.tone}>{status.text}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {view?.enabled ? t("remote.switchOn") : t("remote.switchOff")}
          </p>
        </div>
        <Button
          variant={view?.enabled ? "outline" : "default"}
          disabled={!view || enable.isPending}
          onClick={() => enable.mutate(!view?.enabled)}
        >
          {view?.enabled ? t("remote.turnOff") : t("remote.turnOn")}
        </Button>
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold">{t("remote.connect")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("remote.connectHelp")}</p>
          </div>
          <Button disabled={connect.isPending || view?.enabled === false} onClick={() => connect.mutate()}>
            {t("remote.connect")}
          </Button>
        </div>
        {pairing && (
          <div className="space-y-3 rounded-xl bg-muted p-4">
            <div>
              <Label>{t("remote.code")}</Label>
              <div className="font-mono text-2xl font-bold tracking-widest">{pairing.code}</div>
            </div>
            {pairing.link && (
              <div>
                <Label>{t("remote.link")}</Label>
                <div className="flex items-center gap-3">
                  <code className="min-w-0 flex-1 break-all text-sm">{pairing.link}</code>
                  <Button size="sm" variant="outline" onClick={() => void copy(pairing.link)}>
                    {copied ? t("remote.copied") : t("remote.copy")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-lg font-bold">{t("remote.phones")}</h2>
        {links.data?.ok && links.data.data.length > 0 ? (
          <ul className="divide-y divide-border">
            {links.data.data.map((link) => (
              <li key={link.id} className="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div className="font-semibold">{link.username ? `@${link.username}` : "Telegram"}</div>
                  <div className="text-xs text-muted-foreground">
                    {t(`remote.ceilings.${link.ceiling}`)} ·{" "}
                    {t("remote.since", { date: formatTime(link.created_at, i18n.language) })}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(link.id)}
                >
                  {t("remote.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("remote.noPhones")}</p>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-lg font-bold">{t("remote.safety")}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="remote-ceiling">{t("remote.ceiling")}</Label>
            <select
              id="remote-ceiling"
              className="h-10 w-full rounded-lg border border-border bg-card px-2"
              value={view?.ceiling ?? "apply"}
              onChange={(e) => ceiling.mutate(e.target.value as (typeof CEILINGS)[number])}
            >
              {CEILINGS.map((c) => (
                <option key={c} value={c}>
                  {t(`remote.ceilings.${c}`)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{t("remote.ceilingNote")}</p>
          </div>
          <div>
            <Label htmlFor="remote-pin">{t("remote.pin")}</Label>
            <div className="flex gap-2">
              <Input
                id="remote-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={12}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              />
              <Button
                disabled={savePin.isPending}
                onClick={() =>
                  /^\d{4,12}$/.test(pin) ? savePin.mutate(pin) : setError(t("remote.pinInvalid"))
                }
              >
                {t("remote.pinSave")}
              </Button>
              {view?.hasPin && (
                <Button variant="outline" disabled={savePin.isPending} onClick={() => savePin.mutate(null)}>
                  {t("remote.pinRemove")}
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {view?.hasPin ? t("remote.pinSet") : t("remote.pinNone")} {t("remote.pinHelp")}
            </p>
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <div>
          <h2 className="text-lg font-bold">{t("remote.log")}</h2>
          <p className="text-xs text-muted-foreground">{t("remote.logHelp")}</p>
        </div>
        {log.data && log.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-4">{t("remote.columns.time")}</th>
                  <th className="py-1 pr-4">{t("remote.columns.request")}</th>
                  <th className="py-1 pr-4">{t("remote.columns.user")}</th>
                  <th className="py-1">{t("remote.columns.result")}</th>
                </tr>
              </thead>
              <tbody>
                {log.data.slice(0, 50).map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-1.5 pr-4 whitespace-nowrap">{formatTime(row.at, i18n.language)}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs">{row.type}</td>
                    <td className="py-1.5 pr-4">{row.telegramUser}</td>
                    <td className="py-1.5">
                      <Badge
                        tone={
                          row.status === "done" ? "success" : row.status === "refused" ? "warning" : "danger"
                        }
                      >
                        {t(`remote.results.${row.status}`)}
                      </Badge>
                      {row.code && <span className="ml-2 text-xs text-muted-foreground">{row.code}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("remote.noLog")}</p>
        )}
      </Card>
    </div>
  );
}
