/**
 * The customs regime of a declaration, decided before any amount is read. Graph 1 («IM 74») and graph 37 («74 00») say what
 * the declaration is, and that decides everything after it:
 *
 *   IM 74  customs warehouse: a processing fee only; duty, excise and VAT are deferred. Nothing but the fee is ever posted.
 *   IM 40  release for consumption: duty, excise, fee and import VAT. With graph 40 pointing at an earlier IM 74 declaration it
 *          is the release of goods from that warehouse, and the moment duty and VAT are posted.
 *   other  re-export, temporary import, processing, …: not handled; the flow stops and the accountant is asked.
 *
 * The code 74 means «customs warehouse» to the best of the spec's knowledge; the accountant confirms it against the official
 * classifier (see docs/gtd.md), which is why the code table is one list that can be corrected in one place.
 */

export type RegimeKind =
  "customs_warehouse" | "release_for_consumption" | "release_from_warehouse" | "unsupported";

export interface Regime {
  type: string;
  code: string;
  kind: RegimeKind;
  /** For an unsupported regime: what it is as far as the program knows, and why it stops. */
  reason?: string;
}

/** Codes of the procedure the program handles. */
export const SUPPORTED_CODES: Record<
  string,
  Exclude<RegimeKind, "release_from_warehouse" | "unsupported">
> = {
  "74": "customs_warehouse",
  "40": "release_for_consumption",
};

/** What other codes are, to tell the accountant why the program stops (not an exhaustive list of the classifier). */
const KNOWN_OTHER: Record<string, string> = {
  "10": "export",
  "11": "re-export",
  "31": "re-export",
  "51": "temporary import",
  "53": "temporary import",
  "61": "re-import",
  "71": "transit",
  "76": "free warehouse",
  "21": "processing within the customs territory",
  "41": "processing outside the customs territory",
};

const CYRILLIC_LATIN: Record<string, string> = {
  И: "I",
  М: "M",
  Э: "E",
  К: "K",
  Х: "X",
  Т: "T",
  Е: "E",
  Н: "N",
};

/** «IM 74», «ИМ-74», «IM74» → type and code; null when graph 1 is not of that form. */
export function parseRegimeText(text: string | null | undefined): { type: string; code: string } | null {
  if (!text) return null;
  const latin = text
    .toUpperCase()
    .replace(/[ИМЭКХТЕН]/g, (c) => CYRILLIC_LATIN[c] ?? c)
    .replace(/\s+/g, " ");
  const m = /\b(IM|EX|EK|TR|RE)\s*[-–]?\s*(\d{2})\b/.exec(latin);
  if (!m?.[1] || !m[2]) return null;
  return { type: m[1] === "EK" ? "EX" : m[1], code: m[2] };
}

/** The first two digits of a graph 37 procedure: «74 00», «7400», «74 00 000». */
export function procedureCode(text: string | null | undefined): string | null {
  const digits = (text ?? "").replace(/\D/g, "");
  return digits.length >= 2 ? digits.slice(0, 2) : null;
}

/** A declaration number as graph 40 writes it: «27001 / 02.11.2025 / 0160321» → «27001/02.11.2025/0160321». */
export function declarationKey(text: string | null | undefined): string | null {
  const m = /(\d{5})\s*\/\s*(\d{2}\.\d{2}\.\d{4})\s*\/\s*(\d{7})/.exec(text ?? "");
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

export interface RegimeInput {
  /** Graph 1 as written. */
  text: string | null | undefined;
  /** Graph 37 of each item. */
  procedures: (string | null | undefined)[];
  /** Graph 40. */
  preceding: string | null | undefined;
  /** IM 74 declarations already read for this company, by number: a release links to one of them. */
  warehouse: (declarationNo: string) => boolean;
}

/** Decides the regime from graph 1, then graph 37 when graph 1 is unreadable; the stop rule for anything else. */
export function detectRegime(input: RegimeInput): Regime {
  const graph1 = parseRegimeText(input.text);
  const codes = [...new Set(input.procedures.map(procedureCode).filter((c): c is string => c !== null))];
  const type = graph1?.type ?? "IM";
  const code = graph1?.code ?? (codes.length === 1 ? (codes[0] ?? "") : "");
  if (!code)
    return {
      type: graph1?.type ?? "",
      code: "",
      kind: "unsupported",
      reason: "graph 1 and graph 37 do not show which regime this is",
    };
  if (type !== "IM")
    return {
      type,
      code,
      kind: "unsupported",
      reason: `a declaration of type ${type} (not an import) is not handled`,
    };
  const supported = SUPPORTED_CODES[code];
  if (!supported) {
    const what = KNOWN_OTHER[code];
    return {
      type,
      code,
      kind: "unsupported",
      reason: `regime ${type} ${code}${what ? ` (${what})` : ""} is not handled`,
    };
  }
  if (supported === "release_for_consumption") {
    const key = declarationKey(input.preceding);
    if (key && input.warehouse(key)) return { type, code, kind: "release_from_warehouse" };
  }
  return { type, code, kind: supported };
}
