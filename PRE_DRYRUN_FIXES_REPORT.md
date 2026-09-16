# تقرير إصلاحات ما قبل الإنتاج (قبل DRY RUN حقيقي)

لم تُضف أي Feature جديدة، UI، قاعدة بيانات، أو دعم Multi-process. التعديلات كلها داخل طبقة الأمان/المنطق الموجودة فعلًا.

## 1) الملفات التي عُدّلت

| الملف | التعديل |
|---|---|
| `lib/farmerState.js` | `load()` بات Fail-Closed (يرمي `FARMER_STATE_UNAVAILABLE` بدل إرجاع `{}`)؛ `isApplicationStale` يرجع `{stale, reason}` بدل boolean خام، مع توثيق `STALE_APPLICATION_UNVERIFIED` |
| `lib/safeFarmerSend.js` | إعادة ترتيب الخطوات (DRY_RUN قبل Rate Limiter)؛ لقط `FARMER_STATE_UNAVAILABLE` في خطوتي الحالة وStale وحظر فورًا؛ `sentTrackerKey()` لتحديد مفتاح sentTracker حسب نوع الحملة |
| `index.js` | أمر "حالة المزارع" بات يلقط خطأ `FARMER_STATE_UNAVAILABLE` برسالة واضحة للمحرر بدل ما يفشل بصمت |
| `scripts/testStateSafetyEngineV3.js` (جديد) | 24 اختبار جديد: A–H بالكامل |

لم يتم تعديل `lib/campaignRules.js`, `lib/sentTracker.js`, `lib/sendFingerprint.js`, `lib/rateLimiter.js`, `lib/campaignBuilder.js`, `lib/campaignRunner.js`, `lib/personalizedRunner.js`, `lib/portalSync.js` - شغّالين زي ما هم، والإصلاح اتعمل حصرًا في نقطة العبور `safeFarmerSend` ومصدر الحالة `farmerState`.

## 2) ماذا أُصلح في كل نقطة

**1. Farmer State Fail-Closed**: لو `farmer_state.json` والنسخة الاحتياطية اتنينهم تالفين، `load()` بترمي استثناء `FARMER_STATE_UNAVAILABLE` (مش `{}`). `safeFarmerSend` بيلقط الاستثناء ده في فحص الحالة **وفحص Stale Application** (الاتنين بيعتمدوا على `farmerState.getState`) ويرجع `blocked_by_state` فورًا - صفر إرسال، صفر اعتبار للمزارع كـUNKNOWN. باقي وظائف البوت (التذاكر، المحادثة العامة، الإحصائيات اللي مالهاش علاقة بالحالة) غير متأثرة لأنها مالهاش اعتماد على `farmerState` أصلًا.

**2. DRY_RUN لا يستهلك Rate Limit**: تم نقل فحص `DRY_RUN` ليصبح *قبل* `rateLimiter.checkAndReserve()` مباشرة (كان بعده غلط). الترتيب النهائي مفصّل في البند 3.

**3. Stale Application**: راجعت الافتراض - التفاصيل والدليل الكامل في البند 5. القرار: الإبقاء على المقارنة الرقمية (عشان منكسرش الحماية الموجودة) لكن توثيق كل قرار اعتمد عليها بـ`reason: "STALE_APPLICATION_UNVERIFIED"` صريح في الـreturn value والـAudit Log، بدل تقديمه كحقيقة مؤكدة 100%.

**4. sentTracker Legacy**: القواعد النهائية والتفاصيل في البند 6. التغيير الجوهري: `documents_request` و`registration_status` بقى مفتاح التكرار بتاعهم `phone#applicationId` (لو `applicationId` متوفر) بدل `phone` بس - طلب جديد للمزارع متبعت له حملة من النوع ده لطلب سابق مختلف، مبقاش بيتمنع غلط.

## 3) الترتيب النهائي لـ`safeFarmerSend`

```
1. تطبيع رقم الجوال + تحقق الصلاحية                         → invalid_phone
2. فحص الحالة (Purpose أو campaignType القديم)
   - لو Farmer State معطوب → blocked_by_state (FARMER_STATE_UNAVAILABLE)
   - لو الحالة ممنوعة → blocked_by_state
3. فحص Stale Application (لو فيه applicationId)
   - لو Farmer State معطوب → blocked_by_state (FARMER_STATE_UNAVAILABLE)
   - لو الطلب قديم → blocked_stale_application
4. فحص sentTracker القديم (لو فيه campaignType) - مفتاح حسب النوع (انظر بند 6) → duplicate
5. حجز بصمة عامة (Global Fingerprint)                        → duplicate
6. DRY_RUN check → would_send (تحرير البصمة، بدون استهلاك Rate Limit، بدون SENT)
7. Rate Limiter (بعد كل ما فوق فقط)                          → rate_limited
8. الإرسال الفعلي (Retry + Backoff) → sent / failed / not_on_whatsapp
```

