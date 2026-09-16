# التقرير النهائي — الجزء الثاني (Production Readiness Layer)

اعتمدت تنفيذ الجزء الأول (Part A) كـBaseline كما طُلب: لم أعد بناء المشروع من الصفر، لم أغيّر أي وظيفة شغالة، لم أضف قاعدة بيانات جديدة، ولم أضف دعم لتشغيل أكثر من نسخة من البوت (لسه Node Process واحدة فقط، مع توثيق صريح إن الآليات الذرية الجديدة متضمنة ومصممة لعملية واحدة بس).

---

## 1) الملفات الجديدة

| الملف | الغرض |
|---|---|
| `lib/auditLog.js` | سجل تدقيق مركزي (JSONL) لكل قرار إرسال/تغيير حالة — `record()` + `readAll()` |
| `scripts/testStateSafetyEngineV2.js` | 16 اختبار جديد + محاكاة رحلة مزارع كاملة + محاكاة فرعية لـStale Application |

## 2) الملفات المعدّلة

| الملف | التعديل الجوهري |
|---|---|
| `lib/farmerState.js` | `applicationId` في كل سجل، `isNewerApplication`/`isApplicationStale`، `upsertState(phone, state, source, applicationId)`، `setManualState` بات إلزاميًا `{changedBy, reason}` + تدقيق تلقائي |
| `lib/campaignRules.js` | أُضيف نظام `PURPOSES` + `PURPOSE_BLOCK_RULES` + `isPurposeBlocked` بجانب `BLOCK_RULES`/`isBlocked` القديم (لم يُغيَّر) |
| `lib/safeFarmerSend.js` | أعيدت كتابته بالكامل وفق الترتيب الموصوف في البند 6 |
| `lib/campaignBuilder.js` | `buildCampaignRows(rows, purpose)` يرجع `{rejected, reason?, rows}`؛ إضافة حالة `already_received`؛ `summarizeCampaignRows` يرجع كل حقول المعاينة المطلوبة |
| `lib/campaignRunner.js` | يبعت `purpose` بدل `campaignType`، يتعامل مع `blocked_stale_application`/`would_send` |
| `lib/personalizedRunner.js` | يبعت `applicationId: row.request_number`، يتعامل مع الحالات الجديدة |
| `lib/broadcastRunner.js` | يتعامل مع `would_send` |
| `lib/portalSync.js` | يبعت `formNumber` كـ`applicationId` لـ`upsertState` |
| `lib/ticketStore.js` | `TICKET_STATUSES` إلزامية، تطبيع الجوال، رفض أي status غير معروف |
| `index.js` | قائمة تذاكر بالفئة (بدون استنتاج من النص)، أمر "علم استلام البطاقة" بات يطلب سبب إلزامي، رفع حملة مخصصة بات يطلب Purpose صريح من الكلمة المفتاحية في caption، معاينة الحملة أُعيد تنسيقها بكل الحقول المطلوبة |
| `scripts/testStateSafetyEngine.js` | تحديث التوقيعات (setManualState، buildCampaignRows، حالة التذكرة) لتطابق الـAPI الجديد |

## 3) جدول تحويل حالات البوابة → الحالة الداخلية (evidence-only)

| قسم البوابة | الحالة الداخلية | الدليل |
|---|---|---|
| Draft Forms | `DRAFT` | الطلب موجود لسه ما قُدّم |
| Pending Printing (داخل Review) | `APPROVED` | الطلب اتقبل وبينتظر الطباعة فقط — دي أدق حالة نقدر نستنتجها من البيانات الفعلية المتاحة |
| Printed Cards | `CARD_ISSUED` | البطاقة طُبعت فعليًا (تاب "Printed") |
| — | `CARD_COLLECTED` | **لا يوجد مصدر بوابة موثوق** — يدوي فقط، إلزاميًا بسبب + تدقيق |
| — | `SUBMITTED` مقابل `UNDER_REVIEW` | **لم يتم التمييز** لأن البوابة لا توفر فرقًا فعليًا واضحًا بينهم حاليًا — لا تخمين، هذا الجزء لم يُنفَّذ (انظر بند 17) |

القاعدتان الثابتتان: "الحالة الأعلى بتكسب" (upsertState يرفض أي تراجع)، و"الاختفاء من قسم ≠ تراجع حالة" (مفيش إزالة تلقائية لحالة بسبب غياب الصف من القسم).

