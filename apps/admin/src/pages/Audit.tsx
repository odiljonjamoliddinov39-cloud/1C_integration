import { useQuery } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

import { Card, Empty, ErrorText, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { href } from "@/lib/router";

export function AuditPage() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: api.audit });
  return (
    <Card>
      <div className="border-b border-border p-3">
        <h1 className="text-sm font-semibold">{t("Admin actions (latest 200)")}</h1>
      </div>
      <ErrorText error={audit.error} />
      {audit.data?.length === 0 ? (
        <Empty>{t("Nothing yet.")}</Empty>
      ) : (
        <Table head={[t("When"), t("Admin"), t("Action"), t("Target"), t("Details")]}>
          {audit.data?.map((e) => {
            const [kind, id] = e.target.split(":");
            return (
              <tr key={e.id}>
                <Td className="whitespace-nowrap">{dateTime(e.at)}</Td>
                <Td>{e.adminEmail ?? "—"}</Td>
                <Td className="font-medium">{e.action}</Td>
                <Td>
                  {kind === "account" && id ? (
                    <a className="text-primary hover:underline" href={href(`customers/${id}`)}>
                      {t("customer")}
                    </a>
                  ) : (
                    kind
                  )}
                </Td>
                <Td className="text-xs text-muted-foreground">
                  {Object.entries(e.payload)
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(" · ")}
                </Td>
              </tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}
