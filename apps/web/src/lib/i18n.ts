/**
 * Texts of the website in Uzbek (Latin, the default, at /) and Russian (at /ru/). TD §9:
 * English comes later.
 */
export const LOCALES = ["uz", "ru"] as const;
export type Locale = (typeof LOCALES)[number];

export function localeOf(param: string | undefined): Locale {
  return param === "ru" ? "ru" : "uz";
}

/** Paths for Astro's getStaticPaths: "/" for Uzbek, "/ru/" for Russian. */
export function localePaths() {
  return [{ params: { locale: undefined } }, { params: { locale: "ru" } }];
}

/** A site path in the given language, e.g. href("ru", "/pricing") === "/ru/pricing". */
export function href(locale: Locale, path: string): string {
  const clean = path === "/" ? "" : path;
  return locale === "uz" ? clean || "/" : `/ru${clean}`;
}

const uz = {
  meta: {
    title: "1C Platform — 1C ga qoʻlda kiritishsiz buxgalteriya",
    description:
      "Hujjatlar 1C ga tekshirilgan holda tushadi, AI yordamchi esa hisob boʻyicha savollarga javob beradi. Oʻzbekiston buxgalterlari uchun.",
  },
  nav: {
    features: "Imkoniyatlar",
    pricing: "Narxlar",
    security: "Xavfsizlik",
    faq: "Savollar",
    download: "Yuklab olish",
    login: "Kirish",
    signup: "Bepul sinash",
    cabinet: "Kabinet",
  },
  home: {
    badge: "Oʻzbekiston uchun · 1C:Buxgalteriya 3.0",
    title: "1C ga qoʻlda kiritishni unuting",
    subtitle:
      "Hisob-fakturalar, bank koʻchirmalari va soliq hujjatlari 1C ga tekshirilgan holda tushadi. AI yordamchi esa hisob boʻyicha savollarga bir necha soniyada javob beradi.",
    cta: "14 kun bepul sinab koʻring",
    ctaSecondary: "Qanday ishlaydi",
    problemTitle: "Buxgalter vaqti nimaga ketadi",
    problems: [
      "Didox va Faktura.uz dagi hisob-fakturalarni 1C ga qayta terish",
      "Bank koʻchirmalarini qoʻlda tarqatish va xatolarni qidirish",
      "Rahbar «5110 da qancha qoldi?» deb soʻraganda hisobot tuzish",
    ],
    howTitle: "Qanday ishlaydi",
    steps: [
      {
        title: "Ilovani oʻrnating",
        text: "1C turgan kompyuterga Windows ilovasini oʻrnating va akkauntingiz bilan kiring.",
      },
      {
        title: "Kompaniyani ulang",
        text: "1C bazasini tanlang. Ilova 1C bilan COM orqali ishlaydi: bazani nashr qilish yoki 1C ni ochiq qoldirish shart emas.",
      },
      {
        title: "Ishlang",
        text: "Hujjatlar 1C ga oʻtkazilmagan holda yoziladi — siz tekshirib oʻtkazasiz. Savollarni yordamchiga bering.",
      },
    ],
    featuresTitle: "Imkoniyatlar",
    soon: "Tez orada",
    features: [
      {
        title: "1C bilan toʻgʻridan-toʻgʻri ishlash",
        text: "Bir nechta kompaniya va bazalar, har biri alohida ulanishda. 1C paroli Windows himoyasida saqlanadi.",
        soon: false,
      },
      {
        title: "AI yordamchi",
        text: "«Qaysi yetkazib beruvchilardan qarzimiz koʻp?» — yordamchi 1C dan oʻqib, raqamlar bilan javob beradi. Faqat oʻqiydi.",
        soon: false,
      },
      {
        title: "Elektron hisob-fakturalar",
        text: "Didox va Faktura.uz dagi kiruvchi hisob-fakturalar kontragent va tovar tekshiruvi bilan 1C ga tushadi.",
        soon: true,
      },
      {
        title: "Bank koʻchirmalari",
        text: "Koʻchirma qatorlari qoidalar boʻyicha schyotlarga tarqatiladi, takrorlar oʻtkazib yuboriladi.",
        soon: true,
      },
      {
        title: "Yozishdan oldin tekshiruv",
        text: "Arifmetika, QQS stavkalari, yopiq davr va takroriy import 1C ga yozilishidan oldin tekshiriladi.",
        soon: false,
      },
      {
        title: "Hisob auditi",
        text: "Saldo va hujjatlardagi gʻalati holatlar roʻyxati — 1C dagi hujjatga havola bilan.",
        soon: true,
      },
    ],
    securityTitle: "Buxgalteriya maʼlumotlari sizning kompyuteringizda qoladi",
    securityText:
      "Ilova 1C bilan sizning kompyuteringizda ishlaydi. Bizning serverimiz faqat akkaunt va litsenziyani biladi. AI yordamchi har bir kompaniya uchun alohida, roziligingiz bilan yoqiladi.",
    securityLink: "Batafsil",
    finalTitle: "Bugun boshlang",
    finalText: "14 kun bepul, karta talab qilinmaydi.",
  },
  pricing: {
    title: "Narxlar",
    subtitle: "Barcha imkoniyatlar bilan bepul boshlang. Pullik tariflar tez orada eʼlon qilinadi.",
    trial: {
      name: "Sinov",
      price: "0 soʻm",
      period: "14 kun",
      items: [
        "1 foydalanuvchi, 2 ta kompyuter",
        "5 tagacha kompaniya",
        "AI yordamchi (1 mln token)",
        "Barcha mavjud imkoniyatlar",
      ],
      cta: "Bepul boshlash",
    },
    plans: [
      { name: "Buxgalter", for: "Bitta yoki bir nechta kompaniyani yurituvchi mutaxassis uchun" },
      { name: "Firma", for: "Koʻp mijozli buxgalteriya firmalari uchun, bir nechta foydalanuvchi" },
    ],
    soon: "Narx tez orada",
    note: "Toʻlov Payme orqali. Sinov tugaganda maʼlumotlaringiz 1C da qoladi, ilova faqat oʻqish rejimiga oʻtadi.",
  },
  security: {
    title: "Xavfsizlik",
    subtitle: "Qaysi maʼlumot qayerda turadi va nimani hech qachon qilmaymiz.",
    tableWhat: "Maʼlumot",
    tableWhere: "Qayerda",
    rows: [
      ["Buxgalteriya: hujjatlar, saldolar, kontragentlar", "Sizning 1C bazangiz va kompyuteringiz"],
      ["1C paroli", "Kompyuteringizda, Windows himoyasida (DPAPI)"],
      ["Akkaunt, tarif, litsenziya", "Bizning server"],
      ["AI ga savollar va u oʻqigan qatorlar", "Faqat yoqilgan boʻlsa: serverimiz orqali Claude (Anthropic)"],
    ],
    principlesTitle: "Qoidalarimiz",
    principles: [
      {
        title: "Oʻtkazilmagan hujjatlar",
        text: "Ilova 1C ga hujjatlarni oʻtkazmasdan yozadi. Oʻtkazishni har doim siz qilasiz.",
      },
      {
        title: "Takrorlarsiz",
        text: "Har bir import manba identifikatori bilan belgilanadi: bir hujjat ikki marta yozilmaydi.",
      },
      {
        title: "Jurnal",
        text: "Ilova 1C ga yozgan har bir narsa 1C ning oʻzidagi jurnalda koʻrinadi.",
      },
      {
        title: "AI faqat oʻqiydi",
        text: "Yordamchi 1C da hech narsa yarata, oʻzgartira yoki oʻchira olmaydi. Har bir kompaniya uchun alohida yoqiladi.",
      },
    ],
  },
  faq: {
    title: "Koʻp soʻraladigan savollar",
    items: [
      {
        q: "Qaysi 1C konfiguratsiyalari bilan ishlaydi?",
        a: "1C:Buxgalteriya Oʻzbekiston uchun 3.0 (1C:Korxona 8.3, 64-bit). Bazaga kichik PlatformAPI kengaytmasi oʻrnatiladi.",
      },
      {
        q: "Bazani internetga nashr qilish kerakmi?",
        a: "Yoʻq. Ilova 1C bilan oʻsha kompyuterda COM orqali ishlaydi. Fayl baza ham, 1C server ham mos keladi.",
      },
      {
        q: "Internet uzilsa nima boʻladi?",
        a: "Ilova 7 kungacha internetsiz ishlaydi. Keyin litsenziyani tekshirish uchun ulanish kerak.",
      },
      {
        q: "AI yordamchi maʼlumotlarimni qayerga yuboradi?",
        a: "Faqat siz yoqqan kompaniya uchun: savol va javob uchun kerakli qatorlar serverimiz orqali Claude (Anthropic) ga yuboriladi. Ular modellarni oʻqitishda ishlatilmaydi.",
      },
      {
        q: "Nechta kompyuterga oʻrnatsa boʻladi?",
        a: "Sinov tarifida bitta foydalanuvchi 2 ta kompyuterda. Eskisini kabinetda oʻchirib, yangisiga oʻtishingiz mumkin.",
      },
      {
        q: "Windows «kompyuteringiz himoyalangan» deb ogohlantiradi — bu normalmi?",
        a: "Ha, hozircha oʻrnatuvchi raqamli imzosiz. «Batafsil» → «Baribir ishga tushirish» ni bosing.",
      },
    ],
  },
  download: {
    title: "Yuklab olish",
    subtitle: "Windows ilovasi 1C turgan kompyuterga oʻrnatiladi.",
    button: "Windows uchun yuklab olish",
    file: "1C-Platform-Setup.exe · 64-bit",
    requirementsTitle: "Talablar",
    requirements: [
      "Windows 10 yoki 11, 64-bit",
      "1C:Korxona 8.3 (64-bit), COM-konnektor roʻyxatdan oʻtgan",
      "1C:Buxgalteriya Oʻzbekiston uchun 3.0 + PlatformAPI kengaytmasi",
      "AI yordamchi va litsenziya uchun internet",
    ],
    stepsTitle: "Oʻrnatish",
    steps: [
      "Oʻrnatuvchini ishga tushiring. Windows ogohlantirsa: «Batafsil» → «Baribir ishga tushirish».",
      "Ilovada saytdagi akkauntingiz bilan kiring — kompyuter avtomatik faollashadi.",
      "«Kompaniyani ulash» orqali 1C bazangizni tanlang.",
    ],
    noAccount: "Akkauntingiz yoʻqmi?",
  },
  auth: {
    signupTitle: "Bepul sinovni boshlash",
    signupSubtitle: "14 kun, barcha imkoniyatlar bilan. Ilovaga xuddi shu akkaunt bilan kirasiz.",
    loginTitle: "Kabinetga kirish",
    loginSubtitle: "Tarif, kompyuterlar va yuklab olish.",
    name: "Ismingiz",
    accountName: "Firma yoki kompaniya nomi",
    email: "Elektron pochta",
    password: "Parol",
    passwordHint: "Kamida 10 ta belgi",
    submitSignup: "Akkaunt yaratish",
    submitLogin: "Kirish",
    haveAccount: "Akkauntingiz bormi? Kirish",
    noAccount: "Akkauntingiz yoʻqmi? Roʻyxatdan oʻtish",
    working: "Kuting…",
    errors: {
      EMAIL_TAKEN: "Bu pochta bilan akkaunt allaqachon bor.",
      INVALID_CREDENTIALS: "Pochta yoki parol notoʻgʻri.",
      VALIDATION: "Maydonlarni tekshiring.",
      RATE_LIMITED: "Juda koʻp urinish, bir daqiqa kuting.",
      REGISTRATION_CLOSED: "Roʻyxatdan oʻtish vaqtincha yopiq.",
      OFFLINE: "Serverga ulanib boʻlmadi.",
      default: "Kutilmagan xato. Keyinroq urinib koʻring.",
    },
  },
  cabinet: {
    title: "Kabinet",
    loading: "Yuklanmoqda…",
    account: "Akkaunt",
    plan: "Tarif",
    planNames: { trial: "Sinov" } as Record<string, string>,
    status: {
      trial: "Sinov davri",
      active: "Faol",
      grace: "Toʻlov muddati oʻtgan",
      suspended: "Toʻxtatilgan",
      cancelled: "Bekor qilingan",
    } as Record<string, string>,
    until: "{date} gacha",
    trialNote: "Pullik tariflar va Payme orqali toʻlov tez orada.",
    devices: "Kompyuterlar",
    noDevices: "Hali birorta kompyuter faollashtirilmagan. Ilovani yuklab oling va shu akkaunt bilan kiring.",
    activated: "Faollashtirilgan",
    lastSeen: "Oxirgi tekshiruv",
    revoke: "Oʻchirish",
    revoked: "Oʻchirilgan",
    confirmRevoke: "{name} kompyuterini oʻchirasizmi? U ilovaga qayta kira olmaydi.",
    download: "Ilovani yuklab olish",
    logout: "Chiqish",
  },
  footer: {
    tagline: "Oʻzbekiston buxgalterlari uchun 1C avtomatlashtirish",
    prototype: "Prototip",
  },
};