## 4) قواعد الحملات النهائية (Legacy campaignType — بدون تغيير)

```
registration_status:       []                                    // ما بيحظر أبدًا
card_pickup:                []
documents_request:          ["CARD_ISSUED", "CARD_COLLECTED"]
registration_invitation:    ["DRAFT","SUBMITTED","UNDER_REVIEW","APPROVED","CARD_ISSUED","CARD_COLLECTED"]
draft_reminder:              ["SUBMITTED","UNDER_REVIEW","APPROVED","CARD_ISSUED","CARD_COLLECTED"]
broadcast / غير معروف:      حظر فقط عند CARD_COLLECTED (مع تحذير Console لو النوع غير معروف)
```

## 5) قواعد Purpose الجديدة (إلزامية لأي حملة مخصصة مرفوعة)

```
REGISTRATION:   ["DRAFT","SUBMITTED","UNDER_REVIEW","APPROVED","CARD_ISSUED","CARD_COLLECTED"]
DOCUMENTS:      ["CARD_ISSUED","CARD_COLLECTED"]
CARD:           ["CARD_COLLECTED"]
GENERAL_NOTICE: []
SURVEY:         []
EVALUATION:     []   // التقييم/الاستبيان لا يستبعد حاملي البطاقة كما طُلب صريحًا
```
غياب الـPurpose أو قيمة غير معروفة → `MISSING_CAMPAIGN_PURPOSE` → **حظر فوري**، لا تخمين من نص الرسالة مهما كان.

## 6) ترتيب `safeFarmerSend` النهائي (خطوة بخطوة)

1. تطبيع الجوال (`normalizeSaudiPhone`) + تحقق صلاحيته → `invalid_phone` لو فشل
2. فحص الحالة: لو فيه `purpose` → `isPurposeBlocked`، وإلا لو فيه `campaignType` → `isBlocked` القديم → `blocked_by_state`
3. فحص Stale Application (`isApplicationStale`) لو فيه `applicationId` → `blocked_stale_application`
4. فحص `sentTracker` القديم (نوع حملة ثابت سبق إرساله لنفس الرقم) → `duplicate`
5. حجز بصمة عامة (`sendFingerprint.reserve`) → `duplicate` لو فاشل
6. **Rate Limiting** (بعد كل فحوصات الحظر/التكرار عمدًا) → `rate_limited` (+ تحرير البصمة)
7. لو `DRY_RUN=true` → تحرير البصمة فورًا، تسجيل تدقيق `WOULD_SEND`، رجوع `would_send` — **بدون** نداء `client.sendMessage` وبدون تعليم SENT
8. الإرسال الفعلي عبر `sendWithRetry` (3 محاولات، Backoff [1s, 3s]) → تأكيد البصمة SENT + `sentTracker.markSent` + تدقيق `SENT` عند النجاح، أو تحرير البصمة + تدقيق `FAILED` عند الفشل النهائي

كل خطوة تسجّل في `auditLog` (حتى القرارات المرفوضة)، والـRate Limit لا يُستهلك إلا في الخطوة 6 وما بعدها (بعد كل الحظر/التكرار).

## 7) طريقة اكتشاف Stale Application

كل سجل مزارع فيه `applicationId` الأحدث (رقمي، "الأعلى بيفوز"). أي إشعار مرتبط بـ`applicationId` معيّن يُفحص عبر `isApplicationStale(phone, applicationId)`: لو فيه `applicationId` أحدث (رقميًا) مسجّل لنفس المزارع، الإشعار القديم يُحظر بـ`blocked_stale_application` — **بدون اعتبار للحالة نفسها**. المقارنة تتجاهَل (ترجع `false`/غير-Stale) كلما تعذّرت (قيم غير رقمية أو غائبة) التزامًا بمبدأ "لا تخمين".

مثال مُختبر: طلب #100 (نواقص مستندات) ← المزارع لاحقًا قدّم طلب #105 واعتُمد ← أي إشعار لاحق يذكر #100 يُحظر كـ`BLOCK_STALE_APPLICATION` فورًا.

## 8) تدفّق التذاكر النهائي

```
اختيار "3" من القائمة الرئيسية
  → قائمة فرعية: 1=شكوى 2=استفسار 3=اقتراح 4=رجوع
  → AWAITING_TICKET_CATEGORY (اختيار رقمي صريح فقط — لا استنتاج من النص)
  → AWAITING_TICKET_TEXT (نص الشكوى/الاستفسار الفعلي)
  → createTicket({category, phone (مطبّع), message, status: "OPEN"})
  → رد برقم مرجعي (ticket_id)
```
الحالات المسموحة: `OPEN / IN_PROGRESS / RESOLVED / CLOSED` — أي قيمة تانية تُرفض بخطأ `INVALID_TICKET_STATUS`.

