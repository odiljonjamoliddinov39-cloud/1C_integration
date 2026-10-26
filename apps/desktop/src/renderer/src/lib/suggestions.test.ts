import { describe, expect, it } from "vitest";

import { type SuggestContext, suggest } from "./suggestions.js";

const base: SuggestContext = { lang: "uz", files: [], typed: "", lastAnswer: null, busy: false };
const ids = (ctx: Partial<SuggestContext>) => suggest({ ...base, ...ctx }).map((s) => s.id);

describe("temporary buttons", () => {
  it("a bank statement offers to enter it, or only to read it", () => {
    expect(ids({ files: [{ name: "№ счёта 20208000705733821001.xlsx", kind: "spreadsheet" }] })).toEqual([
      "enterStatement",
      "readStatement",
    ]);
  });

  it("another table, a document, an image and an archive each get their own", () => {
    expect(ids({ files: [{ name: "prays.xlsx", kind: "spreadsheet" }] })).toEqual([
      "analyseSheet",
      "enterRows",
    ]);
    expect(ids({ files: [{ name: "shartnoma.pdf", kind: "pdf" }] })).toEqual([
      "readDocument",
      "enterDocument",
    ]);
    expect(ids({ files: [{ name: "x.png", kind: "image" }] })).toEqual(["readImage", "enterDocument"]);
    expect(ids({ files: [{ name: "didox.zip", kind: "archive" }] })).toEqual(["didox"]);
  });

  it("after documents were entered: post, take back; after what is left: ask what is left", () => {
    const answer = "Kiritilgan hujjatlar: 681. Dastur hal qila olmagan: 3. Ўтказиш учун «проведи» деб ёзинг.";
    expect(ids({ lastAnswer: answer })).toEqual(["post", "rest", "undo"]);
    expect(ids({ lastAnswer: "1C qabul qilmadi: 31" })).toEqual(["tryAgain"]);
  });

  it("says nothing while the assistant works or the user types their own message; follows a plain answer with other questions", () => {
    expect(ids({ busy: true, files: [{ name: "a.pdf", kind: "pdf" }] })).toEqual([]);
    expect(ids({ typed: "ндс", lastAnswer: "Kiritilgan hujjatlar: 1" })).toEqual([]);
    expect(ids({ lastAnswer: "Qoldiq 5110 hisobda 1 000 000 so'm." })).toEqual([
      "vat",
      "debts",
      "receivables",
    ]);
  });

  it("speaks the language of the screen", () => {
    const ru = suggest({ ...base, lang: "ru", files: [{ name: "выписка.xlsx", kind: "spreadsheet" }] });
    expect(ru[0]?.label).toBe("Ввести выписку в 1С");
    expect(ru[0]?.send).toContain("Введи банковские выписки");
  });
});
