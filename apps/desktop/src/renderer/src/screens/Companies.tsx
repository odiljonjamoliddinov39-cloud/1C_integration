import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { CompanyView } from "../../../shared/ipc";
import { ConnectCompanyDialog } from "@/components/ConnectCompanyDialog";
import { ConnectorStatusBadge } from "@/components/ConnectorStatus";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { describeInfobase, formatTime } from "@/lib/format";

export function CompaniesScreen() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => window.platform.companies.list() });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["companies"] });
  const check = useMutation({
    mutationFn: (id: string) => window.platform.companies.checkStatus(id),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => window.platform.companies.remove(id),
    onSettled: refresh,
  });

  function confirmRemove(company: CompanyView) {
    if (window.confirm(t("companies.confirmRemove", { name: company.name }))) remove.mutate(company.id);
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("companies.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("companies.subtitle")}</p>
        </div>
        <Button className="ml-auto" onClick={() => setConnecting(true)}>
          {t("companies.connect")}
        </Button>
      </div>

      {companies.data?.length === 0 && (
        <Card className="p-10 text-center text-muted-foreground">{t("companies.empty")}</Card>
      )}

      <div className="grid gap-3">
        {companies.data?.map((company) => (
          <Card key={company.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
            <div className="min-w-56 flex-1">
              <div className="font-medium">{company.name}</div>
              <div className="text-xs text-muted-foreground">
                {t("companies.inn")} {company.inn || "—"}
              </div>
            </div>
            <div className="min-w-56 flex-1 text-sm">
              <div className="text-xs text-muted-foreground">{t("companies.infobase")}</div>
              <div className="truncate" title={describeInfobase(company.infobase)}>
                {describeInfobase(company.infobase)}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("companies.user")}: {company.user || "—"}
              </div>
            </div>
            <div className="min-w-48 text-sm">
              <div className="text-xs text-muted-foreground">{t("companies.connector")}</div>
              <ConnectorStatusBadge status={company.lastStatus} />
            </div>
            <div className="min-w-28 text-sm">
              <div className="text-xs text-muted-foreground">{t("companies.lastSync")}</div>
              {formatTime(company.lastSyncAt, i18n.language)}
            </div>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={check.isPending && check.variables === company.id}
                onClick={() => check.mutate(company.id)}
              >
                {t("companies.check")}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => confirmRemove(company)}>
                {t("companies.remove")}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {connecting && (
        <ConnectCompanyDialog
          onClose={() => setConnecting(false)}
          onConnected={() => {
            setConnecting(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
