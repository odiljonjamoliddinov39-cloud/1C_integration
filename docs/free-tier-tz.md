# Free tariff: hisob-kitob va yakuniy qaror (TZ)

Bu hujjat "bepul tarif qanday bo'lishi kerak" mavzusini yopadi: raqamlar qayerdan kelgani,
nega shunday tanlanganini yozib qo'yadi, shu bilan har safar qaytib muhokama qilinmaydi.
Kodga mos: `apps/api/src/billing/entitlements.ts`, `invoicing.ts`, migratsiya `0019_free_tier_rebalance.sql`.

## 1. Haqiqiy narx (model.ts'dagi PRICES jadvalidan)

Claude Sonnet 5.5: kirish $2 / 1M token, chiqish $10 / 1M token, kesh o'qish $0.2 / 1M token.

Taxmin (hali real `admin → AI cost` statistikasi bilan tasdiqlanmagan, ishga tushgач 2-4 hafta
real ma'lumot bilan tekshiriladi):

| Harakat turi                               | Taxminiy narx |
| ------------------------------------------ | ------------- |
| Oddiy savol, 1 bosqich (effort=high)       | ~$0.03–0.05   |
| Ko'p bosqichli savol (2–3 marta 1C o'qish) | ~$0.08–0.15   |
| Import (effort=low, lekin fayl katta)      | ~$0.15–0.40   |
| Audit (butun kompaniyani o'qiydi)          | ~$0.30–0.80   |

10 ta aralash harakat (savol + 1-2 import) ≈ **$1–2.5/oy** — eski $3 chegara bilan ba'zan
mos kelmaydi (import ko'proq bo'lsa, $ chegara savol-sonidan OLDIN tegadi — foydalanuvchi
"nega 10-chi savolga yetmay to'xtadim" deb chalkashishi mumkin).

## 2. Topilgan nomuvofiqlik: import 30, AI savol 10

Import deyarli har doim AI orqali bajariladi → 30 import huquqi 10 AI-savol limitidan
oldin tugaydi, ya'ni amalda hech qachon ishlatilmaydi. Ikki raqam bir-biriga zid signal beradi.

**Qaror:** ikkisini bitta hikoyaga tushiramiz — `imports_per_month` 30 → **10** (AI savol bilan teng).
Alohida hisoblagich bo'lib qolaveradi (kod murakkablashmaydi), lekin narxlash sahifasida
ikkita son endi bir-biriga zid ko'rinmaydi.

## 3. Yakuniy Free raqamlari

| Parametr                        | Eski | Yangi               | Izoh                                                                                               |
| ------------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Kompaniya / foydalanuvchi       | 1/1  | 1/1                 | o'zgarmadi                                                                                         |
| Import / oy                     | 30   | **10**              | AI savol bilan tenglashtirildi                                                                     |
| Audit / oy                      | 1    | 1                   | o'zgarmadi — yuqori qiymatli "teaser"                                                              |
| AI savol / oy                   | 10   | 10                  | asosiy son o'zgarmadi                                                                              |
| **Onboarding bonus** (yangi)    | —    | +5, birinchi 30 kun | faqat trial/pullikdan tushganlarga — trial (14 kun, 30 savol) dan Free'ga tushish keskin bo'lmasin |
| $ chegara / oy                  | 3    | **5**               | 10 harakat count'dan OLDIN tegmasin                                                                |
| $ chegara / kun / user          | 1.5  | **2**               | mos ravishda kengaytirildi                                                                         |
| Excel export / priority support | yo'q | yo'q                | o'zgarmadi — pullikka undash signali                                                               |

## 4. Kredit (micro-topup) — uchinchi monetizatsiya qatlami

Qoida (oddiy, standart): **`one_off` addon har qanday holatda (Free, trial, pullik) sotib
olinadi va qo'llanadi; `recurring` addon (qo'shimcha kompaniya/user) faqat pullik tarifda** —
chunki recurring addon davrga bog'langan, Free'da davr yo'q.

Yangi addon: `addon_ai_5` — 5 ta qo'shimcha AI-harakat, **25 000 so'm**, `one_off`,
`allowedPlans: [free, start, business, firm]`. Narx asosi: 5 harakat ≈ $0.5–0.75 real xarajat,
25 000 so'm (~$2) — past bar'er, sog'lom margin, "mikro-to'lov orqali ishontirish" maqsadida
(katta `addon_ai_100` paketi bilan bir xil g'oyada, lekin Free uchun kichraytirilgan).

Amal qilish muddati: xarid Free/trial holatida bo'lsa 30 kun (mavjud `addDays(now, 30)`
mantiqi — `invoicing.ts`da allaqachon bor edi, o'zgartirilmadi).

## 5. Texnik o'zgarishlar (implement qilindi)

1. `apps/api/drizzle/0019_free_tier_rebalance.sql` — `imports_per_month` 30→10, `ai_policies`
   (free) 3→5 / 1.5→2, yangi `addon_ai_5` qatori.
2. `packages/shared/src/billing.ts` — `FREE_ONBOARDING_BONUS_DAYS=30`,
   `FREE_ONBOARDING_BONUS_AI_QUESTIONS=5`.
3. `apps/api/src/billing/entitlements.ts` — onboarding bonus hisoblash: `subscription.trialUsed`
   bo'lgan va `startsAt`dan 30 kun o'tmagan hisoblarga qo'llaniladi (ya'ni faqat trial yoki
   pullik tarifdan "tushgan"larga — yangi, hech qachon trial olmagan ro'yxatdan o'tish oddiy
   10 bilan qoladi: shunday yangi hisobga tegishli testlar o'zgarishsiz qoladi). Eslatma: to'g'ridan-
   to'g'ri (trial'siz) pullik tarifni olib keyin bekor qilgan hisob ham bonusni olmaydi — bu
   bilinган kichik bo'shliq, chunki bazada buni belgilaydigan alohida ustun yo'q; agar muhim
   bo'lsa, keyinroq qo'shiladi.
   Bought-addon tsikli endi har doim ishga tushadi (oldin faqat active/grace),
   `one_off` grantlar holatdan qat'i nazar qo'shiladi, `recurring` grantlar faqat active/grace'da
   (eski xatcho'p: admin qo'lda Free hisobga addon bersa ham, u oldin HECH QACHON qo'llanmasdi —
   bu ham shu bilan tuzatildi).
4. `apps/api/src/billing/invoicing.ts` — xarid vaqtidagi tekshiruv endi faqat `recurring`
   addon'larni Free/trial'da to'xtatadi; `one_off` har doim o'tadi.

## 6. Keyingi qadam (kod yozilmagan, kelgusida)

Haqiqiy `admin → AI cost` statistikasi 2-4 hafta to'plangach, 3-bo'limdagi taxminiy narxlarni
real raqamlar bilan solishtirib, kerak bo'lsa (admin panel orqali, release talab qilmay)
AI-savol sonini yoki $ chegarani qayta sozlash mumkin. Bu hujjat o'shanda "v2" bilan yangilanadi,
yangi mavzu ochilmaydi.
