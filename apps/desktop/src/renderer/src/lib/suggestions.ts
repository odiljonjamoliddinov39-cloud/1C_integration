/**
 * Temporary buttons over the message box: what the accountant is likely to want next, read from what is attached, what is
 * typed and what the assistant just said. They are not part of the chat: each goes away when used, when the context that
 * made it changes, or when the user starts typing a message of their own.
 */
import type { AttachmentKind } from "../../../shared/ipc";

export type SuggestLang = "ru" | "uz" | "en";

export interface Suggestion {
  id: string;
  /** The button's text. */
  label: string;
  /** What is sent when it is pressed. */
  send: string;
}

export interface SuggestContext {
  lang: SuggestLang;
  /** The files attached to the next message. */
  files: { name: string; kind: AttachmentKind }[];
  /** What is typed in the box. */
  typed: string;
  /** The assistant's last answer, when it is the last thing in the chat and nothing is running. */
  lastAnswer: string | null;
  busy: boolean;
}

type Words = Record<SuggestLang, { label: string; send: string }>;
const word = (ru: [string, string], uz: [string, string], en: [string, string]): Words => ({
  ru: { label: ru[0], send: ru[1] },
  uz: { label: uz[0], send: uz[1] },
  en: { label: en[0], send: en[1] },
});

const CHIPS = {
  enterStatement: word(
    ["Ввести выписку в 1С", "Введи банковские выписки в 1С"],
    ["Ko'chirmani 1C ga kiritish", "Bank ko'chirmalarini 1C ga kiritib ber"],
    ["Enter the statement into 1C", "Enter the bank statements into 1C"],
  ),
  readStatement: word(
    ["Только прочитать, ничего не писать", "Прочитай выписки и скажи, что в них; в 1С ничего не записывай"],
    ["Faqat o'qi, yozma", "Ko'chirmalarni o'qib, ichida nima borligini ayt; 1C ga hech narsa yozma"],
    ["Only read, write nothing", "Read the statements and tell me what is in them; write nothing to 1C"],
  ),
  analyseSheet: word(
    ["Разобрать таблицу", "Разбери прикреплённую таблицу: что в ней и как это связано с учётом"],
    [
      "Jadvalni tahlil qilish",
      "Ilova qilingan jadvalni tahlil qil: ichida nima va hisobga qanday aloqasi bor",
    ],
    ["Analyse the table", "Analyse the attached table: what is in it and how it relates to the books"],
  ),
  enterRows: word(
    ["Ввести строки в 1С", "Введи строки из таблицы в 1С как документы"],
    ["Qatorlarni 1C ga kiritish", "Jadvaldagi qatorlarni 1C ga hujjat qilib kirit"],
    ["Enter the rows into 1C", "Enter the rows of the table into 1C as documents"],
  ),
  readDocument: word(
    ["Прочитать и кратко изложить", "Прочитай документ и изложи кратко, что в нём важно для учёта"],
    ["O'qib, qisqa aytib berish", "Hujjatni o'qib, hisob uchun nima muhimligini qisqa ayt"],
    ["Read and summarise", "Read the document and summarise what matters for the books"],
  ),
  enterDocument: word(
    ["Оформить в 1С", "Оформи этот документ в 1С (проверь контрагента и договор)"],
    ["1C da rasmiylashtirish", "Bu hujjatni 1C da rasmiylashtir (kontragent va shartnomani tekshir)"],
    ["Enter it into 1C", "Enter this document into 1C (check the counterparty and the contract)"],
  ),
  readImage: word(
    ["Прочитать изображение", "Прочитай документ на изображении и покажи, что в нём"],
    ["Tasvirni o'qish", "Tasvirdagi hujjatni o'qib, ichida nima borligini ko'rsat"],
    ["Read the image", "Read the document in the image and show what is in it"],
  ),
  didox: word(
    ["Ввести счета-фактуры из архива", "Введи документы из архива в 1С"],
    ["Arxivdagi hujjatlarni kiritish", "Arxivdagi hujjatlarni 1C ga kirit"],
    ["Enter the documents of the archive", "Enter the documents of the archive into 1C"],
  ),
  post: word(
    ["Провести введённое", "Проведи"],
    ["Kiritilganlarni provodka qilish", "Проведи"],
    ["Post what was entered", "Post them"],
  ),
  undo: word(
    ["Отменить введённое", "Отмени введённое"],
    ["Kiritilganni bekor qilish", "Отмени введённое"],
    ["Take back what was entered", "Take back what was entered"],
  ),
  rest: word(
    ["Что осталось?", "Что осталось не введено и почему? Коротко, списком"],
    ["Nima qoldi?", "Nima kiritilmay qoldi va nega? Qisqa, ro'yxat bilan"],
    ["What is left?", "What was not entered and why? Short, as a list"],
  ),
  tryAgain: word(
    ["Запустить ещё раз", "Попробуй ещё раз"],
    ["Yana urinib ko'rish", "Yana bir bor urinib ko'r"],
    ["Try again", "Try again"],
  ),
  balances: word(
    ["Проверить остатки", "Проверь остатки по счетам: есть ли замечания"],
    ["Qoldiqlarni tekshirish", "Hisoblar qoldiqlarini tekshir: e'tirozlar bormi"],
    ["Check the balances", "Check the account balances: is there anything to flag"],
  ),
  vat: word(
    ["Расчёт НДС", "Сколько НДС к уплате за этот месяц?"],
    ["QQS hisobi", "Shu oy uchun qancha QQS to'lanadi?"],
    ["VAT for the month", "How much VAT is payable for this month?"],
  ),
  debts: word(
    ["Кому мы должны больше всего", "Каким поставщикам мы должны больше всего?"],
    ["Eng ko'p qarzdor bo'lgan ta'minotchilar", "Qaysi ta'minotchilarga eng ko'p qarzdormiz?"],
    ["Who we owe the most", "Which suppliers do we owe the most?"],
  ),
  receivables: word(
    ["Кто должен нам", "Какие покупатели нам должны и насколько давно?"],
    ["Bizga kim qarzdor", "Qaysi xaridorlar bizga qarzdor va qancha vaqtdan beri?"],
    ["Who owes us", "Which buyers owe us and for how long?"],
  ),
} as const;

