import {
  AI_MODELS,
  type AdminView,
  type AiEffort,
  type AiModelId,
  type AiSettingsView,
} from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge, Button, ErrorText, Section } from "@/components/ui";
import { EFFORTS, effortName, modelName } from "@/lib/ai";
import { api } from "@/lib/api";
import { date } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The model and effort the assistant runs on for every customer without its own setting. */
export function AiModelPage({ me }: { me: AdminView }) {
  const current = useQuery({ queryKey: ["ai-settings"], queryFn: api.aiSettings });
  if (current.error) return <ErrorText error={current.error} />;
  if (!current.data) return null;
  // Remounted when the saved setting changes, so the choice starts from it.
  return <AiModelForm key={`${current.data.model}-${current.data.effort}`} saved={current.data} me={me} />;
}

function AiModelForm({ saved, me }: { saved: AiSettingsView; me: AdminView }) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState<AiModelId>(
    AI_MODELS.find((m) => m.id === saved.model)?.id ?? "claude-sonnet-5-5",
  );
  const [effort, setEffort] = useState<AiEffort>(EFFORTS.find((e) => e.id === saved.effort)?.id ?? "high");
  const save = useMutation({
    mutationFn: () => api.setAiSettings({ model, effort }),
    onSuccess: (data) => queryClient.setQueryData(["ai-settings"], data),
  });
  const owner = me.role === "owner";
  const changed = saved.model !== model || saved.effort !== effort;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold">AI model</h1>
          <p className="text-sm text-muted-foreground">
            What the assistant runs on for every customer, unless a customer has its own setting (on the
            customer&apos;s page). A change applies from the next step of every answer; no app update needed.
          </p>
        </div>
        <div className="ml-auto text-right text-sm">
          <div>
            Now: <b>{modelName(saved.model)}</b> · <b>{effortName(saved.effort)}</b> effort
          </div>
          <div className="text-xs text-muted-foreground">
            {saved.source === "admin"
              ? `set ${saved.updatedAt ? date(saved.updatedAt) : ""}${saved.updatedBy ? ` by ${saved.updatedBy}` : ""}`
              : "the server's default (AI_MODEL / AI_EFFORT)"}
          </div>
        </div>
      </div>

      <Section title="Model">
        <div className="grid gap-3 md:grid-cols-2">
          {AI_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={!owner}
              onClick={() => setModel(m.id)}
              aria-pressed={model === m.id}
              className={cn(
                "rounded-lg border p-3 text-left disabled:cursor-default",
                model === m.id ? "border-primary ring-2 ring-primary/30" : "border-border hover:bg-muted",
              )}
            >
              <div className="flex items-center gap-2 font-medium">
                {m.name}
                {saved.model === m.id && <Badge tone="success">in use</Badge>}
              </div>
              <div className="font-mono text-xs text-muted-foreground">{m.id}</div>
              <div className="mt-1 text-xs text-muted-foreground">{m.price}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Effort">
        <div className="grid gap-2 md:grid-cols-5">
          {EFFORTS.map((e) => (
            <button
              key={e.id}
              type="button"
              disabled={!owner}
              onClick={() => setEffort(e.id)}
              aria-pressed={effort === e.id}
              className={cn(
                "rounded-lg border p-3 text-left disabled:cursor-default",
                effort === e.id ? "border-primary ring-2 ring-primary/30" : "border-border hover:bg-muted",
              )}
            >
              <div className="flex items-center gap-2 font-medium">
                {e.name}
                {saved.effort === e.id && <Badge tone="success">in use</Badge>}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{e.note}</div>
            </button>
          ))}
        </div>
      </Section>

      {owner ? (
        <div className="flex items-center gap-3">
          <Button
            disabled={!changed || save.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Run the assistant on ${modelName(model)} at ${effortName(effort)} effort for every customer?`,
                )
              )
                save.mutate();
            }}
          >
            Save
          </Button>
          <ErrorText error={save.error} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only an owner can change the model.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Higher effort and Opus give better answers on long jobs, take longer per step, and cost more (see AI
        usage). Open chats continue on the new setting.
      </p>
    </div>
  );
}