## 4) كيف أصبح Farmer State Fail-Closed

`lib/farmerState.js`'s `load()`: يجرّب الملف الأساسي، ثم النسخة الاحتياطية، وفقط لو الاتنين تالفين يرمي:
```
FARMER_STATE_UNAVAILABLE: تعذّر استرجاع أي نسخة سليمة من farmer_state.json (والنسخة الاحتياطية كمان تالفة)...
```
`safeFarmerSend` يلقط هذا الاستثناء في كل نقطة تعتمد على الحالة (فحص الحالة + فحص Stale Application) ويرجع `{status: "blocked_by_state", reason: "FARMER_STATE_UNAVAILABLE"}` فورًا - لا إرسال، لا افتراض UNKNOWN. مسجَّل في Audit Log بـ`decision: "BLOCKED_BY_STATE", reason: "FARMER_STATE_UNAVAILABLE"`. مُختبر في A/B/H (24/24 ناجحة).

## 5) هل applicationId في البوابة Sequential فعلًا؟

**لا يوجد دليل موحّد أو مؤكد رسميًا - الوضع مختلط حسب القسم**، بالتحقق المباشر من `lib/portalScraper.js`:

- **نماذج الدرافت (Draft Forms)**: `formNumber` النهائي بييجي من رابط صفحة التفاصيل نفسها: `detailPage.url().match(/requests\/(\d+)/)` (`portalScraper.js:520-521`) - ده Primary Key من قاعدة بيانات النظام، وده دليل معقول (مش مؤكد بتوثيق رسمي من البوابة) إنه تصاعدي حسب ترتيب الإنشاء، لأنه نمط معماري شائع (auto-increment ID).
- **البطاقات الجاهزة والطلبات قيد الطباعة (Pending Printing / Printed Cards)**: `formNumber` بييجي من نص أول خلية في جدول العرض فقط (`cells[0].innerText`, `portalScraper.js:91` و`189`) - **مفيش دليل كودي إنه نفس مساحة الترقيم** بتاعة الدرافت، ولا حتى دليل إنه تصاعدي فعليًا (ممكن يكون رقم صف/مرجع عرض بس).
- **مفيش تاريخ (createdAt/updatedAt) بيوصل مع الإشعار نفسه**: ملفات الـCSV اللي بتتبعت منها الرسائل الفعلية (`documents_request.csv`, `draft_forms.csv`, `registration_status.csv`) بتحمل `request_number` بس، مش أي تاريخ - فحتى لو خزّنّا تاريخ للحالة المخزّنة، معندناش تاريخ للطرف التاني (الإشعار الجديد) نقارنه بيه. تفعيل مقارنة حقيقية بالتاريخ يحتاج إضافة عمود تاريخ لملفات الـCSV دي - وده تغيير مخطط/سير عمل لسير عمل يدوي شغال حاليًا (`documents_request` أصلًا `needsRequestNumber: false` بالتصميم، `index.js:935`)، فمش عملته عمدًا التزامًا بـ"لا تعِد بناء أي جزء يعمل".

**القرار**: المقارنة الرقمية فضلت شغالة (منعًا لكسر الحماية الموجودة المُختبرة)، لكنها موسومة دايمًا بـ`reason: "STALE_APPLICATION_UNVERIFIED"` في القيمة المرجعة والـAudit Log كل ما تتخذ قرار حظر بناءً عليها - بدل تقديمها كحقيقة مؤكدة. أي قرار مستقبلي بتفعيل مقارنة بالتاريخ فعليًا يحتاج أولًا إضافة عمود تاريخ لملفات الإرسال، وهو قرار سير عمل يرجع لك.

## 6) القواعد النهائية: sentTracker مقابل Global Fingerprint

**Global Fingerprint** (`sendFingerprint.js`, بدون تغيير) هو المسؤول دايمًا عن: *نفس الرقم + نفس نص الرسالة المطبّع بالحرف* - مفعّل لكل أنواع الإرسال بدون استثناء، ومينفعش يتعدّى (مُختبر في F).

**sentTracker القديم** (مفتاح الإرسال "مرة واحدة" حسب `campaignType`) - مُفعّل فقط للحملات التالية (عبر `campaignType` - الحملات المخصّصة المرفوعة بـ`purpose` مش بتستخدمه خالص أصلًا):

