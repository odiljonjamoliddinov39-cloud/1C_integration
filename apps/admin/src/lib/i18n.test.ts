import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RU } from "./i18n-ru";
import { UZ } from "./i18n-uz";

const root = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/i18n/.test(name) ? [path] : [];
  });
}

/** Every text the screens pass to t("…"), found in the source. */
const used = new Set<string>();
for (const file of sources(root)) {
  const text = readFileSync(file, "utf8");
  // Prettier writes a text that holds double quotes with single quotes, so both are read.
  for (const match of text.matchAll(/\bt\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g))
    used.add(new Function(`return ${match[1] as string}`)() as string);
}

// Texts shown through a variable (t(status), t(role)): their values are listed here.
const DYNAMIC = [
  "free",
  "trial",
  "active",
  "grace",
  "suspended",
  "cancelled",
  "month",
  "year",
  "pending",
  "paid",
  "expired",
  "owner",
  "support",
  "member",
];
// Examples of the code or of the 1C language, shown as they are.
const AS_IS = new Set(["ДатаОстатка:date"]);

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("the dashboard's Uzbek and Russian texts", () => {
  const needed = [...new Set([...used, ...DYNAMIC])].filter((text) => !AS_IS.has(text));

  it("have every text the screens use", () => {
    expect(needed.filter((text) => !(text in UZ))).toEqual([]);
    expect(needed.filter((text) => !(text in RU))).toEqual([]);
  });

  it("have no text that no screen uses", () => {
    const wanted = new Set(needed);
    expect(Object.keys(UZ).filter((text) => !wanted.has(text))).toEqual([]);
    expect(Object.keys(RU).filter((text) => !wanted.has(text))).toEqual([]);
  });

  it("fill the same {values} as the English text", () => {
    for (const text of needed) {
      expect([text, placeholders(UZ[text] ?? "")]).toEqual([text, placeholders(text)]);
      expect([text, placeholders(RU[text] ?? "")]).toEqual([text, placeholders(text)]);
    }
  });
});