type Dict = typeof uz;

const ru: Dict = {
  meta: {
    title: "1C Platform — бухгалтерия без ручного ввода в 1С",
    description:
      "Документы попадают в 1С уже проверенными, а ИИ-ассистент отвечает на вопросы по учёту. Для бухгалтеров Узбекистана.",
  },
  nav: {
    features: "Возможности",
    pricing: "Цены",
    security: "Безопасность",
    faq: "Вопросы",
    download: "Скачать",
    login: "Войти",
    signup: "Попробовать бесплатно",
    cabinet: "Кабинет",
  },
  home: {
    badge: "Для Узбекистана · 1С:Бухгалтерия 3.0",
    title: "Забудьте о ручном вводе в 1С",
    subtitle:
      "Счета-фактуры, банковские выписки и налоговые документы попадают в 1С уже проверенными. А ИИ-ассистент за секунды отвечает на вопросы по учёту.",
    cta: "Попробовать 14 дней бесплатно",
    ctaSecondary: "Как это работает",
    problemTitle: "На что уходит время бухгалтера",
    problems: [
      "Перепечатывать счета-фактуры из Didox и Faktura.uz в 1С",
      "Разносить банковские выписки вручную и искать ошибки",
      "Собирать отчёт, когда руководитель спрашивает «сколько на 5110?»",
    ],
    howTitle: "Как это работает",
    steps: [
      {
        title: "Установите приложение",
        text: "Поставьте Windows-приложение на компьютер с 1С и войдите в свой аккаунт.",
      },
      {
        title: "Подключите компанию",
        text: "Выберите базу 1С. Приложение работает с 1С через COM: публиковать базу или держать 1С открытой не нужно.",
      },
      {
        title: "Работайте",
        text: "Документы записываются в 1С без проведения — проводите вы, после проверки. Вопросы задавайте ассистенту.",
      },
    ],
    featuresTitle: "Возможности",
    soon: "Скоро",
    features: [
      {
        title: "Прямая работа с 1С",
        text: "Несколько компаний и баз, каждая в своём подключении. Пароль 1С хранится под защитой Windows.",
        soon: false,
      },
      {
        title: "ИИ-ассистент",
        text: "«Каким поставщикам мы должны больше всего?» — ассистент читает 1С и отвечает с цифрами. Только чтение.",
        soon: false,
      },
      {
        title: "Электронные счета-фактуры",
        text: "Входящие счета-фактуры из Didox и Faktura.uz попадают в 1С с проверкой контрагента и номенклатуры.",
        soon: true,
      },
      {
        title: "Банковские выписки",
        text: "Строки выписки разносятся по счетам по правилам, повторы пропускаются.",
        soon: true,
      },
      {
        title: "Проверка перед записью",
        text: "Арифметика, ставки НДС, закрытый период и повторный импорт проверяются до записи в 1С.",
        soon: false,
      },
      {
        title: "Аудит учёта",
        text: "Список странностей в остатках и документах — со ссылкой на документ в 1С.",
        soon: true,
      },
    ],
    securityTitle: "Учётные данные остаются на вашем компьютере",
    securityText:
      "Приложение работает с 1С на вашем компьютере. Наш сервер знает только аккаунт и лицензию. ИИ-ассистент включается отдельно для каждой компании, с вашего согласия.",
    securityLink: "Подробнее",
    finalTitle: "Начните сегодня",
    finalText: "14 дней бесплатно, карта не нужна.",
  },
  pricing: {
    title: "Цены",
    subtitle: "Начните бесплатно со всеми возможностями. Платные тарифы объявим скоро.",
    trial: {
      name: "Пробный",
      price: "0 сум",
      period: "14 дней",
      items: [
        "1 пользователь, 2 компьютера",
        "До 5 компаний",
        "ИИ-ассистент (1 млн токенов)",
        "Все доступные возможности",
      ],
      cta: "Начать бесплатно",
    },
    plans: [
      { name: "Бухгалтер", for: "Для специалиста, который ведёт одну или несколько компаний" },
      { name: "Фирма", for: "Для бухгалтерских фирм с множеством клиентов, несколько пользователей" },
    ],
    soon: "Цена скоро",
    note: "Оплата через Payme. Когда пробный период закончится, данные останутся в 1С, а приложение перейдёт в режим только чтения.",
  },
  security: {
    title: "Безопасность",
    subtitle: "Какие данные где хранятся и чего мы никогда не делаем.",
    tableWhat: "Данные",
    tableWhere: "Где",
    rows: [
      ["Учёт: документы, остатки, контрагенты", "Ваша база 1С и ваш компьютер"],
      ["Пароль 1С", "На вашем компьютере, под защитой Windows (DPAPI)"],
      ["Аккаунт, тариф, лицензия", "Наш сервер"],
      ["Вопросы ИИ и прочитанные им строки", "Только если включён: через наш сервер в Claude (Anthropic)"],
    ],
    principlesTitle: "Наши правила",
    principles: [
      {
        title: "Без проведения",
        text: "Приложение записывает документы в 1С без проведения. Проводите всегда вы.",
      },
      {
        title: "Без дублей",
        text: "Каждый импорт помечен идентификатором источника: один документ не запишется дважды.",
      },
      {
        title: "Журнал",
        text: "Всё, что приложение записало в 1С, видно в журнале внутри самой 1С.",
      },
      {
        title: "ИИ только читает",
        text: "Ассистент не может создавать, менять или удалять что-либо в 1С. Включается отдельно для каждой компании.",
      },
    ],
  },
  faq: {
    title: "Частые вопросы",
    items: [
      {
        q: "С какими конфигурациями 1С работает?",
        a: "1С:Бухгалтерия для Узбекистана 3.0 (1С:Предприятие 8.3, 64-бит). В базу ставится небольшое расширение PlatformAPI.",
      },
      {
        q: "Нужно ли публиковать базу в интернет?",
        a: "Нет. Приложение работает с 1С на том же компьютере через COM. Подходит и файловая база, и сервер 1С.",
      },
      {
        q: "Что будет, если пропадёт интернет?",
        a: "Приложение работает без интернета до 7 дней. Потом нужно подключение, чтобы проверить лицензию.",
      },
      {
        q: "Куда ИИ-ассистент отправляет мои данные?",
        a: "Только для компании, где вы его включили: вопрос и нужные для ответа строки уходят через наш сервер в Claude (Anthropic). Они не используются для обучения моделей.",
      },
      {
        q: "На сколько компьютеров можно установить?",
        a: "В пробном тарифе — один пользователь на 2 компьютерах. Старый компьютер можно удалить в кабинете и перейти на новый.",
      },
      {
        q: "Windows пишет «Система Windows защитила ваш компьютер» — это нормально?",
        a: "Да, пока установщик без цифровой подписи. Нажмите «Подробнее» → «Выполнить в любом случае».",
      },
    ],
  },
  download: {
    title: "Скачать",
    subtitle: "Windows-приложение ставится на компьютер, где стоит 1С.",
    button: "Скачать для Windows",
    file: "1C-Platform-Setup.exe · 64-бит",
    requirementsTitle: "Требования",
    requirements: [
      "Windows 10 или 11, 64-бит",
      "1С:Предприятие 8.3 (64-бит), зарегистрирован COM-коннектор",
      "1С:Бухгалтерия для Узбекистана 3.0 + расширение PlatformAPI",
      "Интернет для ИИ-ассистента и лицензии",
    ],
    stepsTitle: "Установка",
    steps: [
      "Запустите установщик. Если Windows предупредит: «Подробнее» → «Выполнить в любом случае».",
      "Войдите в приложении с аккаунтом с сайта — компьютер активируется сам.",
      "Через «Подключить компанию» выберите свою базу 1С.",
    ],
    noAccount: "Нет аккаунта?",
  },
  auth: {
    signupTitle: "Начать бесплатный период",
    signupSubtitle: "14 дней со всеми возможностями. В приложение входите с этим же аккаунтом.",
    loginTitle: "Вход в кабинет",
    loginSubtitle: "Тариф, компьютеры и загрузка приложения.",
    name: "Ваше имя",
    accountName: "Название фирмы или компании",
    email: "Эл. почта",
    password: "Пароль",
    passwordHint: "Не меньше 10 символов",
    submitSignup: "Создать аккаунт",
    submitLogin: "Войти",
    haveAccount: "Уже есть аккаунт? Войти",
    noAccount: "Нет аккаунта? Зарегистрироваться",
    working: "Подождите…",
    errors: {
      EMAIL_TAKEN: "Аккаунт с этой почтой уже есть.",
      INVALID_CREDENTIALS: "Неверная почта или пароль.",
      VALIDATION: "Проверьте поля.",
      RATE_LIMITED: "Слишком много попыток, подождите минуту.",
      REGISTRATION_CLOSED: "Регистрация временно закрыта.",
      OFFLINE: "Не удалось связаться с сервером.",
      default: "Непредвиденная ошибка. Попробуйте позже.",
    },
  },
  cabinet: {
    title: "Кабинет",
    loading: "Загрузка…",
    account: "Аккаунт",
    plan: "Тариф",
    planNames: { trial: "Пробный" },
    status: {
      trial: "Пробный период",
      active: "Активен",
      grace: "Оплата просрочена",
      suspended: "Приостановлен",
      cancelled: "Отменён",
    },
    until: "до {date}",
    trialNote: "Платные тарифы и оплата через Payme — скоро.",
    devices: "Компьютеры",
    noDevices: "Пока ни один компьютер не активирован. Скачайте приложение и войдите с этим аккаунтом.",
    activated: "Активирован",
    lastSeen: "Последняя проверка",
    revoke: "Удалить",
    revoked: "Удалён",
    confirmRevoke: "Удалить компьютер {name}? Он больше не сможет войти в приложение.",
    download: "Скачать приложение",
    logout: "Выйти",
  },
  footer: {
    tagline: "Автоматизация 1С для бухгалтеров Узбекистана",
    prototype: "Прототип",
  },
};

export const DICTIONARIES: Record<Locale, Dict> = { uz, ru };
export type { Dict };

export function dict(locale: Locale): Dict {
  return DICTIONARIES[locale];
}
