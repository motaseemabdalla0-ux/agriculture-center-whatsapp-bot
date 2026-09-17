# تقرير: Farmer Registry + قاعدة أمان الاسم العربي

## 1) الملفات الجديدة والمعدّلة

**جديدة:**
| الملف | الغرض |
|---|---|
| `lib/farmerRegistry.js` | السجل الدائم لكل مزارع (اسم عربي، حالة تواصل، سبب/مصدر آخر تواصل، عدد الرسائل، سجل تواصل كامل) |
| `lib/arabicNameGuard.js` | `isArabicName()` (فحص صارم: عربي بالكامل أو حظر) + `templateUsesName()` (هل القالب بيستخدم `{name}` أصلًا) |
| `lib/contactReasonMap.js` | خريطة صريحة (بدون تخمين) من campaignType/purpose إلى messageSource/contactReason/communicationStatus |
| `scripts/testFarmerRegistryAndArabicNameSafety.js` | 32 اختبار (يغطي الـ27 بند المطلوبة) |

**معدّلة:**
| الملف | التعديل |
|---|---|
| `lib/campaignBuilder.js` | حالة صف جديدة `blocked_non_arabic_name` + عدّادات `arabic_names`/`non_arabic_names` في الـPreview |
| `lib/campaignRunner.js` | بعد نجاح إرسال حقيقي (`sent`) بس، بينادي `farmerRegistry.recordSuccessfulContact` |
| `lib/personalizedRunner.js` | يحل الاسم العربي الموثوق قبل `fillTemplate`، يحظر ويسجّل Audit لو مفيش اسم موثوق، ويحدّث Registry بعد النجاح |
| `campaign-inbox/inboxEngine.js` | يحدد هل القالب بيستخدم `{name}`، يحل الاسم العربي الموثوق *قبل* بناء الرسالة النهائية |
| `index.js` | أوامر جديدة `سجل <رقم/اسم>` و`تواصل <رقم>`؛ تحديث Registry عند رد المزارع (`FARMER_REPLIED`) أو التحويل لموظف (`HANDED_OFF`) |

**لم تُمس إطلاقًا**: `lib/safeFarmerSend.js`, `lib/farmerState.js`, `lib/sendFingerprint.js`, `lib/sentTracker.js`, `lib/rateLimiter.js`, `campaign-inbox/campaignScheduler.js`, `lib/portalSync.js`.

## 2) طريقة حفظ الاسم العربي

أولوية صارمة، بدون أي تعريب/تخمين تلقائي:
1. **اسم موجود بالفعل في `farmerRegistry`** - لو موجود، بيتستخدم دايمًا ولا يُستبدل أبدًا باسم لاحق (حتى لو عربي مختلف) - استقرار كامل.
2. لو مفيش اسم محفوظ، وكان الاسم الجديد (من Portal/Campaign File) **عربي بالكامل فعليًا** (`isArabicName`)، بيتحفظ كأول اسم موثوق.
3. لو الاسم الجديد مش عربي بالكامل (إنجليزي أو مختلط)، **مايتحفظش خالص** - السجل يفضل من غير اسم عربي لحد ما يجي مصدر عربي موثوق.

## 3) طريقة تحديث Farmer State

**لم تتغيّر إطلاقًا.** `farmerState.js` يفضل المصدر الوحيد والحصري لحالة المزارع، وبيتحدّث فقط من Portal Sync أو إجراء إداري معتمد (زي "علم استلام البطاقة") - بالضبط زي قبل هذا التعديل. مُختبر صراحة (اختبار 20-21): إرسال رسالة ناجحة لا يغيّر Farmer State إطلاقًا، بينما تحديث بوابة موثوق يغيّرها بشكل طبيعي.

## 4) طريقة تحديث Communication Status

بيتحدّث تلقائيًا **بعد نجاح إرسال فعلي (`SENT`) بس** - أي حالة تانية (`FAILED`/`BLOCKED`/`DUPLICATE`/`BLOCKED_NON_ARABIC_NAME`) لا تُحدّث Registry إطلاقًا (بس بتتسجّل في Audit Log بسبب عدم الإرسال). الخريطة:

| contactReason | communicationStatus بعد النجاح |
|---|---|
| `CARD_READY`, `CARD_ISSUED` | `CARD_READY_NOTIFIED` |
| `DOCUMENTS_REQUIRED` | `DOCUMENTS_REQUESTED` |
| `REGISTRATION_INVITATION` | `REGISTRATION_INVITATION_SENT` |
| `DRAFT_REMINDER` | `DRAFT_REMINDER_SENT` |
| أي سبب تاني (GENERAL_NOTICE/SURVEY/EVALUATION/CUSTOM_MESSAGE/APPLICATION_UNDER_REVIEW) | `MESSAGE_SENT` |

## 5) Contact Reason لكل نوع رسالة (`lib/contactReasonMap.js`)

| النوع (campaignType/purpose) | messageSource | contactReason |
|---|---|---|
| `card_pickup` / Purpose `CARD` | SYSTEM_NOTIFICATION / CAMPAIGN | `CARD_READY` |
| `documents_request` / Purpose `DOCUMENTS` | SYSTEM_NOTIFICATION / CAMPAIGN | `DOCUMENTS_REQUIRED` |
| `registration_status` | SYSTEM_NOTIFICATION | `APPLICATION_UNDER_REVIEW` *(أعم سبب متاح - راجع القيد الموثّق تحت)* |
| `registration_invitation` / Purpose `REGISTRATION` | CAMPAIGN | `REGISTRATION_INVITATION` |
| `draft_reminder` | CAMPAIGN | `DRAFT_REMINDER` |
| Purpose `GENERAL_NOTICE`/`SURVEY`/`EVALUATION` | CAMPAIGN | نفس الاسم |
| `broadcast`/`custom_message`/غير معروف | CAMPAIGN | `GENERAL_NOTICE`/`CUSTOM_MESSAGE` |

