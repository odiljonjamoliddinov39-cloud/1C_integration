import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ConnectionInput, ConnectionTestResult, InfobaseInput } from "../../../shared/ipc";
import { errorText } from "@/components/ConnectorStatus";
import { Button } from "@/components/ui/button";
import { Card, ErrorText } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/** TD §4 "Connect company": pick the infobase, check the 1C extension, choose the organization. */
export function ConnectCompanyDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<InfobaseInput["kind"]>("file");
  const [file, setFile] = useState("");
  const [server, setServer] = useState("");
  const [ref, setRef] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [organizationRef, setOrganizationRef] = useState("");
  const [test, setTest] = useState<ConnectionTestResult | null>(null);

  const connection = (): ConnectionInput => ({
    infobase: kind === "file" ? { kind, file } : { kind, server, ref },
    user,
    password,
  });
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setTest(null); // any change needs a new test
    };

  const runTest = useMutation({
    mutationFn: () => window.platform.companies.testConnection(connection()),
    onSuccess: (result) => {
      setTest(result);
      setOrganizationRef(result.organizations[0]?.ref ?? "");
    },
  });
  const save = useMutation({
    mutationFn: () => {
      const organization = test?.organizations.find((o) => o.ref === organizationRef);
      if (!organization) throw new Error("no organization");
      return window.platform.companies.add({ ...connection(), organization });
    },
    onSuccess: (result) => {
      if (result.ok) onConnected();
    },
  });

  async function browse() {
    const folder = await window.platform.companies.pickInfobaseFolder();
    if (folder) changed(setFile)(folder);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (test?.status.ok && organizationRef) save.mutate();
    else runTest.mutate();
  }

  const saveError =
    save.data && !save.data.ok
      ? errorText(t, save.data.code, save.data.message)
      : (save.error?.message ?? runTest.error?.message ?? null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <Card
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{t("connect.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("connect.hint")}</p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <div>
            <Label>{t("connect.kind")}</Label>
            <div className="flex gap-2">
              {(["file", "server"] as const).map((k) => (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={kind === k ? "default" : "outline"}
                  onClick={() => changed(setKind)(k)}
                >
                  {t(`connect.${k}`)}
                </Button>
              ))}
            </div>
          </div>
          {kind === "file" ? (
            <div>
              <Label htmlFor="folder">{t("connect.folder")}</Label>
              <div className="flex gap-2">
                <Input
                  id="folder"
                  placeholder="D:\Bases\TEST_CRYSTAL"
                  value={file}
                  onChange={(e) => changed(setFile)(e.target.value)}
                  required
                />
                <Button type="button" variant="outline" onClick={() => void browse()}>
                  {t("connect.browse")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="server">{t("connect.serverName")}</Label>
                <Input
                  id="server"
                  value={server}
                  onChange={(e) => changed(setServer)(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="ref">{t("connect.ref")}</Label>
                <Input id="ref" value={ref} onChange={(e) => changed(setRef)(e.target.value)} required />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="user">{t("connect.user")}</Label>
              <Input
                id="user"
                autoComplete="off"
                value={user}
                onChange={(e) => changed(setUser)(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="password">{t("connect.password")}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => changed(setPassword)(e.target.value)}
              />
            </div>
          </div>

          {runTest.isPending && <div className="text-sm text-muted-foreground">{t("connect.testing")}</div>}
          {test && !test.status.ok && (
            <ErrorText>{errorText(t, test.status.code, test.status.message)}</ErrorText>
          )}
          {test?.status.ok && (
            <div className="space-y-2 rounded-lg bg-success/10 p-3 text-sm">
              <div className="font-medium text-success">
                ✓{" "}
                {t("connect.connected", {
                  config: test.status.ping.configuration.synonym || test.status.ping.configuration.name,
                  version: test.status.ping.configuration.version,
                  extension: test.status.ping.extensionVersion,
                })}
              </div>
              {test.organizations.length === 0 ? (
                <div>{t("connect.noOrganizations")}</div>
              ) : (
                <div>
                  <Label htmlFor="organization">{t("connect.organization")}</Label>
                  <select
                    id="organization"
                    className="h-9 w-full rounded-lg border border-border bg-card px-2"
                    value={organizationRef}
                    onChange={(e) => setOrganizationRef(e.target.value)}
                  >
                    {test.organizations.map((o) => (
                      <option key={o.ref} value={o.ref}>
                        {o.name} · {o.inn || "—"}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          {saveError && <ErrorText>{saveError}</ErrorText>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("connect.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={runTest.isPending}
              onClick={() => runTest.mutate()}
            >
              {t("connect.test")}
            </Button>
            <Button disabled={!test?.status.ok || !organizationRef || save.isPending}>
              {t("connect.save")}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
