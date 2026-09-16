# تقرير: تصنيف الرسائل + Campaign Rate Limiter + توزيع الحملات الكبيرة

## 1) الملفات الجديدة

| الملف | الغرض |
|---|---|
| `campaign-inbox/campaignScheduler.js` | الاستئناف التلقائي - Tick دوري (كل دقيقة) بيفحص الحملات المتوقفة بسبب حصة ويكملها تلقائيًا لو الحصة اتفتحت |
| `lib/messagingDashboard.js` | أرقام لوحة العرض (CAMPAIGNS/SYSTEM NOTIFICATIONS/INBOUND) من rateLimiter + Audit Log |
| `scripts/testCampaignRateLimiterAndSourceClassification.js` | 54 اختبار (يغطي كل الـ28 بند المطلوبة) |

## 2) الملفات المعدّلة

| الملف | التعديل |
|---|---|
| `lib/safeFarmerSend.js` | إضافة `messageSource` ("CAMPAIGN"/"SYSTEM_NOTIFICATION"، افتراضي CAMPAIGN)؛ خطوة Rate Limiter بقت مشروطة `if (messageSource === "CAMPAIGN")` فقط |
| `lib/rateLimiter.js` | الحدود الافتراضية بقت 500/يوم و50/ساعة (بدل 1000/200)؛ دالة جديدة `getStatus()` للعرض/التقدّم |
| `lib/personalizedRunner.js`, `lib/broadcastRunner.js`, `lib/campaignRunner.js` | تمرير `messageSource` صراحةً لكل نداء `safeFarmerSend` |
| `index.js` | تصنيف صريح للـ5 حملات الثابتة: `registration_status/card_pickup/documents_request` = SYSTEM_NOTIFICATION، `registration_invitation/draft_reminder` = CAMPAIGN |
| `campaign-inbox/inboxStore.js` | حالتان جديدتان: `PAUSED_HOURLY_LIMIT`, `PAUSED_DAILY_LIMIT` |
| `campaign-inbox/inboxEngine.js` | `estimatedPlan` في الـPreview (توزيع الحملة الكبيرة على أيام)؛ `sendApprovedCampaign` يميّز سبب التوقف ويسمح بالاستئناف منه؛ `getCampaignProgress()` جديدة (لوحة تقدّم كاملة) |
| `lib/campaignBuilder.js`, `lib/auditLog.js` | `messageSource`/`applicationId` مُمرَّرة للتسجيل والتتبع |
| `lib/campaignRunner.js` | التوقف الفوري (بدل الاستمرار الوهمي) عند `rate_limited`، مع `CAMPAIGN_TEST_FAST` (متغيّر اختباري بس، مفيش أثر في الإنتاج) لتخطي تأخير الاختبارات الكبيرة |

**لم تُمس**: `farmerState.js`, `sendFingerprint.js`, `sentTracker.js`, `campaignRules.js` - كل فحوصات الأمان (الحالة/Stale/Dedup/Fingerprint) شغّالة بنفس القوة لكل الأنواع الثلاثة.

## 3) كيف تم التصنيف

| النوع | القاعدة | أمثلة فعلية في الكود |
|---|---|---|
| **CAMPAIGN** | أي حملة برفعها حد يدويًا (Excel/CSV) لمجموعة مزارعين | كل رفع عبر `campaign-inbox`، `broadcastRunner` (بث numbers.txt)، `registration_invitation`, `draft_reminder` |
| **SYSTEM_NOTIFICATION** | إشعار تلقائي فردي ناتج عن تغيّر حالة طلب مزارع بعينه في البوابة | `registration_status`, `card_pickup`, `documents_request` |
| **INBOUND_REPLY** | رد على رسالة واردة من مزارع | `msg.reply()` في `index.js` - **لا تمر على `safeFarmerSend` أصلًا** (مسار منفصل تمامًا بالتصميم الأصلي، لم يتغيّر) |

التصنيف **صريح** عند كل نقطة نداء (مُمرَّر كـ`messageSource`)، مفيش تخمين من نص الرسالة أو النوع.

## 4) مكان تطبيق 500/يوم و50/ساعة

داخل `lib/safeFarmerSend.js` حصرًا، خطوة واحدة، بعد كل فحوصات الأمان/التكرار/DRY_RUN، ومشروطة بـ`messageSource === "CAMPAIGN"` فقط. تأكيد بنيوي (اختبار 0): `rateLimiter.checkAndReserve()` غير مستخدمة في أي ملف تاني بالمشروع كله.

## 5) تأكيد: System Notifications لا تدخل في الحد

مُختبر مباشرة (اختبارات 7، 10، 11، 12، 13، 15، 27): إشعار SYSTEM_NOTIFICATION اتبعت بنجاح **حتى بعد استهلاك حصة الحملات بالكامل (500/500 و50/50)**، وعدّادات الـRate Limiter لم تتغيّر إطلاقًا بعد إرساله. كل فحوصات الأمان (State/Stale/Duplicate) استمرت تعمل عليه بلا استثناء (اختبار 27).

## 6) تأكيد: Auto Replies لا تدخل في الحد

بالتصميم الأصلي (لم يتغيّر): `index.js` يستخدم `msg.reply()` (واجهة `whatsapp-web.js` مباشرة) للردود التلقائية بالكامل - **لا يوجد أي نداء لـ`safeFarmerSend` أو `rateLimiter` في مسار الرد التلقائي إطلاقًا**. تأكيد بنيوي إضافي في اختبار 23. بما إن الـRate Limiter مُطبَّق فقط داخل `safeFarmerSend` (اختبار 0)، ومسار الرد لا يستدعيها أصلًا، فالعزل مضمون بالبنية نفسها لا بفحص إضافي قد يُنسى.

