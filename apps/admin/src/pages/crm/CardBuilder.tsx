import type { CardFieldType, CrmCardField, CrmCardSection } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge, Button, ErrorText, Input, Section, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { FIELD_TYPES, fieldTypeLabel } from "./CardFields";

type Sections = CrmCardSection[];

/** Moves the item at `index` one step; the new order of the ids. */
const moved = (ids: string[], index: number, direction: -1 | 1) => {
  const next = [...ids];
  const [item] = next.splice(index, 1);
  next.splice(index + direction, 0, item as string);
  return next;
};

function FieldRow({
  field,
  index,
  siblings,
  sections,
  onChange,
}: {
  field: CrmCardField;
  index: number;
  siblings: CrmCardField[];
  sections: Sections;
  onChange: (data: Sections) => void;
}) {
  const [label, setLabel] = useState(field.label);
  const [options, setOptions] = useState(field.options.join(", "));
  const update = useMutation({
    mutationFn: (input: Parameters<typeof api.crmUpdateField>[1]) => api.crmUpdateField(field.id, input),
    onSuccess: onChange,
  });
  const reorder = useMutation({
    mutationFn: (direction: -1 | 1) =>
      api.crmReorderFields(
        field.sectionId,
        moved(
          siblings.map((f) => f.id),
          index,
          direction,
        ),
      ),
    onSuccess: onChange,
  });
  const remove = useMutation({ mutationFn: () => api.crmDeleteField(field.id), onSuccess: onChange });
  const parsed = () =>
    options
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  return (
    <li className="space-y-2 rounded-xl border border-border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-40 flex-1"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label.trim() && label !== field.label && update.mutate({ label })}
        />
        <Badge tone="info">{fieldTypeLabel(field.type)}</Badge>
        <Select
          aria-label={t("Section")}
          value={field.sectionId}
          onChange={(e) => update.mutate({ sectionId: e.target.value })}
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
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
          disabled={index === siblings.length - 1 || reorder.isPending}
          onClick={() => reorder.mutate(1)}
          aria-label={t("Move down")}
        >
          ↓
        </Button>
        <Button
          variant="danger"
          disabled={remove.isPending}
          onClick={() => {
            if (
              window.confirm(
                t("Delete the field “{label}”? What the managers wrote in it is deleted too.", {
                  label: field.label,
                }),
              )
            )
              remove.mutate();
          }}
        >
          {t("Delete")}
        </Button>
      </div>
      {field.type === "select" && (
        <Input
          className="w-full"
          placeholder={t("Choices, separated by commas")}
          value={options}
          onChange={(e) => setOptions(e.target.value)}
          onBlur={() =>
            parsed().length &&
            parsed().join(", ") !== field.options.join(", ") &&
            update.mutate({ options: parsed() })
          }
        />
      )}
      <ErrorText error={update.error ?? reorder.error ?? remove.error} />
    </li>
  );
}

function AddField({ section, onChange }: { section: CrmCardSection; onChange: (data: Sections) => void }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CardFieldType>("text");
  const [options, setOptions] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api.crmAddField({
        sectionId: section.id,
        label,
        type,
        options:
          type === "select"
            ? options
                .split(",")
                .map((o) => o.trim())
                .filter(Boolean)
            : undefined,
      }),
    onSuccess: (data) => {
      setLabel("");
      setOptions("");
      onChange(data);
    },
  });
  return (
    <form
      className="mt-2 flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (label.trim()) add.mutate();
      }}
    >
      <Input
        className="min-w-40 flex-1"
        placeholder={t("New field name")}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <Select value={type} onChange={(e) => setType(e.target.value as CardFieldType)}>
        {FIELD_TYPES.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </Select>
      {type === "select" && (
        <Input
          className="min-w-48 flex-1"
          placeholder={t("Choices, separated by commas")}
          value={options}
          onChange={(e) => setOptions(e.target.value)}
        />
      )}
      <Button disabled={add.isPending || !label.trim()}>{t("Add a field")}</Button>
      <div className="w-full">
        <ErrorText error={add.error} />
      </div>
    </form>
  );
}

function SectionBlock({
  section,
  index,
  all,
  onChange,
}: {
  section: CrmCardSection;
  index: number;
  all: Sections;
  onChange: (data: Sections) => void;
}) {
  const [name, setName] = useState(section.name);
  const rename = useMutation({
    mutationFn: () => api.crmRenameSection(section.id, name),
    onSuccess: onChange,
  });
  const reorder = useMutation({
    mutationFn: (direction: -1 | 1) =>
      api.crmReorderSections(
        moved(
          all.map((s) => s.id),
          index,
          direction,
        ),
      ),
    onSuccess: onChange,
  });
  const remove = useMutation({ mutationFn: () => api.crmDeleteSection(section.id), onSuccess: onChange });
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          className="min-w-40 flex-1 font-semibold"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== section.name && rename.mutate()}
        />
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
          disabled={remove.isPending}
          onClick={() => {
            if (
              window.confirm(
                t(
                  "Delete the section “{name}” with its {n} fields? What the managers wrote in them is deleted too.",
                  { name: section.name, n: section.fields.length },
                ),
              )
            )
              remove.mutate();
          }}
        >
          {t("Delete")}
        </Button>
      </div>
      <ErrorText error={rename.error ?? reorder.error ?? remove.error} />
      <ul className="space-y-2">
        {section.fields.map((f, i) => (
          <FieldRow
            key={`${f.id}-${f.label}-${f.options.join("|")}`}
            field={f}
            index={i}
            siblings={section.fields}
            sections={all}
            onChange={onChange}
          />
        ))}
      </ul>
      <AddField section={section} onChange={onChange} />
    </div>
  );
}

/** The client card's layout (owner and support): sections, and the fields in them. The managers fill the values in on each lead. */
export function CardBuilder() {
  const queryClient = useQueryClient();
  const card = useQuery({ queryKey: ["crm-card"], queryFn: api.crmCard });
  const set = (data: Sections) => queryClient.setQueryData(["crm-card"], data);
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.crmAddSection(name),
    onSuccess: (data) => {
      set(data);
      setName("");
    },
  });
  const sections = card.data ?? [];
  return (
    <Section title={t("Client card")}>
      <p className="mb-3 text-sm text-muted-foreground">
        {t(
          "Every client card has the name, phone, company and source. Make sections and the fields in them here (a text, a number, a date, a choice from a list…): the managers fill them in on each client.",
        )}
      </p>
      <ErrorText error={card.error} />
      <div className="space-y-3">
        {sections.map((s, i) => (
          <SectionBlock key={`${s.id}-${s.name}`} section={s} index={i} all={sections} onChange={set} />
        ))}
      </div>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <Input
          className="min-w-0 flex-1"
          placeholder={t("New section name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button disabled={add.isPending || !name.trim()}>{t("Add a section")}</Button>
      </form>
      <div className="mt-2">
        <ErrorText error={add.error} />
      </div>
    </Section>
  );
}