**قيد موثّق صراحةً**: `registration_status` بيغطي أكتر من حالة بوابة فعلية (الطلب اتقبل/تحت المراجعة) من غير ما نقدر نميّز بينهم من البيانات المتاحة حاليًا (نفس القيد الموثّق سابقًا بخصوص SUBMITTED/UNDER_REVIEW) - فبنستخدم أعم سبب متاح بدل تخمين حالة أدق مالناش دليل عليها.

## 6) مثال سجل مزارع كامل (بيانات حقيقية من تشغيل فعلي - Fake Client)

```json
{
  "phone": "966555323315",
  "nameArabic": null,
  "communicationStatus": "CARD_READY_NOTIFIED",
  "lastContactReason": "CARD_READY",
  "lastMessageSource": "CAMPAIGN",
  "lastContactAt": "2026-09-17T10:05:59.621Z",
  "totalMessages": 2,
  "communicationHistory": [
    { "date": "2026-09-17T10:05:59.572Z", "source": "SYSTEM_NOTIFICATION", "reason": "APPLICATION_UNDER_REVIEW", "status": "SENT" },
    { "date": "2026-09-17T10:05:59.621Z", "source": "CAMPAIGN", "reason": "CARD_READY", "status": "SENT" }
  ]
}
```

## 7) مثال تسلسل حالته عبر عدة رسائل (نفس التشغيل أعلاه، بالترتيب الفعلي)

```
1. محاولة "دعوة للتسجيل" (Purpose=REGISTRATION) → 🚫 blocked_by_state
   (المزارع كان أصلًا CARD_ISSUED - الطبقة الأمنية safeFarmerSend منعتها بشكل صحيح تمامًا
   ولم تُسجَّل في Registry، وده دليل حي إن Farmer State وCampaign Rules شغالين زي الأول)
2. "طلبك تحت المراجعة" (SYSTEM_NOTIFICATION) → ✅ SENT → Communication Status: MESSAGE_SENT
3. "بطاقتك جاهزة" (Purpose=CARD) → ✅ SENT → Communication Status: CARD_READY_NOTIFIED
```
`totalMessages` انتهى عند **2** بالظبط (مش 3) - لأن المحاولة المحظورة لم تُحتسب، بالضبط زي المطلوب.

## 8) مثال اسم إنجليزي تم حظره (BLOCK فعلي)

```json
{
  "name": "SALEH MOSA ALI",
  "phone": "966598111222",
  "message": "عزيزي {name}، تذكير باستكمال بياناتك",
  "status": "blocked_non_arabic_name",
  "reason": "BLOCKED_NON_ARABIC_NAME",
  "usesNamePlaceholder": true
}
```
لاحظ إن الرسالة **لم تُبنَ حتى بالاسم الإنجليزي** - اتحظرت بالكامل قبل أي إرسال، ومفيش أي محاولة تعريب تلقائي.

## 9) تأكيد: System Notifications وInbound Replies خارج حصة الـ500/50

- **مُختبر مباشرة** (اختبار 22-23): بعد استهلاك الحصة بالكامل (dayCount=1, limit=1)، رسالة `CAMPAIGN` اتمنعت (`rate_limited`)، بينما `SYSTEM_NOTIFICATION` (نفس اللحظة، نفس ملف الحصة) اتبعتت بنجاح (`sent`) - العدّاد ما اتأثرش.
- **مُختبر مباشرة** (اختبار 25): إشعار SYSTEM_NOTIFICATION اتبعت بنجاح حتى مع محاكاة "500/500" فعلية.
- **INBOUND_REPLY** (اختبار 24، 26): مؤكد بنيويًا (مش مجرد اختبار وظيفي) - الردود التلقائية بتستخدم `msg.reply()` مباشرة، **لا تمر على `safeFarmerSend` ولا `rateLimiter` إطلاقًا** بالتصميم الأصلي، فمعزولة تمامًا عن أي حصة حملات.

## 10) نتائج كل الاختبارات (قديمة + جديدة)

| المجموعة | نجح | فشل |
|---|---|---|
| A–N + G2 (Part A) | 33 | 0 |
| Part B (Purpose/Preview/DRY RUN) | 60 | 0 |
| Part C (Fail-Closed) | 24 | 0 |
| تصنيف الرسائل + Campaign Rate Limiter | 54 | 0 |
| القالب الموحّد | 29 | 0 |
| Updater + Campaign Inbox | 36 | 0 |
| **Farmer Registry + أمان الاسم العربي (جديد، 1-27)** | **32** | **0** |
| **الإجمالي** | **268** | **0** |

صفر رسائل واتساب حقيقية (Fake Client في كل الاختبارات). `node --check` نجح على كل الملفات. تم التأكيد أيضًا إن ملفات بيانات الاختبار (`farmer_registry.json` وغيرها) لم تُرفع لـGitHub (أُضيفت لـ`.gitignore`).
