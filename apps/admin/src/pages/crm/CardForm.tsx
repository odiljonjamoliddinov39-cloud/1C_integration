import type { CrmCardSection } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, ErrorText, Section } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { CardFieldInput } from "./CardFields";

function Fields({
  sections,
  saved,
  leadId,
}: {
  sections: CrmCardSection[];
  saved: Record<string, string>;
  leadId: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>(saved);
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      // Only what changed is sent; a field cleared is sent empty.
      const changes: Record<string, string> = {};
      for (const f of sections.flatMap((s) => s.fields)) {
        const now = draft[f.id] ?? "";
        if (now !== (saved[f.id] ?? "")) changes[f.id] = now;
      }
      return api.crmSaveValues(leadId, changes);
    },
    onSuccess: () => {
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: ["crm-lead", leadId] });
    },
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setDone(false);
        save.mutate();
      }}
    >
      {sections.map((s) => (
        <Section key={s.id} title={s.name}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {s.fields.map((f) => (
              <label key={f.id} className="block space-y-1 text-sm">
                <span className="text-xs font-semibold text-muted-foreground">{f.label}</span>
                <CardFieldInput
                  field={f}
                  value={draft[f.id] ?? ""}
                  onChange={(value) => {
                    setDone(false);
                    setDraft({ ...draft, [f.id]: value });
                  }}
                />
              </label>
            ))}
            {s.fields.length === 0 && <span className="text-sm text-muted-foreground">—</span>}
          </div>
        </Section>
      ))}
      <div className="flex items-center gap-3">
        <Button disabled={save.isPending}>{t("Save the card")}</Button>
        {done && <span className="text-sm text-success">{t("Saved.")}</span>}
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}

/** The lead's client card: the sections the admin made, with the fields to fill in. Nothing shows while the admin has made none. */
export function CardForm({ leadId, saved }: { leadId: string; saved: Record<string, string> }) {
  const card = useQuery({ queryKey: ["crm-card"], queryFn: api.crmCard });
  const sections = (card.data ?? []).filter((s) => s.fields.length > 0);
  if (sections.length === 0) return null;
  // Starts again from the saved values when they change on the server (the key).
  return <Fields key={JSON.stringify(saved)} sections={sections} saved={saved} leadId={leadId} />;
}
