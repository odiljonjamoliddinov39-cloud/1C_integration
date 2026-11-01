import type { CardFieldType, CrmCardField } from "@platform/shared";

import { Input, Select } from "@/components/ui";
import { t } from "@/lib/i18n";

/** The words for the field types (the admin picks one when making a field). */
export const FIELD_TYPES: { value: CardFieldType; label: string }[] = [
  { value: "text", label: t("Text") },
  { value: "textarea", label: t("Long text") },
  { value: "number", label: t("Number") },
  { value: "date", label: t("Date") },
  { value: "phone", label: t("Phone") },
  { value: "email", label: t("E-mail") },
  { value: "select", label: t("Choice from a list") },
  { value: "checkbox", label: t("Yes / No") },
];

export const fieldTypeLabel = (type: CardFieldType) =>
  FIELD_TYPES.find((f) => f.value === type)?.label ?? type;

/** One field of the client card, as an input of its type. The value is always a string ("true" / "false" for a yes/no). */
export function CardFieldInput({
  field,
  value,
  onChange,
}: {
  field: CrmCardField;
  value: string;
  onChange: (value: string) => void;
}) {
  switch (field.type) {
    case "textarea":
      return (
        <textarea
          className="min-h-20 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "select":
      return (
        <Select className="w-full" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          {value && !field.options.includes(value) && <option value={value}>{value}</option>}
        </Select>
      );
    case "checkbox":
      return (
        <Select className="w-full" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          <option value="true">{t("Yes")}</option>
          <option value="false">{t("No")}</option>
        </Select>
      );
    default:
      return (
        <Input
          className="w-full"
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
}