## 7) طريقة Automatic Resume

`campaign-inbox/campaignScheduler.js`: Tick كل 60 ثانية (نفس عملية Node، بدون Cron خارجي أو Process تاني) يفحص كل الحملات بحالة `APPROVED`/`PAUSED_HOURLY_LIMIT`/`PAUSED_DAILY_LIMIT`، ولو `rateLimiter.getStatus()` يقول فيه سعة متاحة، بينادي `sendApprovedCampaign` تاني (نفس المسار بالظبط اللي بدأ بيه الإرسال الأول) - بيكمل تلقائيًا لحد ما يوصل لحد تاني أو يخلص. **صفر ضغط يدوي مطلوب**.

## 8) طريقة Restart Recovery

كل صف في campaignStore له حالة دائمة (`pending`/`sent`/`failed`/`excluded_by_state`/...) محفوظة فورًا بعد كل قرار (مش في نهاية الحملة). عند أي إعادة تشغيل، `sendCampaignRows` بيقرا بس الصفوف `pending` (`campaignStore.getRowsByStatus(id, ["pending"])`) - الصفوف `sent` **لا تُعاد أبدًا**. مُختبر صراحة (اختبار 16-17): 1000 صف اتبعتوا، محاكاة إعادة تشغيل (تفريغ الـrequire cache)، ثم استكمال 500 تانيين - إجمالي نداءات `sendMessage` الجديدة = 500 بالظبط (صفر تكرار). الحماية الإضافية: Global Fingerprint (بصمة SENT) بتفضل موجودة برضه حتى لو حصل تلاعب يدوي بحالة الصف.

## 9) مثال كامل: حملة 3,000 مزارع على عدة أيام (نتائج فعلية من الاختبار)

```
Upload: 3000 صف (اسم الشخص | رقم الهاتف | الرسالة)
Preview: Uploaded: 3000, Ready to Send: 3000, Excluded: 0
Estimated Plan (500/يوم): 6 أيام بالظبط - كل يوم 500

DRY RUN: 3000 WOULD_SEND، صفر استهلاك Rate Limit، صفر SENT
Approval → APPROVED → SENDING

اليوم 1: أُرسلت أول 500 رسالة فعليًا → PAUSED_DAILY_LIMIT (البوت يفضل ONLINE)
[محاكاة يوم جديد] → Scheduler استأنف تلقائيًا → أُرسلت 500 تانية (إجمالي 1000)
[محاكاة يوم جديد ثاني] → استكمال تلقائي تاني → إجمالي 1500 مُرسلة، الباقي 1500 لسه pending
```
(الاختبار الفعلي أرسل حتى 1500 كإثبات مفهوم للاستئناف المتكرر - باقي الأيام تعمل بنفس الآلية بالضبط)

## 10) مثال: وصول System Notification بعد استهلاك 500/500

```js
// الحصة استُهلكت بالكامل (500/500 يوميًا، 50/50 ساعيًا)
safeFarmerSend(client, {
  phone: "0599900001", message: "بطاقتك جاهزة للاستلام",
  campaignType: "card_pickup", messageSource: "SYSTEM_NOTIFICATION",
})
// → { status: "sent" }  ✅ اتبعتت فورًا، عدّاد الحملات لم يتغيّر (500/500 كما هو)

// بالمقابل، رسالة CAMPAIGN في نفس اللحظة:
safeFarmerSend(client, { phone: "...", message: "...", purpose: "SURVEY", messageSource: "CAMPAIGN" })
// → { status: "rate_limited", reason: "daily_limit" }  🚫 هذه فقط تتمنع، ليس الإشعار
```

## 11) مثال: وصول رسالة من مزارع بعد استهلاك 500/500

الرد التلقائي (`processFarmerMessage` → `msg.reply(...)`) لا يستدعي `safeFarmerSend`/`rateLimiter` إطلاقًا بالتصميم، فهو غير متأثر بنيويًا - القائمة الرئيسية، التسجيل، الاستفسار، الشكوى، إنشاء تذكرة، التحويل لموظف: كلها تعمل بشكل طبيعي 100% بصرف النظر عن حالة أي حملة (مؤكد بنيويًا في اختبار 23؛ لم يُختبر عبر محاكاة كاملة لرسالة WhatsApp واردة لأن ذلك يتطلب إعادة هيكلة `index.js` لأغراض الاختبار فقط - غير مبرر ضمن نطاق "أقل تعديل ممكن").

## 12) نتائج الاختبارات

| المجموعة | نجح | فشل |
|---|---|---|
| A–N + G2 (Part A) | 33 | 0 |
| Part B | 60 | 0 |
| Part C (Fail-Closed) | 24 | 0 |
| Updater + Campaign Inbox | 36 | 0 |
| القالب الموحّد | 29 | 0 |
| **تصنيف الرسائل + Rate Limiter (جديد، 1-28)** | **54** | **0** |
| **الإجمالي** | **236** | **0** |

صفر رسائل واتساب حقيقية (Fake Client في كل الاختبارات). `node --check` نجح على كل الملفات المعدّلة. تأكيد إضافي (اختبار 26): صفر مسار إرسال حملات جديد خارج `safeFarmerSend` - نفس النداءين السابقين فقط (موظفين/مديرين في `index.js`).
