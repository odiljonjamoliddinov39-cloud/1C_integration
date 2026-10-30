/**
 * The public offer ("Ommaviy oferta") in Uzbek and Russian. The Uzbek text is the owner's document; the Russian one is its
 * translation. When a text changes, change OFFER_VERSION in packages/shared/src/offer.ts: everyone is then asked again.
 */
import type { Locale } from "./i18n";

export interface OfferItem {
  text: string;
  /** Bullets under the paragraph. */
  list?: string[];
}
export interface OfferSection {
  title: string;
  items: OfferItem[];
}
export interface OfferDoc {
  title: string;
  subtitle: string;
  /** "30.10.2026" */
  dated: string;
  sections: OfferSection[];
  requisites: [label: string, value: string][];
  ui: {
    /** The window's heading. */
    modalTitle: string;
    modalIntro: string;
    agree: string;
    cancel: string;
    working: string;
    openPage: string;
    footerLink: string;
    /** Under the sign-up button: registering is accepting (the offer's clause 3.1). */
    signupNote: string;
    signupLink: string;
  };
}

const uz: OfferDoc = {
  title: "Ommaviy oferta",
  subtitle: "AI Buxgalter xizmatidan foydalanish shartlari",
  dated: "30.10.2026",
  sections: [
    {
      title: "1. Asosiy tushunchalar",
      items: [
        {
          text: "Foydalanuvchi — Xizmatdan foydalanish uchun ro'yxatdan o'tgan jismoniy yoki yuridik shaxs.",
        },
        {
          text: "Ijrochi — ushbu Oferta shartlarini e'lon qilgan va Xizmatni taqdim etuvchi shaxs (rekvizitlari 13-bandda).",
        },
        {
          text: "Oferta — ushbu hujjat, O'zbekiston Respublikasi Fuqarolik kodeksining ommaviy oferta haqidagi normalariga muvofiq tuzilgan.",
        },
        {
          text: "Aksept — Foydalanuvchining shaxsiy kabinetda ro'yxatdan o'tishi va/yoki Xizmatdan foydalanishni boshlashi, bu Oferta shartlarini to'liq va so'zsiz qabul qilish hisoblanadi.",
        },
        {
          text: "Xizmat — 1C:Buxgalteriya bazalari bilan integratsiyalashgan AI yordamchisi orqali buxgalteriya hisobini avtomatlashtirish bo'yicha dasturiy ta'minot va unga bog'liq xizmatlar.",
        },
        {
          text: "Shaxsiy kabinet — Foydalanuvchining tarifni boshqarish, to'lovlarni amalga oshirish va hisobotlarni ko'rish imkonini beruvchi veb-interfeys.",
        },
        { text: "Tarif rejasi — Xizmatning Free, Start, Business yoki Firm darajalaridan biri." },
      ],
    },
    {
      title: "2. Oferta predmeti",
      items: [
        {
          text: "2.1. Ijrochi Foydalanuvchiga 1C bazasiga ulangan AI buxgalter yordamchisidan foydalanish huquqini (oddiy, eksklyuziv bo'lmagan litsenziya asosida) tanlangan Tarif rejasiga muvofiq taqdim etadi.",
        },
        {
          text: "2.2. Xizmat tarkibiga quyidagilar kiradi: desktop ilova orqali 1C bazasi bilan ishlash, AI yordamchisiga savol-javob, hujjatlarni import qilish, audit hisobotlari, Excel'ga eksport va Telegram orqali masofaviy boshqaruv (tanlangan tarifga qarab).",
        },
        {
          text: "2.3. Amaldagi tariflar, ularning narxi va chegaralari Ijrochining rasmiy veb-saytidagi narxlar sahifasida joylashtiriladi va ushbu Ofertaning ajralmas qismi hisoblanadi.",
        },
        {
          text: '2.4. Xizmat "shundayligicha" (as is) taqdim etiladi; Ijrochi uning Foydalanuvchining barcha ehtiyojlariga mutlaqo mos kelishini kafolatlamaydi, lekin texnik jihatdan barqaror ishlashi uchun oqilona choralar ko\'radi.',
        },
      ],
    },
    {
      title: "3. Oferta aksepti",
      items: [
        {
          text: "3.1. Foydalanuvchi shaxsiy kabinetda ro'yxatdan o'tgan, Xizmatni yuklab olgan yoki undan foydalanishni boshlagan paytdan e'tiboran, ushbu Oferta Fuqarolik kodeksining 369–370-moddalariga muvofiq Foydalanuvchi va Ijrochi o'rtasida yozma shartnoma kuchiga ega bo'ladi.",
        },
        { text: "3.2. Aksept shartsiz va to'liq bo'lishi kerak; qisman aksept qabul qilinmaydi." },
        {
          text: "3.3. Ijrochi Ofertaga istalgan vaqtda o'zgartirish kiritish huquqiga ega; yangi tahrir veb-saytda joylashtirilgan paytdan kuchga kiradi. Foydalanuvchi Xizmatdan foydalanishda davom etishi yangi tahrirni qabul qilgani hisoblanadi.",
        },
      ],
    },
    {
      title: "4. Tariflar, narxlar va to'lov tartibi",
      items: [
        {
          text: "4.1. Xizmat quyidagi tarif rejalarida taqdim etiladi: Free, Start, Business, Firm — ularning narxi, kompaniyalar/foydalanuvchilar soni va oylik AI so'rovlar soni Ijrochining narxlar sahifasida ko'rsatiladi.",
        },
        {
          text: "4.2. Ijrochi hozirgi vaqtda Qo'shilgan qiymat solig'i (QQS) to'lovchisi emas; ko'rsatilgan narxlarga QQS kiritilmagan.",
        },
        {
          text: "4.3. To'lovlar Payme, Click tizimlari yoki bank o'tkazmasi orqali amalga oshiriladi. Yillik to'lovda 12 oylik xizmat 10 oylik narxda taqdim etiladi.",
        },
        {
          text: "4.4. Tarif oyma-oy yoki yillik asosda avtomatik yangilanadi, agar Foydalanuvchi bekor qilmasa. Yangi narx faqat Foydalanuvchining keyingi to'lov davridan boshlab qo'llaniladi; joriy to'langan davr eski narxda qoladi.",
        },
        {
          text: "4.5. To'lov amalga oshirilmagan taqdirda, Foydalanuvchiga 3 (uch) kunlik imtiyozli (grace) muddat beriladi, shundan so'ng akkaunt Free tarifiga o'tkaziladi; ma'lumotlar o'chirilmaydi.",
        },
        {
          text: "4.6. AI so'rovlari uchun belgilangan oylik pul va miqdor chegaralaridan oshib ketilganda, Xizmat keyingi davr boshlanguncha yoki Foydalanuvchi qo'shimcha paket sotib olguncha AI javoblarini cheklashi mumkin.",
        },
      ],
    },
    {
      title: "5. Bepul sinov muddati",
      items: [
        {
          text: "5.1. Yangi Foydalanuvchiga, agar u avval sinov muddatidan foydalanmagan bo'lsa, 3 (uch) kunlik bepul sinov muddati taqdim etiladi.",
        },
        { text: "5.2. Sinov muddati davomida AI so'rovlari soni jami 30 tagacha chegaralanadi." },
        {
          text: "5.3. Har bir akkaunt va har bir kompaniya (STIR) uchun sinov muddati faqat bir marta beriladi.",
        },
        {
          text: "5.4. Sinov muddati tugagach, Foydalanuvchi pullik tarifni tanlamasa, akkaunt avtomatik ravishda Free tarifiga o'tkaziladi; bu holatda ma'lumotlar yo'qolmaydi.",
        },
      ],
    },
    {
      title: "6. Tomonlarning huquq va majburiyatlari",
      items: [
        {
          text: "6.1. Ijrochi quyidagilarga majbur:",
          list: [
            "Xizmatning tanlangan tarifga muvofiq ishlashini ta'minlash;",
            "Texnik nosozliklar yuzaga kelganda, ularni oqilona muddatda bartaraf etish;",
            "Foydalanuvchining buxgalteriya ma'lumotlari maxfiyligini 7-bandga muvofiq ta'minlash.",
          ],
        },
        {
          text: "6.2. Foydalanuvchi quyidagilarga majbur:",
          list: [
            "Tanlangan tarif bo'yicha to'lovlarni o'z vaqtida amalga oshirish;",
            "Xizmatdan O'zbekiston Respublikasi qonunchiligiga zid bo'lmagan maqsadlarda foydalanish;",
            "Shaxsiy kabinet va 1C bazasiga kirish ma'lumotlarining maxfiyligini ta'minlash;",
            "Xizmatni uchinchi shaxslarga ruxsatsiz topshirmaslik yoki qayta sotmaslik.",
          ],
        },
        {
          text: "6.3. Ijrochi quyidagi huquqlarga ega:",
          list: [
            "Ofertani bir tomonlama o'zgartirish (3.3-bandga muvofiq);",
            "Oferta shartlari buzilgan taqdirda, Foydalanuvchiga Xizmat ko'rsatishni to'xtatish;",
            "Xizmatni texnik xizmat ko'rsatish uchun vaqtincha to'xtatish, imkon qadar Foydalanuvchini oldindan xabardor qilgan holda.",
          ],
        },
      ],
    },
    {
      title: "7. Maxfiylik va ma'lumotlarni himoya qilish",
      items: [
        {
          text: "7.1. Foydalanuvchining 1C bazasidagi buxgalteriya ma'lumotlari Foydalanuvchining shaxsiy kompyuteridan tashqariga chiqmaydi, bundan AI yordamchisiga yuborilgan so'rovlar mustasno — ular Ijrochining xavfsiz proksi-serveri orqali, faqat javob berish uchun zarur bo'lgan hajmda uzatiladi.",
        },
        {
          text: "7.2. Ijrochi parollar, tokenlar va boshqa maxfiy ma'lumotlarni oddiy matn fayllarda yoki jurnal (log) yozuvlarida saqlamaydi; ular faqat operatsion tizimning xavfsiz saqlash vositasi orqali himoyalangan holda saqlanadi.",
        },
        {
          text: "7.3. Ijrochi Foydalanuvchining shaxsiy ma'lumotlarini faqat Xizmat ko'rsatish maqsadida qayta ishlaydi va uni uchinchi shaxslarga, qonunchilikda nazarda tutilgan hollar bundan mustasno, oshkor etmaydi.",
        },
        {
          text: "7.4. Foydalanuvchi AI yordamchisiga yuborilgan so'rovlar sifat va narx siyosatini yaxshilash maqsadida anonim statistik tahlil qilinishi mumkinligiga rozilik bildiradi.",
        },
      ],
    },
    {
      title: "8. Intellektual mulk huquqlari",
      items: [
        {
          text: "8.1. Xizmatning dasturiy ta'minoti, uning kodi, dizayni, savdo belgisi va boshqa barcha intellektual mulk ob'ektlari Ijrochiga tegishli.",
        },
        {
          text: "8.2. Ushbu Oferta Foydalanuvchiga Xizmatdan faqat shaxsiy yoki o'z tadbirkorlik faoliyatida foydalanish uchun eksklyuziv bo'lmagan, boshqa shaxsga topshirib bo'lmaydigan litsenziya beradi.",
        },
        {
          text: "8.3. Foydalanuvchiga Xizmatni dekompilyatsiya qilish, nusxalash, qayta sotish yoki undan uchinchi shaxs mahsuloti yaratishda foydalanish taqiqlanadi.",
        },
      ],
    },
    {
      title: "9. Javobgarlikni cheklash",
      items: [
        {
          text: "9.1. Ijrochining Foydalanuvchi oldidagi har qanday da'vo bo'yicha umumiy javobgarligi Foydalanuvchi oxirgi 3 (uch) oyda to'lagan summadan oshmaydi.",
        },
        {
          text: "9.2. AI yordamchisi tomonidan taklif qilingan yozuvlar Foydalanuvchi tomonidan tasdiqlanmasdan 1C bazasiga avtomatik kiritilmaydi; shu sababli, tasdiqlangan har qanday yozuvning to'g'riligi uchun yakuniy javobgarlik Foydalanuvchining o'zida qoladi.",
        },
        {
          text: "9.3. Ijrochi bilvosita zararlar (yo'qotilgan foyda, ma'lumotlarning yo'qolishi va h.k.) uchun javobgar emas, bundan qasddan qilingan harakatlar yoki qo'pol beparvolik holatlari mustasno.",
        },
        {
          text: "9.4. Ijrochi Foydalanuvchining 1C bazasi, internet aloqasi yoki uchinchi tomon xizmatlari (Payme, Click, Didox va h.k.)dagi nosozliklar natijasida yuzaga kelgan uzilishlar uchun javobgar emas.",
        },
      ],
    },
    {
      title: "10. Fors-major holatlari",
      items: [
        {
          text: "10.1. Tomonlar o'z nazoratidan tashqari bo'lgan, oldindan bilib bo'lmaydigan va oldini olib bo'lmaydigan holatlar (tabiiy ofatlar, urush harakatlari, favqulodda holat, davlat organlarining qarorlari, internet yoki elektr energiyasi uzilishi, uchinchi tomon xizmatlari — hosting, to'lov tizimlari, 1C platformasi, aloqa operatorlari — ishdan chiqishi) sababli majburiyatlarini bajara olmasa, bu holatlar davom etgan muddatga javobgarlikdan ozod etiladi.",
        },
        {
          text: "10.2. Fors-major holati yuzaga kelgan Tomon ikkinchi Tomonni oqilona muddatda (imkon qadar 3 ish kuni ichida) xabardor qilishi shart.",
        },
        {
          text: "10.3. Fors-major holati 30 (o'ttiz) kundan ortiq davom etsa, har qanday Tomon Ofertani bir tomonlama bekor qilish huquqiga ega; bunda allaqachon to'langan, lekin ko'rsatilmagan xizmat uchun mutanosib ravishda pul qaytariladi.",
        },
      ],
    },
    {
      title: "11. Amal qilish muddati, to'xtatish va bekor qilish",
      items: [
        {
          text: "11.1. Oferta aksept qilingan paytdan e'tiboran kuchga kiradi va Tomonlar o'z majburiyatlarini to'liq bajargunga qadar amal qiladi.",
        },
        {
          text: "11.2. Foydalanuvchi istalgan vaqtda shaxsiy kabinet orqali obunani bekor qilishi mumkin; bekor qilish joriy to'langan davr oxirida kuchga kiradi, ortiqcha to'lov qaytarilmaydi, bundan 11.4-band mustasno.",
        },
        {
          text: "11.3. Ijrochi Oferta shartlari, jumladan to'lov tartibi jiddiy buzilgan taqdirda, Foydalanuvchiga oldindan xabar berib yoki bermay, Xizmat ko'rsatishni to'xtatish huquqiga ega.",
        },
        {
          text: "11.4. Agar Ijrochi texnik sabablarga ko'ra Xizmatni uzoq muddat (30 kundan ortiq) to'xtatsa va muqobil yechim taklif qilmasa, Foydalanuvchi foydalanilmagan davr uchun mutanosib pul qaytarilishini talab qilish huquqiga ega.",
        },
        {
          text: "11.5. Bekor qilingandan so'ng, Foydalanuvchining 1C bazasidagi ma'lumotlari o'zgarishsiz qoladi, chunki ular hech qachon Ijrochining serverlariga yuborilmagan (7-band).",
        },
      ],
    },
    {
      title: "12. Nizolarni hal qilish tartibi",
      items: [
        {
          text: "12.1. Ushbu Oferta O'zbekiston Respublikasi qonunchiligiga muvofiq tuziladi va talqin etiladi.",
        },
        {
          text: "12.2. Tomonlar o'rtasida kelib chiqadigan barcha nizo va kelishmovchiliklar, avvalo, muzokaralar yo'li bilan hal etiladi. Da'vo xati yuborilgan kundan boshlab 15 (o'n besh) kalendar kuni ichida javob berilmasa, nizo sud tartibida hal qilinadi.",
        },
        {
          text: "12.3. Sud nizolari Ijrochining ro'yxatdan o'tgan joyidagi (manzili) tegishli sudida ko'rib chiqiladi, agar qonunchilikda boshqacha tartib belgilanmagan bo'lsa.",
        },
      ],
    },
    {
      title: "13. Yakuniy qoidalar va Ijrochi rekvizitlari",
      items: [
        {
          text: "13.1. Ushbu Oferta matni Ijrochining rasmiy veb-saytida joylashtiriladi va istalgan vaqtda bepul tanishish uchun ochiq.",
        },
        {
          text: "13.2. Agar Ofertaning biror bandi amaldagi qonunchilikka zid deb topilsa, bu qolgan bandlarning yuridik kuchini yo'qotishiga olib kelmaydi.",
        },
        { text: "13.3. Ijrochi rekvizitlari:" },
      ],
    },
  ],
  requisites: [
    ["Ijrochi", "Жисмоний жахс (хизмат курсатувчи)"],
    ["F.I.O.", "Райимов Ихтийор Гапурович"],
    ["STIR", "33107965270016"],
    ["Manzil", "Тошкент шахар Сирали тумани"],
    ["Bank rekvizitlari", "5440 8103 1748 3799"],
    ["Telefon", "+998 91 014 00 24"],
    ["Veb-sayt", "aibuxgalter.com"],
  ],
  ui: {
    modalTitle: "Ommaviy oferta",
    modalIntro:
      "Tarifni sotib olishdan oldin ommaviy oferta shartlari bilan tanishing. «Roziman» tugmasini bossangiz, shartlarni toʻliq va soʻzsiz qabul qilgan boʻlasiz.",
    agree: "Roziman",
    cancel: "Bekor qilish",
    working: "Saqlanmoqda…",
    openPage: "Alohida sahifada ochish",
    footerLink: "Ommaviy oferta",
    signupNote: "Roʻyxatdan oʻtish orqali siz",
    signupLink: "ommaviy oferta shartlarini qabul qilasiz",
  },
};

