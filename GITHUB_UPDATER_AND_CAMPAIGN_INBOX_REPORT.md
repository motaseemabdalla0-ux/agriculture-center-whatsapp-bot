# تقرير: نظام تحديث GitHub + صندوق استقبال الحملات (Campaign Inbox)

لم تُمس `safeFarmerSend.js`, `farmerState.js`, `sendFingerprint.js`, `sentTracker.js`, `rateLimiter.js` إطلاقًا. التعديل الوحيد داخل طبقة الحملات هو إضافة صغيرة اختيارية لـ`campaignBuilder.js` (فحص Stale Application وقت البناء لو الصف معاه applicationId - غير مفعّل إلا لو الملف المرفوع فيه عمود رقم طلب، فمفيش أي تأثير على أي حملة حالية).

## 1) Architecture الجديدة

```
Local Development / Claude Code
        │
        ▼
GitHub Private Repository (Releases/Tags: v1.0.0, v1.0.1...)
        │  (updater/cli.js: check → test → apply)
        ▼
updater_workdir/ (تحميل + فك ضغط + staging معزول تمامًا)
        │  node --check + كل اختبارات الأمان (V1+V2+V3) على staging فقط
        ▼
updater/codeSync.js (Allowlist: كود فقط) ──► المشروع الحقيقي
        │
        ▼
PM2 restart → updater/healthCheck.js (bot_heartbeat.json) → نجاح | ROLLBACK (updater/rollback.js)


Chat/Web/Local Folder ──► CampaignSourceAdapter (LocalCampaignAdapter الآن)
        │
        ▼
campaign-inbox/inboxEngine.js  (RECEIVED→VALIDATING→PREVIEW_READY→DRY_RUN_READY/AWAITING_APPROVAL→APPROVED→SENDING→COMPLETED/PAUSED/FAILED/REJECTED)
        │           │                    │
        │           ▼                    ▼
        │   lib/campaignBuilder.js   lib/campaignStore.js (نفسه بدون تعديل جوهري)
        │           │
        │           ▼
        │   lib/campaignRunner.js ──► lib/safeFarmerSend.js (نفسه بدون أي تعديل)
        │
        ▼
campaign-inbox/localServer.js (127.0.0.1 فقط - Local Upload Endpoint للاختبار)
```

الفصل الثلاثي الملتزم به: **GitHub = كود فقط** / **campaign-inbox/data = ملفات Excel/CSV + Metadata الحملة** / **جذر المشروع = بيانات التشغيل الحقيقية (Farmer State/Tickets/Dedup/Audit/جلسة واتساب)** - الثلاثة لا يختلطون في أي مسار كود.

## 2) الملفات الجديدة

**نظام التحديث (`updater/`)**: `config.js`, `versionState.js`, `githubClient.js`, `semver.js`, `extract.js`, `codeSync.js`, `npmInstall.js`, `safetyGate.js`, `restart.js`, `healthCheck.js`, `rollback.js`, `cli.js`

**صندوق الحملات (`campaign-inbox/`)**: `adapters/CampaignSourceAdapter.js`, `adapters/LocalCampaignAdapter.js`, `inboxStore.js`, `inboxEngine.js`, `localServer.js`

**اختبارات**: `scripts/testUpdaterAndInboxEngine.js` (36 اختبار جديد: 1-18 المطلوبة + محاكاتها الفرعية)

## 3) الملفات المعدّلة

| الملف | التعديل |
|---|---|
| `index.js` | إضافة سطرين: قراءة `BOT_VERSION` من `package.json`، وكتابة `bot_heartbeat.json` كل 30 ثانية بعد `ready` (لفحص الصحة بعد التحديث فقط - صفر تأثير على منطق الرد/الإرسال) |
| `lib/campaignBuilder.js` | إضافة اختيارية: لو الصف المرفوع معاه `applicationId`/`request_number`، يتفحص Stale Application وقت البناء (حالة جديدة `stale_application`)؛ لو مفيش، السلوك القديم 100% بدون تغيير |
| `package.json` | 4 أوامر جديدة: `update:check`, `update:test`, `update:apply`, `campaign-inbox` |

## 4) GitHub Update Flow

```
npm run update:check   → يعرض الإصدار الحالي/الأحدث ووجود تحديث - صفر تغيير في أي ملف
npm run update:test    → تحميل zipball الإصدار (من Releases API) → فك ضغط → نسخ الكود فقط
                          لمجلد staging معزول → node --check → 31+60+24 اختبار أمان → تقرير
                          نجاح/فشل. لا يلمس المشروع الحقيقي إطلاقًا مهما كانت النتيجة.
npm run update:apply   → نفس فحوصات update:test أولًا (ABORT فوري لو فشلت) → نسخة احتياطية
                          من الكود الحالي (updater_backups/) → نسخ الكود الجديد (Allowlist -
                          بيانات التشغيل غير متأثرة أبدًا) → npm install لو package.json تغيّر
                          → pm2 restart (لو PM2 متاح، وإلا توقف بأمان بعد التثبيت) → فحص صحة
                          (bot_heartbeat.json) → عند فشل إعادة التشغيل أو الصحة: ROLLBACK تلقائي
                          للنسخة السابقة + استرجاع رقم الإصدار القديم في update_state.json
```
Auto Update **غير مفعّل** - الثلاثة أوامر يدوية بالكامل، لا استدعاء تلقائي لأي منهم من داخل `index.js`.

