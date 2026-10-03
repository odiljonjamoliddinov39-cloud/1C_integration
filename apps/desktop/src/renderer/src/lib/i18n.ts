import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const en = {
  appName: "1C Platform",
  demoBanner: "Demo mode: an in-memory 1C base is used instead of real 1C.",
  signIn: {
    title: "Sign in",
    subtitle: "Use your platform account. This PC's license is activated on sign-in.",
    stub: "Phase 0: sign-in is a stub; the control system connects in phase 1.",
    email: "Email",
    password: "Password",
    submit: "Sign in",
  },
  header: { signOut: "Sign out", language: "Language" },
  companies: {
    title: "Companies",
    subtitle: "Connected 1C infobases on this PC",
    connect: "Connect company",
    empty: "No companies yet. Connect the first 1C infobase.",
    inn: "INN",
    infobase: "1C infobase",
    user: "1C user",
    connector: "Connector",
    lastSync: "Last sync",
    check: "Check",
    remove: "Remove",
    confirmRemove: "Remove {{name}} from this app? Nothing changes in 1C.",
    ok: "Connected",
    error: "Error",
    notChecked: "Not checked",
    checkedAt: "checked {{time}}",
    extension: "extension {{version}}",
  },
  connect: {
    title: "Connect company",
    kind: "Infobase type",
    file: "File (folder)",
    server: "1C server",
    folder: "Infobase folder",
    browse: "Browse…",
    serverName: "Server",
    ref: "Infobase name on the server",
    user: "1C user",
    password: "1C password",
    test: "Test connection",
    testing: "Connecting to 1C…",
    connected: "Connected to {{config}} {{version}}, extension {{extension}}",
    organization: "Organization",
    noOrganizations: "The infobase has no organizations.",
    save: "Connect",
    cancel: "Cancel",
    hint: "The app connects through 1C's COM connector: 1C does not need to be open, and the base does not need to be published.",
  },
  errors: {
    COM_UNAVAILABLE: "The 1C COM connector is not available on this PC.",
    CONNECT_FAILED: "1C refused the connection.",
    NOT_FOUND: "The PlatformAPI extension is not installed in this infobase.",
    BAD_RESPONSE: "1C answered in an unexpected format (check the extension version).",
    VALIDATION: "Check the fields.",
    DUPLICATE: "This company is already connected.",
    ORGANIZATION_NOT_FOUND: "The organization was not found in the infobase.",
    INTERNAL: "Unexpected error.",
    SECURE_STORAGE: "Windows secure storage is not available, so the 1C password cannot be saved.",
  },
};

type Dict = typeof en;

const ru: Dict = {
  appName: "1C Platform",
  demoBanner: "Демо-режим: вместо настоящей 1С используется база в памяти.",
  signIn: {
    title: "Вход",
    subtitle: "Войдите в аккаунт платформы. Лицензия этого ПК активируется при входе.",
    stub: "Фаза 0: вход — заглушка; система управления подключается в фазе 1.",
    email: "Эл. почта",
    password: "Пароль",
    submit: "Войти",
  },
  header: { signOut: "Выйти", language: "Язык" },
  companies: {
    title: "Компании",
    subtitle: "Подключённые информационные базы 1С на этом ПК",
    connect: "Подключить компанию",
    empty: "Компаний пока нет. Подключите первую базу 1С.",
    inn: "ИНН",
    infobase: "База 1С",
    user: "Пользователь 1С",
    connector: "Коннектор",
    lastSync: "Синхронизация",
    check: "Проверить",
    remove: "Удалить",
    confirmRemove: "Удалить {{name}} из приложения? В 1С ничего не изменится.",
    ok: "Подключено",
    error: "Ошибка",
    notChecked: "Не проверено",
    checkedAt: "проверено {{time}}",
    extension: "расширение {{version}}",
  },
  connect: {
    title: "Подключение компании",
    kind: "Тип базы",
    file: "Файловая (папка)",
    server: "Сервер 1С",
    folder: "Папка базы",
    browse: "Обзор…",
    serverName: "Сервер",
    ref: "Имя базы на сервере",
    user: "Пользователь 1С",
    password: "Пароль 1С",
    test: "Проверить подключение",
    testing: "Подключение к 1С…",
    connected: "Подключено: {{config}} {{version}}, расширение {{extension}}",
    organization: "Организация",
    noOrganizations: "В базе нет организаций.",
    save: "Подключить",
    cancel: "Отмена",
    hint: "Приложение подключается через COM-соединение 1С: 1С не нужно открывать, и базу не нужно публиковать.",
  },
  errors: {
    COM_UNAVAILABLE: "COM-соединение 1С недоступно на этом ПК.",
    CONNECT_FAILED: "1С отказала в подключении.",
    NOT_FOUND: "В базе не установлено расширение PlatformAPI.",
    BAD_RESPONSE: "1С ответила в неожиданном формате (проверьте версию расширения).",
    VALIDATION: "Проверьте поля.",
    DUPLICATE: "Эта компания уже подключена.",
    ORGANIZATION_NOT_FOUND: "Организация не найдена в базе.",
    INTERNAL: "Непредвиденная ошибка.",
    SECURE_STORAGE: "Защищённое хранилище Windows недоступно, поэтому пароль 1С нельзя сохранить.",
  },
};

