import { useEffect, useState } from "react";

import type { CrmCardField, CrmCardSection } from "@platform/shared";

import { useApp } from "../context.js";
import { ApiError } from "../lib/api.js";
import { type Words, errorText } from "../lib/i18n.js";
import { haptic } from "../lib/telegram.js";

function FieldInput({
  field,
  value,
  words,
  onChange,
}: {
  field: CrmCardField;
  value: string;
  words: Words;
  onChange: (value: string) => void;
}) {
  if (field.type === "textarea")
    return <textarea className="field" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />;
  if (field.type === "select" || field.type === "checkbox") {
    const options =
      field.type === "checkbox"
        ? [
            { value: "true", label: words.yes },
            { value: "false", label: words.no },
          ]
        : field.options.map((o) => ({ value: o, label: o }));
    return (
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{words.choose}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {value && !options.some((o) => o.value === value) && <option value={value}>{value}</option>}
      </select>
    );
  }
  return (
    <input
      className="field"
      type={
        field.type === "date"
          ? "date"
          : field.type === "email"
            ? "email"
            : field.type === "phone"
              ? "tel"
              : "text"
      }
      inputMode={field.type === "number" ? "decimal" : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** The client card: the sections the admin made, with their fields to fill in. Nothing shows while the admin has made none. */
export function Card({
  leadId,
  saved,
  onSaved,
}: {
  leadId: string;
  saved: Record<string, string>;
  onSaved: () => void;
}) {
  const { api, words, toast } = useApp();
  const [sections, setSections] = useState<CrmCardSection[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .card()
      .then((card) => live && setSections(card.filter((s) => s.fields.length > 0)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);

  if (sections.length === 0) return null;
  const save = async () => {
    const changes: Record<string, string> = {};
    for (const f of sections.flatMap((s) => s.fields)) {
      const now = draft[f.id] ?? "";
      if (now !== (saved[f.id] ?? "")) changes[f.id] = now;
    }
    setBusy(true);
    setError(null);
    try {
      await api.saveValues(leadId, changes);
      haptic("success");
      toast(words.cardSaved);
      onSaved();
    } catch (e) {
      haptic("error");
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", String(e));
      setError(errorText(words, err.code, err.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {sections.map((s) => (
        <section key={s.id} className="card stack">
          <strong>{s.name}</strong>
          {s.fields.map((f) => (
            <label key={f.id} className="stack tight">
              <span className="hint">{f.label}</span>
              <FieldInput
                field={f}
                value={draft[f.id] ?? ""}
                words={words}
                onChange={(value) => setDraft({ ...draft, [f.id]: value })}
              />
            </label>
          ))}
        </section>
      ))}
      {error && <p className="error">{error}</p>}
      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
        {words.saveCard}
      </button>
    </>
  );
}
