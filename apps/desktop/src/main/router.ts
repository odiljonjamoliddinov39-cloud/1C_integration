/**
 * The task of a short message, found by the program before the model is asked. A bare "проведи" / "proveden" / "post
 * them" names a task but not its object: sent to the model as it is, it goes looking through the whole of 1C and Didox
 * for what might need posting. The program knows more than the model does at that moment: what this chat just made, and
 * (by one cheap read) what is unposted. So it either does the obvious thing at once, or offers the few things the
 * message can mean, numbered, and takes the answer "2" / "all" / "реализации" for the choice.
 */
import { DOC_KINDS } from "@platform/shared";

export type Lang = "ru" | "uz" | "en";

/** The language a message is written in: Cyrillic is Russian, English words English, else Uzbek (Latin). */
export function langOf(text: string): Lang {
  if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
  if (/\b(the|them|please|post|all|these|it|now|yes)\b/i.test(text) && !/[ʻʼ'‘’]|o'|g'/i.test(text))
    return "en";
  return "uz";
}

const tokens = (text: string) =>
  text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‘’`ʻʼ]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);

/** Verbs and nouns for posting, by their beginning: "проведи", "проведены", "проводки", "post", "o'tkaz", "provodka". */
const POST_WORD = /^(провед|провест|провод|post|o'?tkaz|otkaz|proved|provod)/u;
/** What may stand beside the verb without naming an object: "их", "все", "please", "ularni", "hammasini". */
const COMMAND_FILLER = new Set(
  [
    ...[
      "их",
      "его",
      "ее",
      "все",
      "всё",
      "эти",
      "они",
      "это",
      "то",
      "же",
      "ну",
      "ладно",
      "давай",
      "теперь",
      "сейчас",
      "пожалуйста",
      "быстро",
    ],
    ...[
      "мне",
      "нам",
      "тоже",
      "и",
      "ок",
      "ok",
      "okay",
      "да",
      "yes",
      "now",
      "them",
      "of",
      "the",
      "it",
      "all",
      "these",
      "those",
      "please",
      "asap",
      "just",
    ],
    ...[
      "ularni",
      "uni",
      "shularni",
      "hammasini",
      "hammasi",
      "barchasini",
      "endi",
      "iltimos",
      "qil",
      "qilib",
      "qiling",
      "ber",
      "bering",
      "ha",
      "mayli",
      "tez",
    ],
  ].map((w) => w.toLowerCase()),
);

/** A message that is only the command to post: no object, no period, no kind of document named. */
export function readPostCommand(text: string): boolean {
  const words = tokens(text);
  if (words.length === 0 || words.length > 6) return false;
  if (!words.some((w) => POST_WORD.test(w))) return false;
  return words.every((w) => POST_WORD.test(w) || COMMAND_FILLER.has(w));
}

/** Verbs for taking back, by their beginning: "отмени", "откат", "bekor", "qaytar", "undo", "cancel", "revert". */
const UNDO_WORD = /^(отмен|откат|отзов|верни|bekor|qaytar|undo|revert|rollback|cancel)/u;
/** What may stand beside the verb: the thing taken back ("ввод выписки", "последнее", "hujjatlar"), without naming a period. */
const UNDO_OBJECT =
  /^(ввод|выписк|ввели|введен|введённ|последн|банков|документ|проводк|vypiska|vypiskani|kiritilgan|kiritish|oxirgi|hujjat|bank|last|entry|entries|statement|it|them|this|все|всё|все|их|это|hammasini|ularni|buni|qil|qiling|ber|пожалуйста|iltimos|please|the|of|ha|да|yes|ok)/u;

/** A message that is only the command to take back what the program entered from a statement. */
/** "икки марта киритган ҳужжатларингни ўчир", "takror hujjatlarni o'chir", "find the duplicates": the duplicates of the bank documents. */
const DUPLICATE_WORD =
  /(такрор|takror|дубл|dubl|икки\s*марта|ikki\s*marta|дважды|два\s*раза|twice|duplicate|double)/u;
const DUPLICATE_VERB =
  /(ўчир|учир|o'chir|ochir|удал|убер|delete|remove|топ\b|топиб|topib|найд|find|текшир|tekshir|провер|check|тозала|tozala|олиб\s*таш|olib\s*tash)/u;

/**
 * A long request that asks for the duplicates as one of its parts ("enter the statements … and delete what is in 1C twice"):
 * no limit on the length, the words alone. The statement is entered first and the duplicates are looked for after it.
 */
export function asksForDuplicates(text: string): boolean {
  const t = text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‘’`ʻʼ]/g, "'");
  return DUPLICATE_WORD.test(t) && DUPLICATE_VERB.test(t);
}