const ru: OfferDoc = {
  title: "Публичная оферта",
  subtitle: "Условия использования сервиса «AI Бухгалтер»",
  dated: "30.10.2026",
  sections: [
    {
      title: "1. Основные понятия",
      items: [
        {
          text: "Пользователь — физическое или юридическое лицо, зарегистрировавшееся для использования Сервиса.",
        },
        {
          text: "Исполнитель — лицо, опубликовавшее условия настоящей Оферты и предоставляющее Сервис (реквизиты указаны в пункте 13).",
        },
        {
          text: "Оферта — настоящий документ, составленный в соответствии с нормами Гражданского кодекса Республики Узбекистан о публичной оферте.",
        },
        {
          text: "Акцепт — регистрация Пользователя в личном кабинете и/или начало использования Сервиса, что считается полным и безоговорочным принятием условий настоящей Оферты.",
        },
        {
          text: "Сервис — программное обеспечение и связанные с ним услуги по автоматизации бухгалтерского учёта с помощью AI-помощника, интегрированного с базами 1С:Бухгалтерия.",
        },
        {
          text: "Личный кабинет — веб-интерфейс, позволяющий Пользователю управлять тарифом, производить оплату и просматривать отчёты.",
        },
        { text: "Тарифный план — один из уровней Сервиса: Free, Start, Business или Firm." },
      ],
    },
    {
      title: "2. Предмет оферты",
      items: [
        {
          text: "2.1. Исполнитель предоставляет Пользователю право использования AI-помощника бухгалтера, подключённого к базе 1С (на основании простой, неисключительной лицензии), в соответствии с выбранным Тарифным планом.",
        },
        {
          text: "2.2. В состав Сервиса входят: работа с базой 1С через настольное приложение, вопросы и ответы с AI-помощником, импорт документов, аудиторские отчёты, экспорт в Excel и удалённое управление через Telegram (в зависимости от выбранного тарифа).",
        },
        {
          text: "2.3. Действующие тарифы, их стоимость и ограничения размещаются на странице цен официального веб-сайта Исполнителя и являются неотъемлемой частью настоящей Оферты.",
        },
        {
          text: "2.4. Сервис предоставляется «как есть» (as is); Исполнитель не гарантирует его полного соответствия всем потребностям Пользователя, но принимает разумные меры для обеспечения технически стабильной работы.",
        },
      ],
    },
    {
      title: "3. Акцепт оферты",
      items: [
        {
          text: "3.1. С момента, когда Пользователь зарегистрировался в личном кабинете, скачал Сервис или начал им пользоваться, настоящая Оферта в соответствии со статьями 369–370 Гражданского кодекса приобретает силу письменного договора между Пользователем и Исполнителем.",
        },
        { text: "3.2. Акцепт должен быть безусловным и полным; частичный акцепт не принимается." },
        {
          text: "3.3. Исполнитель вправе в любое время вносить изменения в Оферту; новая редакция вступает в силу с момента её размещения на веб-сайте. Продолжение использования Сервиса означает принятие новой редакции Пользователем.",
        },
      ],
    },
    {
      title: "4. Тарифы, цены и порядок оплаты",
      items: [
        {
          text: "4.1. Сервис предоставляется по следующим тарифным планам: Free, Start, Business, Firm — их стоимость, количество компаний/пользователей и количество AI-запросов в месяц указываются на странице цен Исполнителя.",
        },
        {
          text: "4.2. В настоящее время Исполнитель не является плательщиком налога на добавленную стоимость (НДС); в указанные цены НДС не включён.",
        },
        {
          text: "4.3. Оплата производится через системы Payme, Click или банковским переводом. При оплате за год 12 месяцев обслуживания предоставляются по цене 10 месяцев.",
        },
        {
          text: "4.4. Тариф автоматически продлевается помесячно или на год, если Пользователь не отменит его. Новая цена применяется только с начала следующего платёжного периода Пользователя; текущий оплаченный период остаётся по прежней цене.",
        },
        {
          text: "4.5. При неоплате Пользователю предоставляется льготный (grace) период 3 (три) дня, после чего аккаунт переводится на тариф Free; данные не удаляются.",
        },
        {
          text: "4.6. При превышении установленных ежемесячных денежных и количественных лимитов на AI-запросы Сервис вправе ограничить AI-ответы до начала следующего периода или до покупки Пользователем дополнительного пакета.",
        },
      ],
    },
    {
      title: "5. Бесплатный пробный период",
      items: [
        {
          text: "5.1. Новому Пользователю, если он ранее не использовал пробный период, предоставляется бесплатный пробный период на 3 (три) дня.",
        },
        { text: "5.2. В течение пробного периода общее количество AI-запросов ограничено 30." },
        {
          text: "5.3. Пробный период предоставляется только один раз для каждого аккаунта и каждой компании (ИНН).",
        },
        {
          text: "5.4. По окончании пробного периода, если Пользователь не выбрал платный тариф, аккаунт автоматически переводится на тариф Free; при этом данные не теряются.",
        },
      ],
    },
    {
      title: "6. Права и обязанности сторон",
      items: [
        {
          text: "6.1. Исполнитель обязан:",
          list: [
            "обеспечивать работу Сервиса в соответствии с выбранным тарифом;",
            "при возникновении технических неисправностей устранять их в разумный срок;",
            "обеспечивать конфиденциальность бухгалтерских данных Пользователя в соответствии с пунктом 7.",
          ],
        },
        {
          text: "6.2. Пользователь обязан:",
          list: [
            "своевременно производить оплату по выбранному тарифу;",
            "использовать Сервис в целях, не противоречащих законодательству Республики Узбекистан;",
            "обеспечивать конфиденциальность данных для входа в личный кабинет и в базу 1С;",
            "не передавать Сервис третьим лицам без разрешения и не перепродавать его.",
          ],
        },
        {
          text: "6.3. Исполнитель имеет право:",
          list: [
            "в одностороннем порядке изменять Оферту (в соответствии с пунктом 3.3);",
            "приостановить обслуживание Пользователя при нарушении условий Оферты;",
            "временно приостанавливать Сервис для технического обслуживания, по возможности заранее уведомив Пользователя.",
          ],
        },
      ],
    },
    {
      title: "7. Конфиденциальность и защита данных",
      items: [
        {
          text: "7.1. Бухгалтерские данные Пользователя в базе 1С не покидают персональный компьютер Пользователя, за исключением запросов, отправленных AI-помощнику, — они передаются через защищённый прокси-сервер Исполнителя и только в объёме, необходимом для ответа.",
        },
        {
          text: "7.2. Исполнитель не хранит пароли, токены и другие конфиденциальные данные в простых текстовых файлах или журналах (логах); они хранятся в защищённом виде только средствами безопасного хранилища операционной системы.",
        },
        {
          text: "7.3. Исполнитель обрабатывает персональные данные Пользователя только в целях предоставления Сервиса и не раскрывает их третьим лицам, за исключением случаев, предусмотренных законодательством.",
        },
        {
          text: "7.4. Пользователь соглашается с тем, что запросы, отправленные AI-помощнику, могут подвергаться анонимному статистическому анализу в целях улучшения качества и ценовой политики.",
        },
      ],
    },
    {
      title: "8. Права интеллектуальной собственности",
      items: [
        {
          text: "8.1. Программное обеспечение Сервиса, его код, дизайн, товарный знак и все прочие объекты интеллектуальной собственности принадлежат Исполнителю.",
        },
        {
          text: "8.2. Настоящая Оферта предоставляет Пользователю неисключительную, не подлежащую передаче другому лицу лицензию на использование Сервиса только в личных целях или в собственной предпринимательской деятельности.",
        },
        {
          text: "8.3. Пользователю запрещается декомпилировать, копировать, перепродавать Сервис или использовать его для создания продукта третьего лица.",
        },
      ],
    },
    {
      title: "9. Ограничение ответственности",
      items: [
        {
          text: "9.1. Общая ответственность Исполнителя перед Пользователем по любому требованию не превышает суммы, уплаченной Пользователем за последние 3 (три) месяца.",
        },
        {
          text: "9.2. Проводки, предложенные AI-помощником, не вносятся в базу 1С автоматически без подтверждения Пользователем; поэтому окончательная ответственность за правильность любой подтверждённой записи остаётся на самом Пользователе.",
        },
        {
          text: "9.3. Исполнитель не несёт ответственности за косвенные убытки (упущенную выгоду, потерю данных и т. п.), за исключением случаев умышленных действий или грубой неосторожности.",
        },
        {
          text: "9.4. Исполнитель не несёт ответственности за перебои, вызванные неисправностями базы 1С Пользователя, интернет-связи или сервисов третьих сторон (Payme, Click, Didox и т. д.).",
        },
      ],
    },
    {
      title: "10. Форс-мажорные обстоятельства",
      items: [
        {
          text: "10.1. Если стороны не могут исполнить свои обязательства из-за обстоятельств, находящихся вне их контроля, непредвиденных и непреодолимых (стихийные бедствия, военные действия, чрезвычайное положение, решения государственных органов, отключение интернета или электроэнергии, выход из строя сервисов третьих сторон — хостинга, платёжных систем, платформы 1С, операторов связи), они освобождаются от ответственности на срок действия этих обстоятельств.",
        },
        {
          text: "10.2. Сторона, для которой наступили форс-мажорные обстоятельства, обязана уведомить другую Сторону в разумный срок (по возможности в течение 3 рабочих дней).",
        },
        {
          text: "10.3. Если форс-мажорные обстоятельства длятся более 30 (тридцати) дней, любая Сторона вправе в одностороннем порядке расторгнуть Оферту; при этом за уже оплаченные, но не оказанные услуги деньги возвращаются пропорционально.",
        },
      ],
    },
    {
      title: "11. Срок действия, приостановка и расторжение",
      items: [
        {
          text: "11.1. Оферта вступает в силу с момента акцепта и действует до полного исполнения Сторонами своих обязательств.",
        },
        {
          text: "11.2. Пользователь может в любое время отменить подписку через личный кабинет; отмена вступает в силу в конце текущего оплаченного периода, излишне уплаченные суммы не возвращаются, за исключением случая, предусмотренного пунктом 11.4.",
        },
        {
          text: "11.3. Исполнитель вправе приостановить обслуживание Пользователя с предварительным уведомлением или без него в случае существенного нарушения условий Оферты, в том числе порядка оплаты.",
        },
        {
          text: "11.4. Если Исполнитель по техническим причинам приостановит Сервис на длительный срок (более 30 дней) и не предложит альтернативного решения, Пользователь вправе потребовать пропорционального возврата денег за неиспользованный период.",
        },
        {
          text: "11.5. После расторжения данные Пользователя в его базе 1С остаются без изменений, так как они никогда не отправлялись на серверы Исполнителя (пункт 7).",
        },
      ],
    },
    {
      title: "12. Порядок разрешения споров",
      items: [
        {
          text: "12.1. Настоящая Оферта заключается и толкуется в соответствии с законодательством Республики Узбекистан.",
        },
        {
          text: "12.2. Все споры и разногласия между Сторонами решаются, в первую очередь, путём переговоров. Если ответ на претензию не дан в течение 15 (пятнадцати) календарных дней со дня её отправки, спор разрешается в судебном порядке.",
        },
        {
          text: "12.3. Судебные споры рассматриваются в соответствующем суде по месту регистрации (адресу) Исполнителя, если законодательством не установлен иной порядок.",
        },
      ],
    },
    {
      title: "13. Заключительные положения и реквизиты Исполнителя",
      items: [
        {
          text: "13.1. Текст настоящей Оферты размещается на официальном веб-сайте Исполнителя и открыт для бесплатного ознакомления в любое время.",
        },
        {
          text: "13.2. Если какой-либо пункт Оферты будет признан противоречащим действующему законодательству, это не лишает юридической силы остальные пункты.",
        },
        { text: "13.3. Реквизиты Исполнителя:" },
      ],
    },
  ],
  requisites: [
    ["Исполнитель", "Жисмоний жахс (хизмат курсатувчи)"],
    ["Ф.И.О.", "Райимов Ихтийор Гапурович"],
    ["ИНН (СТИР)", "33107965270016"],
    ["Адрес", "Тошкент шахар Сирали тумани"],
    ["Банковские реквизиты", "5440 8103 1748 3799"],
    ["Телефон", "+998 91 014 00 24"],
    ["Веб-сайт", "aibuxgalter.com"],
  ],
  ui: {
    modalTitle: "Публичная оферта",
    modalIntro:
      "Перед покупкой тарифа ознакомьтесь с условиями публичной оферты. Нажимая «Согласен», вы полностью и безоговорочно принимаете эти условия.",
    agree: "Согласен",
    cancel: "Отмена",
    working: "Сохраняем…",
    openPage: "Открыть на отдельной странице",
    footerLink: "Публичная оферта",
    signupNote: "Регистрируясь, вы",
    signupLink: "принимаете условия публичной оферты",
  },
};

export const offerOf = (locale: Locale): OfferDoc => (locale === "ru" ? ru : uz);