## 5) Campaign Inbox Flow

```
Upload (LocalCampaignAdapter.submit / POST /campaigns/upload)
  → inboxEngine.receiveCampaign: تحقق الامتداد (.xlsx/.csv فقط) + الحجم (≤5MB) + عدد الصفوف
    (≤10000) + Purpose إلزامي (وإلا REJECTED: MISSING_CAMPAIGN_PURPOSE) + رسالة إلزامية
  → campaignBuilder.buildCampaignRows (نفس محرك الأمان الحالي - Purpose/State/Dedup/Stale)
  → PREVIEW_READY (مع summarizeCampaignRows + سبب استبعاد كل صف)
  → runDryRun: sendCampaignRows تحت DRY_RUN=true (نفس safeFarmerSend الحقيقي) → AWAITING_APPROVAL
  → approveCampaign (يرفض لو مفيش DRY RUN ناجح قبله) → APPROVED
  → sendApprovedCampaign: sendCampaignRows الحقيقية → SENDING → COMPLETED/PAUSED/FAILED
```
رفع الملف **لا يساوي** موافقة أبدًا - أي حملة تقف عند `AWAITING_APPROVAL` لحد ما حد يستدعي `approveCampaign` صراحةً.

## 6) كيف سيتم ربط ChatGPT لاحقًا

**لم يُبنَ أي اتصال فعلي مع ChatGPT/Claude Chat الآن** - مفيش Scraping ولا Browser Automation ولا Cookies. الجاهزية الوحيدة: عقد `CampaignSourceAdapter` (`campaign-inbox/adapters/CampaignSourceAdapter.js`) بميثود واحد إلزامي: `submit({buffer, fileName, purpose, campaignType, message, uploadedBy})`. أي تكامل مستقبلي حقيقي (مثلًا: ChatGPT Actions/Plugin رسمي يستدعي API معيّن، أو Webhook من خدمة ملفات) هيُبنى كـAdapter جديد يطبّق نفس العقد ده، من غير أي تغيير في `inboxEngine.js` أو محرك الأمان. القرار بخصوص القناة الفعلية (Actions؟ Webhook موقّع؟ API Key؟) يحتاج معلومات رسمية عن آلية OpenAI/Anthropic المتاحة وقتها - غير معروفة الآن، فمتقدّرش تُبنى بأمان بدون تخمين.

## 7) Local Endpoint المستخدم

خادم HTTP خفيف (built-in `http` - بدون مكتبة جديدة) على **`127.0.0.1:4010`** بس (قابل للتغيير عبر `CAMPAIGN_INBOX_PORT`):
```
POST /campaigns/upload?purpose=&type=&message=&uploadedBy=   (X-File-Name header, body = bytes الملف)
GET  /campaigns                       → قائمة كل الحملات
GET  /campaigns/:id                   → Metadata كاملة
GET  /campaigns/:id/preview           → المعاينة التفصيلية
GET  /campaigns/:id/dry-run           → تشغيل/عرض DRY RUN
POST /campaigns/:id/approve           → {approvedBy}
POST /campaigns/:id/reject
POST /campaigns/:id/send              → معطّل افتراضيًا (403 REAL_SEND_DISABLED) إلا لو ALLOW_REAL_SEND=true
```
تشغيله: `npm run campaign-inbox` (بعميل واتساب وهمي - مناسب لـPreview/DRY RUN بس محليًا).

## 8) Security Controls

- الخادم مربوط على `127.0.0.1` حصرًا - مفيش `0.0.0.0`، مفيش Port مفتوح للعالم.
- `ALLOW_REAL_SEND` افتراضيًا غير مضبوط (= false) - أي محاولة `/send` بترفض 403 بدون أي استثناء.
- `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO`/`PM2_PROCESS_NAME`/`ALLOW_REAL_SEND`/`CAMPAIGN_INBOX_PORT` كلها من `.env` فقط - صفر Secret مكتوب في الكود المصدري.
- `updater/githubClient.js` لا يطبع التوكن في أي Log تحت أي ظرف (Header بس، مش نص).
- الرفع بيرفض أي امتداد غير `.xlsx`/`.csv` وأي ملف أكبر من 5MB أو أكتر من 10000 صف - Error واضح بدل Crash.
- GitHub Update = Allowlist صارم لملفات الكود (`updater/codeSync.js`) - أي ملف بيانات تشغيلية (بما فيها `.env`, جلسة واتساب, campaign-inbox/data) محمي بالتصميم (مش بمجرد استبعاد يدوي قابل للنسيان).

## 9) مثال Upload

```bash
curl -X POST "http://127.0.0.1:4010/campaigns/upload?purpose=SURVEY&type=custom&message=استبيان%20تقييم%20الخدمة" \
  -H "X-File-Name: farmers.csv" --data-binary @farmers.csv
```
الرد:
```json
{ "campaignId": "inbox_1789465573515_a1b2c3", "status": "PREVIEW_READY", "rejectReason": null }
```