| campaignType | القاعدة | السبب |
|---|---|---|
| `documents_request` | مرة واحدة **لكل `phone#applicationId`** (لو applicationId متوفر)، وإلا `phone` بس كاحتياط | طلب جديد لازم إشعاره يعدي حتى لو اتبعت إشعار نواقص لطلب سابق |
| `registration_status` | مرة واحدة **لكل `phone#applicationId`** (لو applicationId متوفر)، وإلا `phone` بس | إشعار حالة لطلب جديد لازم يعدي حتى لو اتبعت إشعار لطلب قديم |
| `card_pickup` | مرة واحدة لكل `phone` (بدون تغيير) | مفيش `request_number` في هذا التدفق حاليًا - نفس السلوك القديم محفوظ |
| `registration_invitation` | مرة واحدة لكل `phone` (بدون تغيير) | مفيش `request_number` في هذا التدفق حاليًا - نفس السلوك القديم محفوظ |
| `broadcast` / `custom_message` / غير محدّد | مرة واحدة لكل `phone` (بدون تغيير) | سلوك قديم محفوظ، خارج نطاق هذا الإصلاح |
| `GENERAL_NOTICE` / `SURVEY` / `EVALUATION` (عبر `purpose`) | **لا يُستخدم `sentTracker` خالص** | هذه الحملات بتبعت `purpose` بس من غير `campaignType` أصلًا (تأكدت من الكود: `campaignRunner.js` بيبعت `purpose` بس) - فالشرط `if (campaignType)` في `safeFarmerSend` بيتخطّاها بالكامل تلقائيًا |

ملحوظة هامة: `documents_request.csv` الحالي (التدفق اليدوي الفعلي) **لا يحمل `request_number`** بالتصميم (`needsRequestNumber: false`) - فالآلية الجديدة جاهزة وتعمل صح لما تتوفر applicationId (كما أُثبت في الاختبار E)، لكن التدفق اليدوي الحالي لسه بيرجع للمفتاح القديم (`phone` بس) لحد ما يتقرر ربط رقم الطلب بيه - قرار سير عمل مستقبلي، مش جزء من هذا الإصلاح.

## 7) نتائج الاختبارات Passed/Failed

| المجموعة | نجح | فشل |
|---|---|---|
| A–N (Part A) | 31 | 0 |
| 1–16 + محاكاتين (Part B) | 60 | 0 |
| A–H (هذا الإصلاح) | 24 | 0 |
| **الإجمالي** | **115** | **0** |

`node --check` نجح على كل الملفات المعدّلة/الجديدة. البحث الشامل عن `client.sendMessage` أكّد: نفس النداءين السابقين فقط (موظفين/مديرين، `index.js:161` و`602`) - صفر مسار جديد خارج `safeFarmerSend`. صفر رسائل واتساب حقيقية أثناء كل الاختبارات، وكل ملفات البيانات الحقيقية استُرجعت سليمة بعد كل تشغيلة.

## 8) أي مشكلة متبقية قبل Dry Run حقيقي على ملف مزارعين

- **لا توجد مشكلة حاجبة (Blocking) معروفة** تمنع تجربة DRY_RUN حقيقية الآن على أي ملف مزارعين.
- **تذكير تشغيلي**: لازم `DRY_RUN=true` يكون مضبوط في البيئة (`.env`/متغير النظام) قبل أي محاولة، وتأكد إنه `false` (أو غير موجود) قبل أي إرسال فعلي لاحق - مفيش تحقق إضافي في الكود يمنع تشغيل حقيقي بالغلط لو الموظف نسي يشيل المتغير، غير المراجعة اليدوية.
- **Stale Application لسه معتمد على افتراض رقمي غير مؤكد رسميًا** (بند 5) - القرار الحالي (الإبقاء عليه موسومًا) معقول لكنه ليس دليلًا قاطعًا؛ لو حملة معيّنة حسّاسة جدًا لتكرار إشعار لطلب قديم، يُفضّل مراجعة يدوية إضافية لحملات `documents_request`/`draft_reminder` الكبيرة قبل الإرسال الفعلي.
- **`documents_request.csv` اليدوي لسه من غير applicationId** - الحماية الجديدة (sentTracker حسب الطلب) جاهزة لكنها غير مفعّلة فعليًا لهذا التدفق المحدد لحد ما يتقرر إضافة عمود رقم الطلب له (قرار سير عمل يرجع لك، غير منفّذ عمدًا هنا).
- **عملية Node واحدة فقط لسه شرط أساسي** - كل آليات الحجز الذرّي (Fingerprint, Rate Limiter) مصممة لعملية واحدة بالتصميم، كما تم تأكيده في التقرير السابق.