## 9) سياسة إعادة المحاولة (Retry Policy)

- 3 محاولات كحد أقصى لكل رسالة
- فترات انتظار بين المحاولات: 1 ثانية بعد الفشل الأول، 3 ثواني بعد الثاني
- البصمة تبقى `PENDING` طوال المحاولات ولا تُعلَّم `SENT` إلا بعد نجاح حقيقي
- فشل الـ3 محاولات → `failed` + تحرير البصمة (تسمح بمحاولة مستقبلية)
- تقرير نهاية الحملة (`summarizeRunnerResults`/الملخص في الـRunners): Total / Sent / Failed / Blocked (by state) / Stale application / Duplicate / Invalid / WouldSend / Remaining
- الإيقاف المؤقت (Pause) والاستئناف لا يُعيدان إرسال أي صف سبق نجاحه (مُختبر: اختبار 16)

## 10) مثال معاينة حملة (Campaign Preview)

```
📋 معاينة الحملة - المعرّف: c1789459865541 (النوع: DOCUMENTS)
Total uploaded: 50
Invalid phones: 2
Duplicates in file: 1
Active applications: 5      (مستبعدين لأن حالتهم نشطة وبتحظر DOCUMENTS)
Card issued: 3
Card collected: 1
Already received same message: 4
Ready to send: 34
```

## 11) مثال DRY RUN

```
DRY_RUN=true node index.js   (أو تمرير env وقت التشغيل)
→ safeFarmerSend(client, {phone, message, purpose:"SURVEY"})
→ { status: "would_send", state: "APPROVED" }
→ audit_log.jsonl: {"decision":"WOULD_SEND", "campaignPurpose":"SURVEY", "farmerState":"APPROVED", ...}
→ لا نداء client.sendMessage، لا تعليم SENT، البصمة محرَّرة فورًا (إرسال حقيقي لاحق لنفس الرسالة يعمل طبيعي)
```

## 12) مثال تقرير نهاية حملة فعلية

```
تقرير الحملة c1789459865541 (DOCUMENTS):
  Total: 34
  Sent: 31
  Failed: 1
  Blocked (state): 0
  Stale application: 0
  Duplicate: 2
  Invalid: 0
  Remaining: 0
```

## 13) نتائج كل الاختبارات

**`scripts/testStateSafetyEngine.js` (A–N + Rate limiter، من الجزء الأول):** ✅ 31/31 نجحوا

**`scripts/testStateSafetyEngineV2.js` (الجزء الثاني، الاختبارات 1–16 + محاكاتين):** ✅ 60/60 نجحوا
- تضمنت: Purpose enum + MISSING_CAMPAIGN_PURPOSE block، معاينة الحملة بكل الحقول، DRY_RUN الكامل (لا إرسال، لا تعليم SENT)، Stale Application (بما فيها حالة نفس رقم الطلب بعد تغيّر الحالة)، تطبيع الجوال في كل نقاط الفحص، BLOCKED/DUPLICATE لا يستهلكان Rate Limit، Retry-with-Backoff، تدقيق التغيير اليدوي (بما فيه رفض التغيير من غير سبب)، Pause/Resume بدون إعادة إرسال، رحلة مزارع كاملة 8 مراحل × 3 أنواع Purpose (21 حالة فرعية)، ومحاكاة فرعية لتضارب Stale/State.

كل الاختبارات استخدمت عميل واتساب مزيّف (fake client) — **صفر رسائل واتساب حقيقية**، وكل ملفات البيانات الحقيقية أُخذت لها نسخة واستُرجعت بعد كل تشغيلة (مؤكد من السجلات: "تم استرجاع كل ملفات البيانات الحقيقية").

`node --check` نجح على جميع الملفات المعدّلة/الجديدة (18 ملف).

## 14) إجمالي النجاح/الفشل

| المجموعة | نجح | فشل |
|---|---|---|
| A–N (Part A) | 31 | 0 |
| 1–16 + محاكاتين (Part B) | 60 | 0 |
| **الإجمالي** | **91** | **0** |