const STATEMENT_NAME = /сч[её]т|выписк|vypiska|ko'?chirma|statement|bank|\d{20}/iu;
const XML_OR_ARCHIVE = /\.zip$/iu;

/** The buttons for this moment, the most likely first (at most four). */
export function suggest(ctx: SuggestContext): Suggestion[] {
  if (ctx.busy) return [];
  const make = (id: string, key: keyof typeof CHIPS): Suggestion => ({
    id,
    label: CHIPS[key][ctx.lang].label,
    send: CHIPS[key][ctx.lang].send,
  });
  const out: Suggestion[] = [];
  const add = (key: keyof typeof CHIPS) => {
    if (!out.some((s) => s.id === key)) out.push(make(key, key));
  };

  // 1. What is attached says what the question is about.
  if (ctx.files.length > 0) {
    const sheets = ctx.files.filter((f) => f.kind === "spreadsheet");
    const statements = sheets.filter((f) => STATEMENT_NAME.test(f.name));
    if (statements.length > 0) {
      add("enterStatement");
      add("readStatement");
    } else if (sheets.length > 0) {
      add("analyseSheet");
      add("enterRows");
    }
    if (ctx.files.some((f) => f.kind === "pdf" || f.kind === "document")) {
      add("readDocument");
      add("enterDocument");
    }
    if (ctx.files.some((f) => f.kind === "image")) {
      add("readImage");
      add("enterDocument");
    }
    if (ctx.files.some((f) => XML_OR_ARCHIVE.test(f.name))) add("didox");
    return out.slice(0, 4);
  }

  // The user is writing their own message: nothing is put in the way.
  if (ctx.typed.trim() !== "") return [];

  // 2. What the assistant just said says what comes next.
  const said = (ctx.lastAnswer ?? "").toLowerCase();
  if (said) {
    const entered =
      /введено документов|kiritilgan hujjatlar|documents entered|записано в 1с|1c ga yozildi|written to 1c|ҳужжат киритилган|киритилган ҳужжатлар/u.test(
        said,
      );
    const unposted =
      /не проведен|ещё не проведен|не проведены|ўтказилмаган|provodka qilinmagan|o'tkazilmagan|not posted|«проведи»|"проведи"|post them/u.test(
        said,
      );
    const left =
      /не разобрано|не введен|осталось|dastur hal qila olmagan|kiritilmagan|kiritilmadi|not entered|could not settle|ҳал қила олмаган|киритилмаган/u.test(
        said,
      );
    const failed = /не удалось|1c qabul qilmadi|1с не приняла|did not accept|error|ошибк|xato/u.test(said);
    if (entered || unposted) add("post");
    if (left) add("rest");
    if (failed) add("tryAgain");
    if (entered) add("undo");
    if (out.length > 0) return out.slice(0, 4);
    // A plain answer: the questions that usually follow, other than the one just answered.
    const topics: [keyof typeof CHIPS, RegExp][] = [
      ["balances", /остат|qoldiq|balance|қолдиқ/u],
      ["vat", /ндс|qqs|vat|ққс/u],
      ["debts", /поставщик|ta'minotchi|supplier|etkazib/u],
      ["receivables", /покупател|xaridor|buyer|customer/u],
    ];
    for (const [key, words] of topics) if (!words.test(said)) add(key);
    return out.slice(0, 3);
  }

  return [];
}
