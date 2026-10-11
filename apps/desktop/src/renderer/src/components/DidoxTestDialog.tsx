import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DidoxTestResult } from "../../../shared/ipc";
import { errorText } from "@/components/ConnectorStatus";
import { Button } from "@/components/ui/button";
import { Card, ErrorText } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** A first look at Didox: E-IMZO, the key, the sign-in and what Didox answers. Changes nothing. */
export function DidoxTestDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const keys = useQuery({
    queryKey: ["didox-keys"],
    queryFn: () => window.platform.didox.keys(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const run = useMutation({
    mutationFn: () =>
      window.platform.didox.test({
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(serialNumber ? { serialNumber } : {}),
      }),
  });
  const result: DidoxTestResult | null = run.data?.ok ? run.data.data : null;
  const keyList = keys.data?.ok ? keys.data.data : [];

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <Card className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto p-6">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h2 className="text-lg font-bold">{t("didox.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("didox.hint")}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("didox.close")}
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="didox-url">{t("didox.address")}</Label>
            <Input
              id="didox-url"
              placeholder="https://devapi.goodsign.biz/"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="didox-apikey">{t("didox.apiKey")}</Label>
            <Input
              id="didox-apikey"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-2">
            <Label htmlFor="didox-key" className="mb-0">
              {t("didox.key")}
            </Label>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => void keys.refetch()}
            >
              {t("didox.reload")}
            </button>
          </div>
          {keys.isFetching ? (
            <div className="text-sm text-muted-foreground">{t("didox.loadingKeys")}</div>
          ) : keys.data && !keys.data.ok ? (
            <ErrorText>{errorText(t, keys.data.code, keys.data.message)}</ErrorText>
          ) : (
            <select
              id="didox-key"
              className="h-9 w-full rounded-lg border border-border bg-card px-2 text-sm"
              value={serialNumber}
              onChange={(e) => setSerialNumber(e.target.value)}
            >
              <option value="">{t("didox.keyAuto", { count: keyList.length })}</option>
              {keyList.map((k) => (
                <option key={k.serialNumber} value={k.serialNumber}>
                  {k.commonName} · {k.organization} · INN {k.tin} · {k.validTo ?? "?"}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? t("didox.running") : t("didox.run")}
          </Button>
          {run.isPending && <span className="text-sm text-muted-foreground">{t("didox.passwordHint")}</span>}
        </div>

        {run.data && !run.data.ok && <ErrorText>{run.data.message}</ErrorText>}
        {result && (
          <ol className="space-y-2">
            {result.steps.map((step) => (
              <li
                key={step.name}
                className={cn(
                  "rounded-xl border px-3 py-2 text-sm",
                  step.ok ? "border-teal/30 bg-teal/5" : "border-destructive/30 bg-destructive/5",
                )}
              >
                <div className="font-semibold">
                  {step.ok ? "✓" : "✗"} {t(`didox.steps.${step.name}`)}
                </div>
                <pre className="mt-1 max-h-48 overflow-auto text-xs break-words whitespace-pre-wrap text-muted-foreground">
                  {step.detail}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
