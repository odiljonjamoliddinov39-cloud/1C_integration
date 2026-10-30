import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ConnectionInput, ConnectionTestResult, InfobaseInput } from "../../../shared/ipc";
import { errorText } from "@/components/ConnectorStatus";
import { useLimitDialog } from "@/components/Limit";
import { Button } from "@/components/ui/button";
import { Card, ErrorText } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { isLimitCode } from "@/lib/billing";

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
  // The bases 1C's launcher already knows on this PC: a base is picked here instead of typing its folder.
  const registered = useQuery({
    queryKey: ["registered-infobases"],
    queryFn: () => window.platform.companies.listInfobases(),
    staleTime: Infinity,
  });
  // When the base was found in a folder below the one that was entered, the field shows the real folder.
  const found = (result: ConnectionTestResult) => {
    if (result.resolvedFile) setFile(result.resolvedFile);
  };
  // What the form holds now, so an answer to an earlier request (the user changed the base meanwhile) is dropped.
  const key = JSON.stringify([kind, file, server, ref, user, password]);
  const current = useRef(key);
  useEffect(() => {
    current.current = key;
  }, [key]);

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

  const showLimit = useLimitDialog();
  const runTest = useMutation({
    mutationFn: async () => ({
      asked: current.current,
      result: await window.platform.companies.testConnection(connection()),
    }),
    onSuccess: ({ asked, result }) => {
      if (asked !== current.current) return;
      found(result);
      setTest(result);
      setOrganizationRef(result.organizations[0]?.ref ?? "");
    },
  });
  const install = useMutation({
    mutationFn: async () => ({
      asked: current.current,
      result: await window.platform.companies.installExtension(connection()),
    }),
    onSuccess: ({ asked, result }) => {
      if (asked !== current.current) return;
      found(result);
      setTest(result);
      setOrganizationRef(result.organizations[0]?.ref ?? "");
    },
  });
  // 1C is installed without its COM connector (or only as 32-bit): the app registers it, Windows asks to approve.
  const registerCom = useMutation({
    mutationFn: () => window.platform.companies.registerComConnector(),
    onSuccess: (result) => {
      if (result.ok) runTest.mutate();
    },
  });
  const save = useMutation({
    mutationFn: () => {
      const organization = test?.organizations.find((o) => o.ref === organizationRef);
      if (!organization) throw new Error("no organization");
      return window.platform.companies.add({ ...connection(), organization });
    },
    onSuccess: (result) => {
      if (!result.ok && isLimitCode(result.code)) showLimit(result.code, result.message);
      if (result.ok) onConnected();
    },
  });

  function pickRegistered(index: string) {
    const base = registered.data?.[Number(index)];
    if (!base) return;
    setKind(base.kind);
    if (base.kind === "file") setFile(base.file);
    else {
      setServer(base.server);
      setRef(base.ref);
    }
    setTest(null);
  }

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
  const registerError =
    registerCom.data && !registerCom.data.ok
      ? errorText(t, registerCom.data.code, registerCom.data.message)
      : (registerCom.error?.message ?? null);

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
          {(registered.data?.length ?? 0) > 0 && (
            <div>
              <Label htmlFor="registered">{t("connect.registered")}</Label>
              <select
                id="registered"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                defaultValue=""
                onChange={(e) => pickRegistered(e.target.value)}
              >
                <option value="" disabled>
                  {t("connect.pickRegistered")}
                </option>
                {registered.data?.map((base, i) => (
                  <option key={`${base.name}-${i}`} value={i}>
                    {base.name} — {base.kind === "file" ? base.file : `${base.server}/${base.ref}`}
                  </option>
                ))}
              </select>
            </div>
          )}
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

          {test?.resolvedFile && (
            <div className="rounded-lg bg-muted p-3 text-sm">
              {t("connect.found", { folder: test.resolvedFile })}
            </div>
          )}
          {runTest.isPending && <div className="text-sm text-muted-foreground">{t("connect.testing")}</div>}
          {install.isPending && (
            <div className="text-sm text-muted-foreground">{t("connect.installing")}</div>
          )}
          {test && !test.status.ok && (
            <ErrorText>{errorText(t, test.status.code, test.status.message)}</ErrorText>
          )}
          {/* The base is reachable but has no PlatformAPI: the app can load it itself. */}
          {test && !test.status.ok && test.status.code === "NOT_FOUND" && !install.isPending && (
            <div className="space-y-2 rounded-lg bg-muted p-3 text-sm">
              <div>{t("connect.installHint")}</div>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (window.confirm(t("connect.installConfirm"))) install.mutate();
                }}
              >
                {t("connect.install")}
              </Button>
            </div>
          )}
          {test && !test.status.ok && test.status.code === "COM_NOT_REGISTERED" && (
            <div className="space-y-2 rounded-lg bg-muted p-3 text-sm">
              <div>{t("connect.registerComHint")}</div>
              <Button
                type="button"
                size="sm"
                disabled={registerCom.isPending || runTest.isPending}
                onClick={() => {
                  if (window.confirm(t("connect.registerComConfirm"))) registerCom.mutate();
                }}
              >
                {registerCom.isPending ? t("connect.registeringCom") : t("connect.registerCom")}
              </Button>
              {registerError && <ErrorText>{registerError}</ErrorText>}
            </div>
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
              disabled={runTest.isPending || install.isPending}
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