const uz: Dict = {
  appName: "1C Platform",
  demoBanner: "Demo rejim: haqiqiy 1C oʻrniga xotiradagi baza ishlatilmoqda.",
  signIn: {
    title: "Kirish",
    subtitle: "Platforma akkauntingiz bilan kiring. Kirishda ushbu kompyuter litsenziyasi faollashadi.",
    stub: "0-bosqich: kirish vaqtinchalik; boshqaruv tizimi 1-bosqichda ulanadi.",
    email: "Elektron pochta",
    password: "Parol",
    submit: "Kirish",
  },
  header: { signOut: "Chiqish", language: "Til" },
  companies: {
    title: "Kompaniyalar",
    subtitle: "Ushbu kompyuterdagi ulangan 1C bazalari",
    connect: "Kompaniyani ulash",
    empty: "Hali kompaniya yoʻq. Birinchi 1C bazasini ulang.",
    inn: "INN",
    infobase: "1C bazasi",
    user: "1C foydalanuvchisi",
    connector: "Konnektor",
    lastSync: "Sinxronlash",
    check: "Tekshirish",
    remove: "Oʻchirish",
    confirmRemove: "{{name}} ilovadan oʻchirilsinmi? 1C da hech narsa oʻzgarmaydi.",
    ok: "Ulangan",
    error: "Xato",
    notChecked: "Tekshirilmagan",
    checkedAt: "{{time}} da tekshirildi",
    extension: "kengaytma {{version}}",
  },
  connect: {
    title: "Kompaniyani ulash",
    kind: "Baza turi",
    file: "Fayl (papka)",
    server: "1C server",
    folder: "Baza papkasi",
    browse: "Tanlash…",
    serverName: "Server",
    ref: "Serverdagi baza nomi",
    user: "1C foydalanuvchisi",
    password: "1C paroli",
    test: "Ulanishni tekshirish",
    testing: "1C ga ulanmoqda…",
    connected: "Ulandi: {{config}} {{version}}, kengaytma {{extension}}",
    organization: "Tashkilot",
    noOrganizations: "Bazada tashkilot yoʻq.",
    save: "Ulash",
    cancel: "Bekor qilish",
    hint: "Ilova 1C ning COM ulanishi orqali ishlaydi: 1C ni ochish va bazani eʼlon qilish shart emas.",
  },
  errors: {
    COM_UNAVAILABLE: "Ushbu kompyuterda 1C COM ulanishi mavjud emas.",
    CONNECT_FAILED: "1C ulanishni rad etdi.",
    NOT_FOUND: "Bazada PlatformAPI kengaytmasi oʻrnatilmagan.",
    BAD_RESPONSE: "1C kutilmagan formatda javob berdi (kengaytma versiyasini tekshiring).",
    VALIDATION: "Maydonlarni tekshiring.",
    DUPLICATE: "Bu kompaniya allaqachon ulangan.",
    ORGANIZATION_NOT_FOUND: "Tashkilot bazada topilmadi.",
    INTERNAL: "Kutilmagan xato.",
    SECURE_STORAGE: "Windows himoyalangan xotirasi mavjud emas, shuning uchun 1C parolini saqlab boʻlmaydi.",
  },
};

export const LANGUAGES = { uz: "Oʻzbekcha", ru: "Русский", en: "English" } as const;
export type Language = keyof typeof LANGUAGES;

function savedLanguage(): Language {
  try {
    const saved = localStorage.getItem("language");
    if (saved && saved in LANGUAGES) return saved as Language;
  } catch {
    /* storage unavailable */
  }
  return "uz";
}

export function setLanguage(language: Language) {
  void i18n.changeLanguage(language);
  document.documentElement.lang = language;
  try {
    localStorage.setItem("language", language);
  } catch {
    /* storage unavailable */
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ru: { translation: ru }, uz: { translation: uz } },
  lng: savedLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
