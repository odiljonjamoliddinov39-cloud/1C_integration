import { useState } from "react";

import { useApp } from "../context.js";
import { ApiError } from "../lib/api.js";
import { errorText } from "../lib/i18n.js";
import { haptic } from "../lib/telegram.js";

const BLANK = { name: "", phone: "", source: "", company: "", note: "" };

/** A new lead, in a short form. A phone that is already a lead updates that lead instead. */
export function NewLead({ onBack, onOpen }: { onBack: () => void; onOpen: (id: string) => void }) {
  const { api, words, toast } = useApp();
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof typeof BLANK) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm({ ...form, [key]: e.target.value }),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.addLead({
        name: form.name.trim(),
        phone: form.phone.trim(),
        source: form.source.trim() || undefined,
        company: form.company.trim() || undefined,
        note: form.note.trim() || undefined,
      });
      haptic("success");
      toast(saved.created ? words.saved : words.updated);
      onOpen(saved.lead.id);
    } catch (err) {
      haptic("error");
      const apiError = err instanceof ApiError ? err : new ApiError("UNKNOWN", String(err));
      setError(errorText(words, apiError.code, apiError.message));
      setBusy(false);
    }
  };

  return (
    <>
      <header className="bar">
        <button type="button" className="link" onClick={onBack}>
          ‹ {words.back}
        </button>
        <h1>{words.newLead}</h1>
        <span />
      </header>
      <form className="pad stack" onSubmit={(e) => void submit(e)}>
        <input className="field" placeholder={words.name} required autoComplete="off" {...field("name")} />
        <input
          className="field"
          placeholder={words.phone}
          required
          type="tel"
          inputMode="tel"
          autoComplete="off"
          {...field("phone")}
        />
        <input className="field" placeholder={words.source} {...field("source")} />
        <input className="field" placeholder={words.company} {...field("company")} />
        <textarea className="field" rows={3} placeholder={words.note} {...field("note")} />
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn" disabled={busy}>
          {words.save}
        </button>
      </form>
    </>
  );
}