/** "ko'chirmani 1C bilan solishtir", "сверь выписку с 1С", "compare the statement with 1C": the statements against the bank documents of 1C. */
const COMPARE_VERB =
  /(солиштир|solishtir|сверь|сверк|сравни|сопостав|compare|reconcile|match\b|mos\s*kel|мос\s*кел)/u;
const COMPARE_OBJECT = /(выписк|ko'chirma|кўчирма|кучирма|statement|1\s*[cс]\b|1с|банк|bank)/u;

export function readCompareCommand(text: string): boolean {
  const t = text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‘’`ʻʼ]/g, "'");
  if (t.trim().length > 200) return false;
  // "акт сверки" is the reconciliation act with a counterparty, not this.
  if (/(^|\s)(акт|akt|act)(\s|$)/u.test(t)) return false;
  return COMPARE_VERB.test(t) && COMPARE_OBJECT.test(t);
}

export function readDuplicatesCommand(text: string): boolean {
  const t = text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‘’`ʻʼ]/g, "'");
  if (t.trim().length > 300) return false;
  return DUPLICATE_WORD.test(t) && (DUPLICATE_VERB.test(t) || t.trim().length <= 60);
}

/** "o'tkazma provodkalarini tuzat", "исправь проводки", "fix the transfer postings": the bank documents booked to the wrong account. */
const POSTING_WORD = /(проводк|провод\b|provodka|provodkal|postings?|booking|entries)/u;
const POSTING_VERB = /(тузат|tuzat|исправ|поправ|fix|correct|to'g'rila|тўғрила|тугрила|ўзгартир|o'zgartir)/u;

export function readPostingsFixCommand(text: string): boolean {
  const t = text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‘’`ʻʼ]/g, "'");
  return t.trim().length <= 300 && POSTING_WORD.test(t) && POSTING_VERB.test(t);
}

export function readUndoCommand(text: string): boolean {
  const words = tokens(text);
  if (words.length === 0 || words.length > 7) return false;
  if (!words.some((w) => UNDO_WORD.test(w))) return false;
  return words.every((w) => UNDO_WORD.test(w) || UNDO_OBJECT.test(w) || COMMAND_FILLER.has(w));
}

export interface PostOption {
  label: string;
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  /** Full names of the document kinds ("Документ.РеализацияТоваровУслуг"). */
  objects: string[];
  /** How many 1C said are unposted, for the label. */
  count: number;
}

export interface PendingChoice {
  intent: "post";
  options: PostOption[];
  at: string;
}

const YES = new Set([
  "да",
  "yes",
  "ok",
  "ок",
  "okay",
  "ha",
  "hammasi",
  "hammasini",
  "все",
  "всё",
  "all",
  "mayli",
  "давай",
]);

/** Which option a short answer picks: its number, "all"/"да" for the first, or a word of the option's kind. */
export function readChoice(text: string, options: PostOption[]): number | null {
  const words = tokens(text);
  if (words.length === 0 || words.length > 6) return null;
  const number = /^(\d{1,2})$/.exec(words[0] ?? "")?.[1];
  if (number) {
    const n = Number(number);
    // One past the last option is "another period or kind": the answer is a question, not a choice.
    return n >= 1 && n <= options.length + 1 ? n : null;
  }
  if (words.every((w) => YES.has(w) || COMMAND_FILLER.has(w))) return 1;
  const hit = options.findIndex((o, i) => {
    if (i === 0) return false;
    const label = tokens(o.label);
    return words.some(
      (w) => w.length >= 4 && label.some((l) => l.startsWith(w.slice(0, 5)) || w.startsWith(l.slice(0, 5))),
    );
  });
  return hit >= 0 ? hit + 1 : null;
}

const kindTitle = (object: string) => DOC_KINDS.find(([, o]) => `Документ.${o}` === object)?.[0] ?? object;

/** The options for "post them" from the counts of unposted documents by kind (rows: kind title, count). */
export function postOptions(rows: [string, number][], from: string, to: string): PostOption[] {
  const kinds = rows
    .filter(([, n]) => n > 0)
    .flatMap(([title, count]) => {
      const kind = DOC_KINDS.find(([t]) => t === title);
      return kind ? [{ title, object: `Документ.${kind[1]}`, count }] : [];
    })
    .sort((a, b) => b.count - a.count);
  if (kinds.length === 0) return [];
  const total = kinds.reduce((n, k) => n + k.count, 0);
  const all: PostOption = {
    label: kinds.length === 1 ? (kinds[0]?.title ?? "") : "*",
    from,
    to,
    objects: kinds.map((k) => k.object),
    count: total,
  };
  const each =
    kinds.length > 1
      ? kinds.slice(0, 4).map((k) => ({ label: k.title, from, to, objects: [k.object], count: k.count }))
      : [];
  return [all, ...each];
}

const SAY = {
  ru: {
    askWhich: "Напишите, какой период или какие документы провести.",
    title: (n: number) => `Проведение документов: ${n}`,
    done: (n: number, failed: number) =>
      `Готово: проведено ${n}${failed > 0 ? `, не удалось ${failed}` : ""}.`,
    nothingMade: "Этот чат ничего не создавал. Какие документы провести?",
    intro: (from: string, to: string) =>
      `Не проведены документы за ${from} – ${to}. Что провести? Ответьте номером:`,
    all: (n: number) => `Все непроведённые (${n})`,
    each: (label: string, n: number) => `Только «${label}» (${n})`,
    other: "Другой период или вид документов — напишите, какой",
    none: (from: string, to: string) =>
      `Непроведённых документов за ${from} – ${to} нет. Напишите, за какой период или какие документы провести.`,
    cannot: "Не удалось прочитать список из 1С. Напишите, какие документы и за какой период провести.",
    pending: (n: number) => `Нашёл ${n} документов — готовлю карточку.`,
    more: (n: number) => `Ещё ${n} не вошли в эту карточку: скажите «проведи» ещё раз.`,
    entryNone: "не провёл ни одной проводки",
    entryPosted: "провёл",
    entriesRight: (n: number, total: number) =>
      `Проводки проверены: у ${n} из ${total} документов банка проводка такая, какая нужна по смыслу операции.`,
    entriesWrong: (operation: string, kase: string, n: number, problem: string) =>
      `Операция «${operation || "?"}» (${kase}): ${n} док. провелись неверно — ${problem}. Программа больше не будет использовать эту операцию для этого случая; напишите «исправь проводки».`,
  },
  uz: {
    askWhich: "Qaysi davr yoki qaysi hujjatlarni o'tkazish kerakligini yozing.",
    title: (n: number) => `Hujjatlarni o'tkazish: ${n}`,
    done: (n: number, failed: number) =>
      `Tayyor: ${n} ta hujjat o'tkazildi${failed > 0 ? `, ${failed} tasi o'tmadi` : ""}.`,
    nothingMade: "Bu chatda hech narsa yaratilmagan. Qaysi hujjatlarni o'tkazay?",
    intro: (from: string, to: string) =>
      `${from} – ${to} oralig'ida o'tkazilmagan hujjatlar bor. Nimani o'tkazay? Raqam bilan javob bering:`,
    all: (n: number) => `Hammasi, o'tkazilmaganlar (${n})`,
    each: (label: string, n: number) => `Faqat «${label}» (${n})`,
    other: "Boshqa davr yoki hujjat turi — qaysi ekanini yozing",
    none: (from: string, to: string) =>
      `${from} – ${to} oralig'ida o'tkazilmagan hujjat yo'q. Qaysi davr yoki qaysi hujjatlarni o'tkazish kerakligini yozing.`,
    cannot: "1C dan ro'yxatni o'qib bo'lmadi. Qaysi hujjatlar va qaysi davr ekanini yozing.",
    pending: (n: number) => `${n} ta hujjat topildi — kartochkani tayyorlayapman.`,
    more: (n: number) => `Yana ${n} ta hujjat bu kartochkaga sig'madi: yana bir marta «o'tkaz» deng.`,
    entryNone: "hech qanday provodka qilmadi",
    entryPosted: "provodka:",
    entriesRight: (n: number, total: number) =>
      `Provodkalar tekshirildi: bank hujjatlarining ${n} tasi (${total} tadan) operatsiya ma'nosiga mos provodka qildi.`,
    entriesWrong: (operation: string, kase: string, n: number, problem: string) =>
      `«${operation || "?"}» operatsiyasi (${kase}): ${n} ta hujjat noto'g'ri o'tdi — ${problem}. Dastur bu operatsiyani endi shu holat uchun ishlatmaydi; «provodkalarni tuzat» deb yozing.`,
  },
  en: {
    askWhich: "Tell me which period or which documents to post.",
    title: (n: number) => `Posting: ${n}`,
    done: (n: number, failed: number) => `Done: ${n} posted${failed > 0 ? `, ${failed} failed` : ""}.`,
    nothingMade: "This chat has not created anything. Which documents should I post?",
    intro: (from: string, to: string) =>
      `There are unposted documents for ${from} – ${to}. What should I post? Answer with a number:`,
    all: (n: number) => `All the unposted ones (${n})`,
    each: (label: string, n: number) => `Only “${label}” (${n})`,
    other: "Another period or kind of document — tell me which",
    none: (from: string, to: string) =>
      `Nothing is unposted for ${from} – ${to}. Tell me which period or documents to post.`,
    cannot: "I could not read the list from 1C. Tell me which documents and which period to post.",
    pending: (n: number) => `Found ${n} documents — preparing the card.`,
    more: (n: number) => `${n} more did not fit this card: say “post” again.`,
    entryNone: "it posted no entry",
    entryPosted: "it posted",
    entriesRight: (n: number, total: number) =>
      `Entries checked: ${n} of ${total} bank documents made the entry their case needs.`,
    entriesWrong: (operation: string, kase: string, n: number, problem: string) =>
      `Operation «${operation || "?"}» (${kase}): ${n} document(s) went wrong — ${problem}. The program will not use this operation for this case again; say “fix the postings”.`,
  },
} as const;

export const say = (lang: Lang) => SAY[lang];

/** The numbered message offered for "post them": what 1C has unposted, and a way out. */
export function optionsText(lang: Lang, options: PostOption[]): string {
  const t = SAY[lang];
  const first = options[0];
  if (!first) return "";
  const lines = options.map((o, i) =>
    i === 0 && o.label === "*"
      ? `${i + 1}. ${t.all(o.count)}`
      : i === 0
        ? `${i + 1}. ${t.each(o.label, o.count)}`
        : `${i + 1}. ${t.each(o.label, o.count)}`,
  );
  return [t.intro(first.from, first.to), ...lines, `${options.length + 1}. ${t.other}`].join("\n");
}

export { kindTitle };
