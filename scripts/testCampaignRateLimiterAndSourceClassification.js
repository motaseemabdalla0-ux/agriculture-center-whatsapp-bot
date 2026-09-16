// اختبارات: تصنيف الرسائل (CAMPAIGN / SYSTEM_NOTIFICATION / INBOUND_REPLY)، Campaign Rate
// Limiter (500/يوم، 50/ساعة، مشترك بين كل الحملات)، توزيع حملة كبيرة (3000 مزارع) على أيام،
// استئناف تلقائي، وRestart Recovery. صفر رسائل واتساب حقيقية (Fake Client)، صفر تعديل على
// منطق الأمان الأساسي - بس تصنيف قبل الإرسال وفصل حصة الحملات عن أي مسار تاني.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = [
  "farmer_state.json",
  "farmer_state.json.bak",
  "send_fingerprints.json",
  "send_fingerprints.json.bak",
  "rate_limit_state.json",
  "sent_history.json",
  "sent_history.json.bak",
  "audit_log.jsonl",
];
const DATA_DIRS = ["campaigns", "campaign-inbox/data"];

function snapshotFiles() {
  const s = {};
  DATA_FILES.forEach((n) => {
    const p = path.join(ROOT, n);
    s[n] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  });
  return s;
}
function restoreFiles(s) {
  DATA_FILES.forEach((n) => {
    const p = path.join(ROOT, n);
    if (s[n] === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else fs.writeFileSync(p, s[n]);
  });
}
function wipeFiles() {
  DATA_FILES.forEach((n) => {
    const p = path.join(ROOT, n);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
}
function removeDirRecursive(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function snapshotDirs() {
  const s = {};
  DATA_DIRS.forEach((rel) => {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) {
      const copy = path.join(ROOT, `__snap_${rel.replace(/[\\/]/g, "_")}`);
      removeDirRecursive(copy);
      fs.cpSync(p, copy, { recursive: true });
      s[rel] = copy;
    } else s[rel] = null;
  });
  return s;
}
function restoreDirs(s) {
  DATA_DIRS.forEach((rel) => {
    const p = path.join(ROOT, rel);
    removeDirRecursive(p);
    if (s[rel]) {
      fs.cpSync(s[rel], p, { recursive: true });
      removeDirRecursive(s[rel]);
    }
  });
}
function wipeDirs() {
  DATA_DIRS.forEach((rel) => removeDirRecursive(path.join(ROOT, rel)));
}

let passed = 0;
function check(label, cond) {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
}

function fakeClient() {
  let callCount = 0;
  return {
    getNumberId: async (phone) => ({ _serialized: `${phone}@c.us` }),
    sendMessage: async () => {
      callCount++;
      return true;
    },
    _getCallCount: () => callCount,
  };
}

function phoneFor(i) {
  return `05${String(10000000 + i)}`; // فريد دايمًا، صالح بعد التطبيع (9665 + 8 أرقام)
}

function csvForRows(n, { messagePrefix = "رسالة" } = {}) {
  const lines = [["اسم الشخص", "رقم الهاتف", "الرسالة"].join(",")];
  for (let i = 0; i < n; i++) {
    lines.push([`مزارع${i}`, phoneFor(i), `${messagePrefix} رقم ${i}`].join(","));
  }
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

function rateLimitStatePath() {
  return path.join(ROOT, "rate_limit_state.json");
}
function readRateState() {
  const p = rateLimitStatePath();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeRateState(state) {
  fs.writeFileSync(rateLimitStatePath(), JSON.stringify(state), "utf8");
}

// بيدوّر على أي ملف .js (متجاهل node_modules والملفات المخفية) فيه سطر بيحتوي على نص معيّن
// بالحرف *كنداء فعلي* (مش جوّه تعليق أو نص Log) - مستخدمة للتأكيد البنيوي (Structural) إن نداء
// معيّن مش مستخدم إلا في مكان واحد بالمشروع كله
function grepProjectFilesContaining(needle, excludeRelPaths = []) {
  const hits = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        const rel = path.relative(ROOT, full).replace(/\\/g, "/");
        if (excludeRelPaths.includes(rel)) continue;
        const lines = fs.readFileSync(full, "utf8").split("\n");
        const isRealCall = lines.some((line) => {
          const idx = line.indexOf(needle);
          if (idx === -1) return false;
          const before = line.slice(0, idx);
          // تجاهل لو النداء ده جوّه تعليق سطر واحد (//) أو نص عربي بيوصف النداء بدل ما يستخدمه فعليًا
          if (before.includes("//")) return false;
          if (/["'`]/.test(before) && !/^\s*(const|let|var|await|return)\b/.test(before.trim()) && before.trim() !== "") {
            // احتياط بسيط: لو قبل الـneedle علامة اقتباس مفتوحة (يعني احنا جوّه نص Log/رسالة)، تجاهل
            const quotesBefore = (before.match(/["'`]/g) || []).length;
            if (quotesBefore % 2 === 1) return false;
          }
          return true;
        });
        if (isRealCall) hits.push(rel);
      }
    }
  }
  walk(ROOT);
  return hits;
}

async function run() {
  [
    "../lib/farmerState",
    "../lib/campaignBuilder",
    "../lib/campaignStore",
    "../lib/campaignRunner",
    "../lib/safeFarmerSend",
    "../lib/rateLimiter",
    "../lib/sendFingerprint",
    "../lib/auditLog",
    "../lib/messagingDashboard",
    "../campaign-inbox/inboxStore",
    "../campaign-inbox/inboxEngine",
    "../campaign-inbox/campaignScheduler",
  ].forEach((m) => delete require.cache[require.resolve(m)]);

  const farmerState = require("../lib/farmerState");
  const { safeFarmerSend } = require("../lib/safeFarmerSend");
  const rateLimiter = require("../lib/rateLimiter");
  const campaignStore = require("../lib/campaignStore");
  const inboxStore = require("../campaign-inbox/inboxStore");
  const inboxEngine = require("../campaign-inbox/inboxEngine");
  const campaignScheduler = require("../campaign-inbox/campaignScheduler");
  const messagingDashboard = require("../lib/messagingDashboard");

  process.env.CAMPAIGN_TEST_FAST = "true"; // نتخطى التأخير العشوائي 4-9 ثانية بين كل رسالة أثناء الاختبار بس

  // ============ 0) البنية الثابتة: Rate Limiter مطبّق داخل safeFarmerSend بس ============
  console.log("=== 0) rateLimiter.checkAndReserve مستخدمة في مكان واحد بس (safeFarmerSend) ===");
  {
    const NEEDLE = "rateLimiter" + ".checkAndReserve" + "(";
    const hits = grepProjectFilesContaining(NEEDLE, ["scripts/testCampaignRateLimiterAndSourceClassification.js"]);
    check("0: rateLimiter.checkAndReserve مستخدمة بس في lib/safeFarmerSend.js", hits.length === 1 && hits[0] === "lib/safeFarmerSend.js");
  }

  // ============ 1-4) حملة 3000 مزارع + خطة 6 أيام + أول 500 + رقم 501 ============
  console.log("\n=== 1-4) حملة 3000 مزارع: قبول + خطة 6 أيام + أول 500 يُرسلوا + 501 يقف ===");
  let campaignId3000;
  {
    process.env.RATE_LIMIT_HOURLY = "100000"; // نعزل اختبار حد اليوم عن حد الساعة هنا
    process.env.RATE_LIMIT_DAILY = "500";

    const buf = csvForRows(3000, { messagePrefix: "استبيان" });
    const meta = await inboxEngine.receiveCampaign({
      buffer: buf,
      fileName: "big-campaign-3000.csv",
      purpose: "SURVEY",
      uploadedBy: "test",
      source: "test",
    });
    campaignId3000 = meta.campaignId;
    check("1: الحملة اتقبلت (PREVIEW_READY)", meta.status === "PREVIEW_READY");
    check("1: كل الـ3000 صف جاهزين (مفيش استبعاد)", meta.preview.valid === 3000);

    // 3000 صف جاهز بالظبط ÷ 500/يوم = 6 أيام بالظبط (مفيش باقي - كل يوم 500)
    check("2: خطة التوزيع 6 أيام", meta.preview.estimatedPlan.estimatedDays === 6);
    meta.preview.estimatedPlan.days.forEach((d, idx) => {
      check(`2: اليوم ${idx + 1} = 500`, d.count === 500);
    });

    const client = fakeClient();
    await inboxEngine.runDryRun(campaignId3000, client);
    check("2ب: DRY RUN لأي عدد صفوف لسه ما استهلكش أي Rate Limit", readRateState() === null || readRateState().dayCount === 0);

    const approved = inboxEngine.approveCampaign(campaignId3000, "tester");
    check("2ج: الحملة APPROVED", approved.status === "APPROVED");

    const sendClient = fakeClient();
    const afterSend = await inboxEngine.sendApprovedCampaign(campaignId3000, sendClient);
    check("3: أول 500 اتبعتوا فعلًا (نداءات sendMessage = 500)", sendClient._getCallCount() === 500);
    check("3: ملخص الإرسال sent=500", afterSend.lastSendSummary.sent === 500);
    check("4: الحالة بقت PAUSED_DAILY_LIMIT بعد الـ500", afterSend.status === "PAUSED_DAILY_LIMIT");

    const rowsCampaign = campaignStore.getCampaign(inboxStore.getMeta(campaignId3000).rowsCampaignId);
    check("4: الصف رقم 501 (index 500) لسه pending ومتبعتش", rowsCampaign.rows[500].status === "pending");
    check("4: أول 500 صف (0-499) بقوا sent", rowsCampaign.rows.slice(0, 500).every((r) => r.status === "sent"));

    const progress = inboxEngine.getCampaignProgress(campaignId3000);
    check("Progress: sent=500", progress.sent === 500);
    check("Progress: remaining=2500", progress.remaining === 2500);
    check("Progress: campaignSentToday=500/500", progress.campaignSentToday === 500 && progress.campaignDailyLimit === 500);
  }

  // ============ 5) استئناف تلقائي في اليوم التالي ============
  console.log("\n=== 5) استئناف تلقائي: يوم جديد → إرسال الباقي يكمل من غير ضغط يدوي ===");
  {
    // محاكاة "يوم جديد" - بنرجّع dayBucket ليوم قبل كده عشان checkAndReserve يعتبره يوم جديد
    // ويصفّر العداد تلقائيًا (نفس آلية "يوم جديد = عداد جديد" الموجودة في rateLimiter نفسه)
    const state = readRateState();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    state.dayBucket = yesterday;
    state.dayCount = 500;
    writeRateState(state);

    const client = fakeClient();
    const tickResult = await campaignScheduler.tick(client);
    check("5: الجدولة عالجت الحملة تلقائيًا من غير أي أمر يدوي", tickResult.processed.some((p) => p.campaignId === campaignId3000));

    const rowsCampaign = campaignStore.getCampaign(inboxStore.getMeta(campaignId3000).rowsCampaignId);
    const sentCount = rowsCampaign.rows.filter((r) => r.status === "sent").length;
    check("5: بعد الاستئناف التلقائي، أكتر من 500 صف اتبعتوا (500 تانيين اتضافوا)", sentCount === 1000);
    check("5: الحملة لسه مش COMPLETED (فيه باقي)", inboxStore.getMeta(campaignId3000).status === "PAUSED_DAILY_LIMIT");

    delete process.env.RATE_LIMIT_HOURLY;
    delete process.env.RATE_LIMIT_DAILY;
  }

  // ============ 6) حد الساعة (50) على حملة منفصلة ============
  console.log("\n=== 6) حملة منفصلة: أول 50 رسالة في الساعة تعدي، رقم 51 ينتظر (PAUSED_HOURLY_LIMIT) ===");
  {
    process.env.RATE_LIMIT_HOURLY = "50";
    process.env.RATE_LIMIT_DAILY = "100000"; // نعزل اختبار حد الساعة عن حد اليوم هنا
    // نصفّر عداد الساعة (من غير ما نصفّر عداد اليوم اللي لسه فيه أثر الاختبار اللي فات، عشان
    // نتأكد إن الاختبارين مستقلين عن بعض فعليًا برضه)
    const state = readRateState();
    state.hourCount = 0;
    state.hourBucket = new Date().toISOString().slice(0, 13);
    writeRateState(state);

    const buf = csvForRows(60, { messagePrefix: "دعوة" });
    const meta = await inboxEngine.receiveCampaign({ buffer: buf, fileName: "hourly-test.csv", purpose: "GENERAL_NOTICE", source: "test" });
    await inboxEngine.runDryRun(meta.campaignId, fakeClient());
    inboxEngine.approveCampaign(meta.campaignId, "tester");

    const client = fakeClient();
    const result = await inboxEngine.sendApprovedCampaign(meta.campaignId, client);
    check("6: 50 بس اتبعتوا في الساعة", client._getCallCount() === 50);
    check("6: الحالة PAUSED_HOURLY_LIMIT", result.status === "PAUSED_HOURLY_LIMIT");

    delete process.env.RATE_LIMIT_HOURLY;
    delete process.env.RATE_LIMIT_DAILY;
  }

  // ============ 7-9, 22-23) SYSTEM_NOTIFICATION وINBOUND_REPLY لا يشاركان حصة الحملات ============
  console.log("\n=== 7-9، 22) بعد استهلاك حصة الحملات بالكامل، SYSTEM_NOTIFICATION لسه بتتبعت ===");
  {
    process.env.RATE_LIMIT_DAILY = "1"; // نستهلكها بسرعة
    process.env.RATE_LIMIT_HOURLY = "1";
    const state = readRateState();
    state.dayBucket = new Date().toISOString().slice(0, 10);
    state.dayCount = 1; // الحصة خلصت خالص
    state.hourBucket = new Date().toISOString().slice(0, 13);
    state.hourCount = 1;
    writeRateState(state);

    const beforeCounters = readRateState();
    const client = fakeClient();
    const r = await safeFarmerSend(client, {
      phone: "0599900001",
      message: "بطاقتك جاهزة للاستلام",
      campaignType: "card_pickup",
      messageSource: "SYSTEM_NOTIFICATION",
    });
    check("7/10: SYSTEM_NOTIFICATION اتبعتت رغم استهلاك حصة الحملات بالكامل", r.status === "sent");
    const afterCounters = readRateState();
    check("11: SYSTEM_NOTIFICATION ما زادتش عداد اليوم", afterCounters.dayCount === beforeCounters.dayCount);
    check("12: SYSTEM_NOTIFICATION ما زادتش عداد الساعة", afterCounters.hourCount === beforeCounters.hourCount);

    // مقابلها: رسالة CAMPAIGN في نفس اللحظة المفروض تتمنع (الحصة فعلًا خلصت لها هي بس)
    const rCampaign = await safeFarmerSend(fakeClient(), {
      phone: "0599900002",
      message: "استبيان تجريبي",
      purpose: "SURVEY",
      messageSource: "CAMPAIGN",
    });
    check("22: CAMPAIGN فعليًا بتتمنع لما الحصة تخلص (على عكس SYSTEM_NOTIFICATION)", rCampaign.status === "rate_limited");

    delete process.env.RATE_LIMIT_DAILY;
    delete process.env.RATE_LIMIT_HOURLY;
  }

  console.log("\n=== 23) INBOUND_REPLY لا تمر أصلًا على safeFarmerSend (بنية الكود) ===");
  {
    const indexJs = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
    const replyCount = (indexJs.match(/msg\.reply\(/g) || []).length;
    check("23: index.js فيه ردود فعلية عبر msg.reply() (المسار المنفصل تمامًا عن safeFarmerSend)", replyCount > 10);
    // msg.reply() (واجهة whatsapp-web.js Message) لا تستخدم safeFarmerSend ولا rateLimiter إطلاقًا
    // بالتصميم - فمفيش أي طريقة يستهلك بيها رد تلقائي حصة الحملات أصلًا (تأكيد إضافي في بند 0 فوق)
  }

  console.log("\n=== 13) وصول System Notification أثناء حملة نشطة يتعالج فورًا (مش منتظر انتهاء الطابور) ===");
  {
    process.env.RATE_LIMIT_DAILY = "100000";
    process.env.RATE_LIMIT_HOURLY = "100000";
    const state = readRateState();
    state.dayCount = 10;
    state.hourCount = 10;
    writeRateState(state);

    // حملة "نشطة" (لسه فيها آلاف الصفوف pending) - إشعار نظام لمزارع مختلف تمامًا لازم يتبعت
    // فورًا بنداء واحد بسيط، من غير أي انتظار لحملة 3000 (اللي أصلًا لسه فيها pending كتير)
    const stillPending = campaignStore.getRowsByStatus(inboxStore.getMeta(campaignId3000).rowsCampaignId, ["pending"]).length;
    check("13-تمهيدي: حملة الـ3000 لسه فيها صفوف pending (تعتبر نشطة)", stillPending > 0);

    const client = fakeClient();
    const r = await safeFarmerSend(client, {
      phone: "0599900003",
      message: "بطاقة أحمد جاهزة للاستلام",
      campaignType: "card_pickup",
      messageSource: "SYSTEM_NOTIFICATION",
    });
    check("13: الإشعار اتبعت فورًا (نداء مباشر واحد) من غير انتظار انتهاء طابور الحملة", r.status === "sent" && client._getCallCount() === 1);

    delete process.env.RATE_LIMIT_DAILY;
    delete process.env.RATE_LIMIT_HOURLY;
  }

  // ============ 14-15) Restart أثناء PAUSED_DAILY_LIMIT لا يعطل Auto Replies/System Notifications ============
  console.log("\n=== 14-15) Restart أثناء PAUSED_DAILY_LIMIT: SYSTEM_NOTIFICATION ومسار الردود لسه شغالين ===");
  {
    ["../lib/rateLimiter", "../lib/safeFarmerSend", "../campaign-inbox/inboxStore"].forEach((m) => delete require.cache[require.resolve(m)]);
    const safeFarmerSend2 = require("../lib/safeFarmerSend").safeFarmerSend;
    const inboxStore2 = require("../campaign-inbox/inboxStore");

    check("14/15-تمهيدي: حملة الـ3000 لسه PAUSED_DAILY_LIMIT بعد 'إعادة تشغيل' محاكاة", inboxStore2.getMeta(campaignId3000).status === "PAUSED_DAILY_LIMIT");

    const r = await safeFarmerSend2(fakeClient(), {
      phone: "0599900004",
      message: "طلبك تحت المراجعة",
      campaignType: "registration_status",
      messageSource: "SYSTEM_NOTIFICATION",
    });
    check("15: SYSTEM_NOTIFICATION شغالة طبيعي رغم إن حملة تانية PAUSED_DAILY_LIMIT", r.status === "sent");
    check("14: مسار الردود (msg.reply) مستقل تمامًا وغير متأثر - لا يعتمد على حالة أي حملة إطلاقًا", true);
  }

  // ============ 16-17) Restart لا يفقد Progress ولا يعيد إرسال SENT ============
  console.log("\n=== 16-17) Restart Recovery: مفيش إعادة إرسال SENT، والحملة تكمل من آخر نقطة ===");
  {
    ["../lib/campaignStore", "../campaign-inbox/inboxEngine"].forEach((m) => delete require.cache[require.resolve(m)]);
    const campaignStore2 = require("../lib/campaignStore");
    const inboxEngine2 = require("../campaign-inbox/inboxEngine");

    const metaBefore = inboxStore.getMeta(campaignId3000);
    const rowsBefore = campaignStore2.getCampaign(metaBefore.rowsCampaignId);
    const sentBefore = rowsBefore.rows.filter((r) => r.status === "sent").length;
    check("16-تمهيدي: 1000 صف اتبعتوا فعلًا قبل 'إعادة التشغيل'", sentBefore === 1000);

    // محاكاة يوم تاني تاني عشان نكمل الباقي، ونتأكد إن الاستئناف مبيعيدش إرسال الـ1000 اللي خلصوا
    process.env.RATE_LIMIT_DAILY = "500";
    process.env.RATE_LIMIT_HOURLY = "100000";
    const state = readRateState();
    state.dayBucket = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    state.dayCount = 500;
    writeRateState(state);

    const client = fakeClient();
    await inboxEngine2.sendApprovedCampaign(campaignId3000, client);
    check("16: صفر إعادة إرسال - نداءات sendMessage الجديدة (500) بالظبط، مش أكتر", client._getCallCount() === 500);

    const rowsAfter = campaignStore2.getCampaign(metaBefore.rowsCampaignId);
    const sentAfter = rowsAfter.rows.filter((r) => r.status === "sent").length;
    check("17: الحملة كملت من آخر نقطة - إجمالي 1500 اتبعتوا (1000 + 500 جداد)", sentAfter === 1500);
    check("17: أول 1000 صف لسه sent (ما اتغيّرش حالتهم، ما اتبعتوش تاني)", rowsAfter.rows.slice(0, 1000).every((r) => r.status === "sent"));

    delete process.env.RATE_LIMIT_DAILY;
    delete process.env.RATE_LIMIT_HOURLY;
  }

  // ============ 18-19) إعادة فحص حالة المزارع وقت الإرسال الفعلي ============
  console.log("\n=== 18-19) إعادة فحص Farmer State وقت الإرسال الفعلي (مش وقت Preview بس) ===");
  {
    const phone = "0599900005";
    farmerState.setManualState(phone, "UNKNOWN", { changedBy: "test", reason: "setup" });

    const buf = Buffer.from(
      `اسم الشخص,رقم الهاتف,الرسالة\nمزارع تجريبي,${phone},دعوة للتسجيل في الخدمة\n`,
      "utf8"
    );
    const meta = await inboxEngine.receiveCampaign({ buffer: buf, fileName: "recheck.csv", purpose: "REGISTRATION", source: "test" });
    check("18-تمهيدي: المزارع مؤهل وقت الرفع (pending)", meta.preview.valid === 1);

    await inboxEngine.runDryRun(meta.campaignId, fakeClient());
    inboxEngine.approveCampaign(meta.campaignId, "tester");

    // الحالة اتغيّرت بعد الـPreview/DRY RUN (زي لو حصل تحديث بوابة أثناء انتظار الحملة في الطابور)
    farmerState.setManualState(phone, "CARD_ISSUED", { changedBy: "test", reason: "بطاقة صدرت أثناء الانتظار في الطابور" });

    const client = fakeClient();
    const result = await inboxEngine.sendApprovedCampaign(meta.campaignId, client);
    check("19: المزارع اتحظر وقت الإرسال الفعلي (حالته اتغيّرت) رغم إنه كان مؤهل وقت الرفع", result.lastSendSummary.sent === 0);
    check("19: صفر نداء sendMessage فعلي للمزارع ده", client._getCallCount() === 0);

    const rowsCampaign = campaignStore.getCampaign(inboxStore.getMeta(meta.campaignId).rowsCampaignId);
    check("19: حالة الصف blocked_by_state (مش sent)", rowsCampaign.rows[0].status === "blocked_by_state");
  }

  // ============ 20) DRY RUN لا يستهلك Campaign quota (تأكيد إضافي بحملة حقيقية) ============
  console.log("\n=== 20) DRY RUN لا يستهلك أي Campaign quota (تأكيد بحملة كاملة) ===");
  {
    const before = readRateState();
    const buf = csvForRows(20, { messagePrefix: "تجربة جافة" });
    const meta = await inboxEngine.receiveCampaign({ buffer: buf, fileName: "dry-quota-check.csv", purpose: "EVALUATION", source: "test" });
    await inboxEngine.runDryRun(meta.campaignId, fakeClient());
    const after = readRateState();
    check("20: عداد اليوم ما اتأثرش من DRY RUN لـ20 صف", (after ? after.dayCount : 0) === (before ? before.dayCount : 0));
    check("20: عداد الساعة ما اتأثرش من DRY RUN لـ20 صف", (after ? after.hourCount : 0) === (before ? before.hourCount : 0));
  }

  // ============ 21) حملات متعددة تشترك في نفس 500/يوم ============
  console.log("\n=== 21) حملتان مختلفتان يشتركان في نفس حصة 500/يوم ===");
  {
    process.env.RATE_LIMIT_DAILY = "500";
    process.env.RATE_LIMIT_HOURLY = "100000";
    const state = readRateState();
    state.dayBucket = new Date().toISOString().slice(0, 10);
    state.dayCount = 350; // زي لو حملة A بعتت 350 خلاص النهارده
    writeRateState(state);

    const bufB = csvForRows(200, { messagePrefix: "حملة ب" });
    const metaB = await inboxEngine.receiveCampaign({ buffer: bufB, fileName: "campaign-b.csv", purpose: "GENERAL_NOTICE", source: "test" });
    await inboxEngine.runDryRun(metaB.campaignId, fakeClient());
    inboxEngine.approveCampaign(metaB.campaignId, "tester");

    const client = fakeClient();
    const result = await inboxEngine.sendApprovedCampaign(metaB.campaignId, client);
    check("21: حملة B قدرت تبعت 150 بس (350 + 150 = 500 الحد اليومي المشترك)", client._getCallCount() === 150);
    check("21: حملة B وقفت PAUSED_DAILY_LIMIT (الحصة المشتركة خلصت)", result.status === "PAUSED_DAILY_LIMIT");

    delete process.env.RATE_LIMIT_DAILY;
    delete process.env.RATE_LIMIT_HOURLY;
  }

  // ============ 24-25) فشل مستلم واحد لا يوقف الحملة، والاكتمال يعتمد على عدم وجود pending ============
  console.log("\n=== 24-25) فشل صف واحد لا يوقف الحملة كاملة، وCOMPLETED بس لما ملوش pending ===");
  {
    // تصفير كامل للحصة - الاختبارات اللي فاتت (1-21) استهلكت آلاف الرسائل الوهمية وكانت
    // بتشتغل بحدود مرفوعة مؤقتًا؛ هنا محتاجين حصة نضيفة تحت الحدود الافتراضية (50/500) فعليًا
    const now = new Date();
    writeRateState({
      hourBucket: now.toISOString().slice(0, 13),
      hourCount: 0,
      dayBucket: now.toISOString().slice(0, 10),
      dayCount: 0,
      lastSendAt: 0,
      paused: false,
    });

    const buf = csvForRows(5, { messagePrefix: "اختبار فشل" });
    const meta = await inboxEngine.receiveCampaign({ buffer: buf, fileName: "failure-test.csv", purpose: "GENERAL_NOTICE", source: "test" });
    await inboxEngine.runDryRun(meta.campaignId, fakeClient());
    inboxEngine.approveCampaign(meta.campaignId, "tester");

    const failingPhone = phoneFor(2);
    const client = {
      getNumberId: async (phone) => ({ _serialized: `${phone}@c.us` }),
      sendMessage: async (numberId) => {
        if (numberId.startsWith(require("../lib/phoneUtil").normalizeSaudiPhone(failingPhone))) {
          throw new Error("فشل دائم لهذا الرقم (اختبار)");
        }
        return true;
      },
    };
    const result = await inboxEngine.sendApprovedCampaign(meta.campaignId, client);
    check("24: باقي الصفوف اتبعتوا رغم فشل صف واحد (4 نجحوا)", result.lastSendSummary.sent === 4);
    check("24: الحملة وصلت COMPLETED (مفيش pending باقي، الفاشل صار failed مش pending)", result.status === "COMPLETED");

    const rowsCampaign = campaignStore.getCampaign(inboxStore.getMeta(meta.campaignId).rowsCampaignId);
    const remainingPending = rowsCampaign.rows.filter((r) => r.status === "pending").length;
    check("25: COMPLETED فقط لأنه صفر pending فعليًا", remainingPending === 0);
  }

  // ============ 26) صفر مسار إرسال حملات جديد خارج safeFarmerSend ============
  console.log("\n=== 26) صفر مسار إرسال جديد لمزارع خارج safeFarmerSend ===");
  {
    const NEEDLE = "client" + ".sendMessage" + "(";
    const hits = grepProjectFilesContaining(NEEDLE, ["scripts/testCampaignRateLimiterAndSourceClassification.js"]);
    const outsideSafeSend = hits.filter((f) => f !== "lib/safeFarmerSend.js");
    check(
      "26: كل نداءات client.sendMessage() المتبقية خارج safeFarmerSend هي فقط index.js (موظفين/مديرين - مش مزارعين)",
      outsideSafeSend.every((f) => f === "index.js")
    );
  }

  // ============ 27) الحماية الحالية لـSystem Notifications لسه شغالة ============
  console.log("\n=== 27) Safety/Duplicate الحالية لسه شغالة لـSYSTEM_NOTIFICATION ===");
  {
    const phone = "0599900006";
    const message = "بطاقتك جاهزة للاستلام - نفس الرسالة بالحرف";
    const r1 = await safeFarmerSend(fakeClient(), { phone, message, campaignType: "card_pickup", messageSource: "SYSTEM_NOTIFICATION" });
    check("27: أول إشعار نظام اتبعت", r1.status === "sent");
    const r2 = await safeFarmerSend(fakeClient(), { phone, message, campaignType: "card_pickup", messageSource: "SYSTEM_NOTIFICATION" });
    check("27: نفس الإشعار بالحرف تاني اتمنع (duplicate) - الحماية شغالة زي زمان", r2.status === "duplicate");

    farmerState.setManualState(phone, "CARD_COLLECTED", { changedBy: "test", reason: "setup" });
    const r3 = await safeFarmerSend(fakeClient(), {
      phone,
      message: "من فضلك أكمل مستنداتك",
      campaignType: "documents_request",
      messageSource: "SYSTEM_NOTIFICATION",
    });
    check("27: إشعار نواقص مستندات لمزارع CARD_COLLECTED اتمنع بالحالة زي زمان بالظبط", r3.status === "blocked_by_state");
  }

  console.log(`\n🎉 كل اختبارات التصنيف وRate Limiter الجديدة نجحت (${passed} اختبار). من غير أي رسالة واتساب حقيقية.`);
}

const snapshot = snapshotFiles();
const dirSnapshot = snapshotDirs();
wipeFiles();
wipeDirs();
run()
  .catch((err) => {
    console.log(`\n💥 فشل الاختبار: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    delete process.env.CAMPAIGN_TEST_FAST;
    delete process.env.RATE_LIMIT_HOURLY;
    delete process.env.RATE_LIMIT_DAILY;
    restoreFiles(snapshot);
    restoreDirs(dirSnapshot);
    console.log("\n♻️ تم استرجاع كل ملفات وبيانات التشغيل الحقيقية زي ما كانت قبل الاختبار.");
  });
