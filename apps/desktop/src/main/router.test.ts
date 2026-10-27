import { describe, expect, it } from "vitest";

import {
  langOf,
  optionsText,
  postOptions,
  readChoice,
  asksForDuplicates,
  readDuplicatesCommand,
  readPostingsFixCommand,
  readPostCommand,
  readUndoCommand,
} from "./router.js";

describe("a bare command to post", () => {
  it.each([
    "проведи",
    "Проведи их",
    "проведены?",
    "проведен",
    "проведи все пожалуйста",
    "провести",
    "proveden",
    "provodka",
    "o'tkaz",
    "oʻtkazing",
    "hammasini o'tkaz",
    "post",
    "post them",
    "please post all of them",
  ])("%s", (text) => expect(readPostCommand(text)).toBe(true));

  it.each([
    "проверь документы",
    "проведи документы за сентябрь",
    "проведи реализации",
    "проведи поступление от Navroz",
    "непроведенные документы",
    "o'tkazilmagan hujjatlar",
    "post the sales invoices of September",
    "почему не проведен документ 123",
    "",
    "привет",
  ])("%s is not one", (text) => expect(readPostCommand(text)).toBe(false));
});

describe("the options", () => {
  const rows: [string, number][] = [
    ["Реализация товаров и услуг", 3],
    ["Поступление товаров и услуг", 12],
    ["Счёт-фактура выданный", 0],
  ];
  const options = postOptions(rows, "2026-09-01", "2026-10-21");

  it("offers everything, then each kind with something unposted, biggest first", () => {
    expect(options.map((o) => [o.label, o.count, o.objects.length])).toEqual([
      ["*", 15, 2],
      ["Поступление товаров и услуг", 12, 1],
      ["Реализация товаров и услуг", 3, 1],
    ]);
    expect(options[1]?.objects).toEqual(["Документ.ПоступлениеТоваровУслуг"]);
    expect(postOptions([["Реализация товаров и услуг", 0]], "a", "b")).toEqual([]);
  });

  it("reads the answer: a number, 'all', a word of the kind; one past the last is 'another'", () => {
    expect(readChoice("2", options)).toBe(2);
    expect(readChoice("1", options)).toBe(1);
    expect(readChoice("4", options)).toBe(4);
    expect(readChoice("5", options)).toBeNull();
    expect(readChoice("все", options)).toBe(1);
    expect(readChoice("да", options)).toBe(1);
    expect(readChoice("hammasi", options)).toBe(1);
    expect(readChoice("только реализации", options)).toBe(3);
    expect(readChoice("поступления", options)).toBe(2);
    expect(readChoice("а какой сегодня курс доллара", options)).toBeNull();
  });

  it("is said in the language of the question", () => {
    expect(langOf("проведи")).toBe("ru");
    expect(langOf("o'tkaz")).toBe("uz");
    expect(langOf("post them")).toBe("en");
    expect(optionsText("ru", options)).toContain("1. Все непроведённые (15)");
    expect(optionsText("ru", options)).toContain("4. Другой период");
    expect(optionsText("uz", options)).toContain("2. Faqat «Поступление товаров и услуг» (12)");
    expect(optionsText("en", options)).toContain("Answer with a number");
  });
});

describe("the command to take back what the program entered from a statement", () => {
  it.each([
    "отмени",
    "Отмени ввод выписки",
    "отмени последнее",
    "bekor qil",
    "bekor qiling hammasini",
    "undo",
    "undo it",
    "cancel the last entry",
    "qaytar",
    "откат",
  ])("%s", (text) => expect(readUndoCommand(text)).toBe(true));
  it.each([
    "отмени оплату поставщику 5 от 01.02.2024 на 12 млн",
    "проведи",
    "введи выписку",
    "bekor qilingan hujjatlar bo'yicha hisobot ber 2024 yil uchun",
    "hello",
    "",
  ])("%s is not one", (text) => expect(readUndoCommand(text)).toBe(false));
});

describe("the duplicates command", () => {
  it.each([
    "икки марта киритган хужжатларингни учир",
    "takror kiritilgan hujjatlarni o'chir",
    "дубли удали",
    "найди дубликаты",
    "find the duplicates",
    "documents entered twice, remove them",
    "takrorlar",
  ])("%s", (text) => expect(readDuplicatesCommand(text)).toBe(true));
  it.each([
    "введи выписку",
    "проведи",
    "отмени",
    "hello",
    "",
    "takror hisobot tayyorlab ber 2024 yil uchun barcha kontragentlar bo'yicha batafsil, va uni Excel ga yoz, shuningdek jadvalni sana bo'yicha saralab chiqar va yuborib qo'y",
  ])("%s is not one", (text) => expect(readDuplicatesCommand(text)).toBe(false));
});

describe("the postings command", () => {
  it.each([
    "fix the transfer postings",
    "o'tkazma provodkalarini tuzat",
    "исправь проводки переводов",
    "ўтказма проводкаларини тузат",
    // the texts of the button
    "Исправь проводки банковских документов: счёт банка и переводы между счетами",
    "Bank hujjatlarining provodkalarini tuzat: bank schyoti va hisoblar orasidagi o'tkazmalar",
    "Fix the postings of the bank documents: the bank account and the transfers between accounts",
  ])("%s", (text) => expect(readPostingsFixCommand(text)).toBe(true));
  it.each(["проведи", "введи выписку", "provodka qil", "отмени", ""])("%s is not one", (text) =>
    expect(readPostingsFixCommand(text)).toBe(false),
  );
});

describe("a long request that also asks for the duplicates", () => {
  it.each([
    "мана санга банк выпискалари шуларни тугирлаб киритиб бер 1с да буса киритма агар 1 с да булмаса кирит агар 1 с да икки марта киритилган булса уни учириб таша",
    "Enter the statements, skip what 1C already has, and delete the documents entered twice",
    "введи выписки и удали дубли",
  ])("%s", (text) => {
    expect(asksForDuplicates(text)).toBe(true);
    // The short command is not this: it has its own route, with a limit on length.
    expect(asksForDuplicates("hello world")).toBe(false);
  });
  it("a statement entry that does not speak of duplicates is not one", () => {
    expect(asksForDuplicates("введи выписку за 2026 год")).toBe(false);
    expect(asksForDuplicates("банк выпискасини киритиб бер")).toBe(false);
  });
});