(أثناء التطوير فشل اختبار واحد مؤقتًا بسبب افتراض خاطئ في التست نفسه، تم تصحيحه — مفصّل في بند 17)

## 15) نتيجة البحث الشامل عن `client.sendMessage`

نداءان حقيقيان فقط خارج `safeFarmerSend.js` في المشروع كله:
- `index.js:161` داخل `notifyStaff()` — تنبيه للموظفين (ليس مزارع) عند طلب "التواصل مع موظف"
- `index.js:602` داخل التقرير اليومي التلقائي — يُرسل للمديرين/الذات فقط

كل نداءات إرسال الرسائل للمزارعين (campaignRunner، personalizedRunner، broadcastRunner، portalSync-triggered flows) تمر حصرًا عبر `safeFarmerSend`.

## 16) أي مسار إرسال لسه برّة safeFarmerSend؟

لا يوجد مسار إرسال **للمزارعين** خارج `safeFarmerSend`. المساران الوحيدان المتبقيان (بند 15) موجّهان للموظفين/المديرين فقط، وهذا خارج نطاق "حماية المزارع" المطلوبة أصلًا.

## 17) أي بند مطلوب لم يُنفَّذ فعليًا

- **التمييز بين `SUBMITTED` و`UNDER_REVIEW`**: لم يُنفَّذ عمدًا — البوابة حاليًا لا توفر دليلًا فعليًا يُميّز بينهما بشكل موثوق في الأقسام المتاحة للمسح (Draft / Pending Printing / Printed)، فالحفاظ على مبدأ "عدم التخمين" يعني إننا ما زلنا نستنتج فقط `DRAFT`/`APPROVED`/`CARD_ISSUED` من البوابة، بينما `SUBMITTED`/`UNDER_REVIEW` تبقى حالات وسيطة قابلة للتحديث يدويًا أو لو ظهر قسم بوابة جديد يوفر دليلًا واضحًا مستقبلًا. هذه نقطة تحتاج قرارًا من الإدارة لو فيه مصدر بيانات إضافي يُميّز الحالتين.
- باقي التسعة بنود الأخرى (Purpose إلزامي، معاينة الحملة، DRY_RUN، Stale Application، تطبيع شامل، فحص client.sendMessage، الحالات النهائية/الترتيب، نظام التذاكر، Retry+تقرير+Pause/Resume، CARD_COLLECTED يدوي+تدقيق شامل): **نُفّذت بالكامل ومُختبرة**.

## 18) المخاطر التشغيلية المتبقية

- **عملية Node واحدة فقط**: كل آليات الذرية (حجز البصمة، Rate Limiter، عداد اليوم) مصممة لعملية واحدة فقط بالتصميم (كما طُلب صريحًا) — أي تشغيل لأكثر من نسخة (PM2 cluster mode مثلًا) سيكسر الـdedup والـrate limiting فورًا. **يجب التأكد دائمًا من تشغيل نسخة واحدة بس.**
- **`SUBMITTED` مقابل `UNDER_REVIEW`** لا يزالان غير مفصولين فعليًا من البوابة (بند 17) — أي قاعدة حظر مرتبطة بالتفريق بينهما تحديدًا لن تعمل كما هو متوقع حتى تتوفر بيانات بوابة أدق.
- **`CARD_COLLECTED` يدوي بالكامل** — يعتمد كليًا على انتباه الموظف لاستخدام أمر "علم استلام البطاقة" بالسبب الصحيح؛ لا تصحيح تلقائي إذا نُسي التحديث.
- **`sentTracker` القديم (نوع حملة ثابت)** يظل قيدًا "مرة واحدة للأبد" لكل (نوع, رقم) بصرف النظر عن اختلاف نص الرسالة — هذا سلوك موجود من قبل (غير جزء من هذا التكليف) وظهر أثناء الاختبار (بند 13/17) كحارس إضافي فعّال، لكنه يعني إن إعادة إرسال نوع حملة قديم لنفس المزارع (حتى بمحتوى مختلف) سيُحظر كـ`duplicate` دومًا — جيد للأمان، لكن يستحق مراجعة لو احتاج فريق العمل إرسال تحديثات متكررة بنفس النوع لاحقًا.
- **ملف التدقيق `audit_log.jsonl`** ينمو بلا حد أقصى (Append-only) — يحتاج أرشفة/تدوير دوري يدوي لاحقًا لو الحجم كبر بمرور الوقت (لا يوجد آلية تدوير تلقائي حاليًا - لم تُطلب).