## 10) مثال Campaign Preview

```json
GET /campaigns/inbox_.../preview
{
  "status": "PREVIEW_READY",
  "preview": {
    "total": 50, "valid": 34, "invalid_phone": 2, "duplicate": 1,
    "already_received": 4, "excluded_active_application": 5,
    "excluded_card_issued": 3, "excluded_card_collected": 1, "stale_application": 0,
    "excludedRows": [{ "phone": "9665...", "status": "excluded_by_state", "reason": "..." }, ...]
  }
}
```

## 11) مثال DRY RUN

```json
GET /campaigns/inbox_.../dry-run
{
  "status": "AWAITING_APPROVAL",
  "dryRun": { "ranAt": "2026-09-15T...", "summary": { "total": 34, "sent": 0, "wouldSend": 34, "failed": 0 } }
}
```
صفر نداء `client.sendMessage`، صفر بصمة SENT، صفر استهلاك Rate Limit (مؤكد باختبارات 11/12).

## 12) نتائج الاختبارات Passed/Failed

| المجموعة | نجح | فشل |
|---|---|---|
| A–N (Part A) | 31 | 0 |
| Part B (Purpose/Preview/DRY RUN/Stale/Ticket v2) | 60 | 0 |
| Part C (Fail-Closed/DRY_RUN order/sentTracker rules) | 24 | 0 |
| **الجديد**: Updater (1-4) + Campaign Inbox (5-18) | 36 | 0 |
| **الإجمالي** | **151** | **0** |

`node --check` نجح على كل الملفات الجديدة/المعدّلة (18 ملف). بحث `client.sendMessage` أكّد: صفر مسار جديد خارج `safeFarmerSend` - نفس النداءين السابقين فقط (موظفين/مديرين).

## 13) ما الذي يعمل محليًا الآن

- `npm run update:check` / `update:test` تعمل بالكامل ضد أي Repository حقيقي (عام أو خاص بـtoken) - غير مجرَّبة هنا إلا بـfixture محلي مُصنَّع (zip حقيقي عبر PowerShell)، مش شبكة GitHub فعلية (لأن الريبو مش موجود/مربوط بعد).
- `update:apply` تعمل بالكامل محليًا **بدون PM2** (تنسخ الكود، توقف بأمان بعد التثبيت، بتقول صراحة "PM2 غير متاح").
- `npm run campaign-inbox` يعمل بالكامل - رفع، معاينة، DRY RUN، Approval، ورفض الإرسال الحقيقي (403) كلها مُختبرة فعليًا عبر HTTP حقيقي على 127.0.0.1.
- كل تدفق الحملة (Upload→Preview→DryRun→Approve) يمر فعليًا على `safeFarmerSend`/`farmerState`/`campaignBuilder` الحقيقيين - مش نسخة مصغّرة.

## 14) ما يحتاج إعدادًا عند الانتقال للسيرفر الحقيقي

- إنشاء الـGitHub Private Repository فعليًا، ودفع الكود الحالي إليه، وعمل أول Release/Tag (`v1.0.0`).
- إضافة `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN` (لو خاص), `PM2_PROCESS_NAME=agriculture-bot` إلى `.env` على السيرفر البعيد.
- التأكد إن PM2 على السيرفر معروف بنفس الاسم في `PM2_PROCESS_NAME`.
- تجربة `update:check`/`update:test` فعليًا على السيرفر (أو جهاز مطابق) ضد الريبو الحقيقي قبل أول `update:apply`.
- قرار لاحق: هل `campaign-inbox` الخادم المحلي يتشغّل كعملية منفصلة، أو يتكامل جوّه `index.js` نفسه (نفس Node Process) عشان `/send` يستخدم عميل واتساب الحقيقي بدل الوهمي - التكامل ده لم يُنفَّذ عمدًا الآن (نقطة `startLocalServer(realClient)` جاهزة لذلك من غير تغيير إضافي).
- تفعيل `ALLOW_REAL_SEND=true` فقط بعد اختبار كامل على السيرفر الفعلي، وبقرار واعٍ منك.

## 15) Secrets/Permissions التي سيحتاجها مسؤول السيرفر مرة واحدة فقط

- **GitHub Personal Access Token** (`repo` scope فقط، read-only يكفي لتنزيل الـReleases) - لو الـRepository خاص. يُحفظ في `.env` على السيرفر فقط، لا يُشارك، لا يُكتب في أي كود.
- **اسم عملية PM2** الحقيقي المستخدم على السيرفر (`pm2 list`) - عشان `PM2_PROCESS_NAME` يطابقه بالظبط.
- **صلاحية تنفيذ `pm2 restart`** من نفس المستخدم اللي هيشغّل `update:apply` (عادةً نفس مستخدم تشغيل البوت أصلًا - لا صلاحيات جديدة).
- لا حاجة لأي صلاحية شبكة إضافية (الخادم المحلي `127.0.0.1` بس، ومفيش Firewall/Port جديد مطلوب فتحه).
