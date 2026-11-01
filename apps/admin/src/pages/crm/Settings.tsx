import type { AdminView, CrmStageView } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, ErrorText, Input, Section, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { href } from "@/lib/router";

type Kind = "open" | "won" | "lost";
const kindOf = (s: CrmStageView): Kind => (s.isWon ? "won" : s.isLost ? "lost" : "open");

function StageRow({
  stage,
  index,
  all,
  onChanged,
}: {
  stage: CrmStageView;
  index: number;
  all: CrmStageView[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(stage.name);
  const [removing, setRemoving] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const set = (cache: unknown) => {
    queryClient.setQueryData(["crm-funnel"], cache);
    onChanged();
  };
  const update = useMutation({
    mutationFn: (input: Parameters<typeof api.crmUpdateStage>[1]) => api.crmUpdateStage(stage.id, input),
    onSuccess: set,
  });
  const reorder = useMutation({
    mutationFn: (direction: -1 | 1) => {
      const ids = all.map((s) => s.id);
      const [moved] = ids.splice(index, 1);
      ids.splice(index + direction, 0, moved as string);
      return api.crmReorderStages(ids);
    },
    onSuccess: set,
  });
  const remove = useMutation({
    mutationFn: () => api.crmDeleteStage(stage.id, moveTo || undefined),
    onSuccess: set,
  });
  const others = all.filter((s) => s.id !== stage.id);
  return (
    <li className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          aria-label={t("Colour")}
          className="size-9 cursor-pointer rounded-lg border border-border bg-card p-0.5"
          value={stage.color}
          onChange={(e) => update.mutate({ color: e.target.value })}
        />
        <Input
          className="min-w-40 flex-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== stage.name && update.mutate({ name })}
        />
        <Select
          value={kindOf(stage)}
          onChange={(e) => {
            const kind = e.target.value as Kind;
            update.mutate({ isWon: kind === "won", isLost: kind === "lost" });
          }}
        >
          <option value="open">{t("Open stage")}</option>
          <option value="won">{t("Won (customer)")}</option>
          <option value="lost">{t("Lost (outside the funnel)")}</option>
        </Select>
        <span className="tabular w-20 text-right text-xs text-muted-foreground">
          {t("{n} leads", { n: stage.leads })}
        </span>
        <Button
          variant="ghost"
          disabled={index === 0 || reorder.isPending}
          onClick={() => reorder.mutate(-1)}
          aria-label={t("Move up")}
        >
          ↑
        </Button>
        <Button
          variant="ghost"
          disabled={index === all.length - 1 || reorder.isPending}
          onClick={() => reorder.mutate(1)}
          aria-label={t("Move down")}
        >
          ↓
        </Button>
        <Button
          variant="danger"
          onClick={() => (stage.leads === 0 ? remove.mutate() : setRemoving(!removing))}
        >
          {t("Delete")}
        </Button>
      </div>
      {removing && stage.leads > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span>{t("Move its {n} leads to", { n: stage.leads })}</span>
          <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="">—</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Button variant="danger" disabled={!moveTo || remove.isPending} onClick={() => remove.mutate()}>
            {t("Move and delete")}
          </Button>
        </div>
      )}
      <ErrorText error={update.error ?? reorder.error ?? remove.error} />
    </li>
  );
}

/** The funnel's settings (owner and support): add, rename, colour, reorder and delete the stages, and say which is won and which is lost. */
export function CrmSettingsPage({ me }: { me: AdminView }) {
  const queryClient = useQueryClient();
  const funnel = useQuery({ queryKey: ["crm-funnel"], queryFn: api.crmFunnel });
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.crmAddStage({ name }),
    onSuccess: (data) => {
      queryClient.setQueryData(["crm-funnel"], data);
      setName("");
    },
  });
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
    void queryClient.invalidateQueries({ queryKey: ["crm-board"] });
  };
  const stages = funnel.data?.stages ?? [];
  return (
    <div className="space-y-4">
      <Section title={t("Funnel stages")}>
        <p className="mb-3 text-sm text-muted-foreground">
          {t(
            "A lead moves through the stages in this order. Mark the stage where a lead becomes a customer as won, and the one where it is gone as lost: lost stages stay outside the funnel in the reports.",
          )}
        </p>
        <ErrorText error={funnel.error} />
        <ul className="space-y-2">
          {stages.map((s, i) => (
            <StageRow key={s.id} stage={s} index={i} all={stages} onChanged={changed} />
          ))}
        </ul>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <Input
            className="min-w-0 flex-1"
            placeholder={t("New stage name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button disabled={add.isPending || !name.trim()}>{t("Add a stage")}</Button>
        </form>
        <div className="mt-2">
          <ErrorText error={add.error} />
        </div>
      </Section>
      {me.role === "owner" && (
        <Section title={t("Sales managers")}>
          <p className="text-sm text-muted-foreground">
            {t(
              "Managers are added on the Admins page, with the role Sales manager. They sign in to the CRM Mini App with their email and the one-time password shown there.",
            )}{" "}
            <a className="font-semibold text-primary hover:underline" href={href("admins", "buxgalteriya")}>
              {t("Open the Admins page")}
            </a>
          </p>
        </Section>
      )}
    </div>
  );
}
