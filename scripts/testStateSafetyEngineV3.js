process.env.RATE_LIMIT_HOURLY = process.env.RATE_LIMIT_HOURLY || "1000";
process.env.RATE_LIMIT_DAILY = process.env.RATE_LIMIT_DAILY || "1000";
// اختبارات المرحلة التالتة (إصلاحات قبل DRY RUN حقيقي):
// A/B) Farmer State Fail-Closed (تلف الملف الأساسي + النسخة الاحتياطية معًا) → حظر كامل، صفر إرسال واتساب
// C/D) DRY_RUN ماتستهلكش Rate Limit، وإرسال حقيقي بعدها لنفس الرسالة يعمل طبيعي
// E/F/G) sentTracker القديم بقى يفرّق بين الطلبات (applicationId) بدل "مرة واحدة للأبد" الخاطئة،
//         مع الحفاظ الكامل على Global Fingerprint dedup (نفس الرسالة بالحرف = duplicate دايمًا)
// H) حملة حساسة للحالة (purpose) مع تعطّل مخزن الحالة بالكامل → حظر، صفر إرسال
// من غير أي رسالة واتساب حقيقية - نسخة احتياطية لكل ملفات البيانات الحقيقية واسترجاعها في النهاية
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = [
  "farmer_state.json",
  "farmer_state.json.bak",
  "tickets.json",
  "tickets.json.bak",
  "send_fingerprints.json",
  "send_fingerprints.json.bak",
  "handoff_state.json",
  "handoff_state.json.bak",
  "rate_limit_state.json",
  "sent_history.json",
  "sent_history.json.bak",
  "audit_log.jsonl",
];

function snapshotFiles() {
  const snapshot = {};
  DATA_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    snapshot[name] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  });
  return snapshot;
}
function restoreFiles(snapshot) {
  DATA_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    if (snapshot[name] === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, snapshot[name]);
    }
  });
}
function wipeTestFiles() {
  DATA_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
}

let passed = 0;
function check(label, condition) {
  assert(condition, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
}

function fakeClient(overrides = {}) {
  let callCount = 0;
  return {
    getNumberId: overrides.getNumberId || (async (phone) => ({ _serialized: `${phone}@c.us` })),
    sendMessage:
      overrides.sendMessage ||
      (async () => {
        callCount++;
        return true;
      }),
    _getCallCount: () => callCount,
  };
}

function readRateLimitCounters() {
  const p = path.join(ROOT, "rate_limit_state.json");
  if (!fs.existsSync(p)) return { hourCount: 0, dayCount: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return { hourCount: data.hourCount || 0, dayCount: data.dayCount || 0 };
  } catch {
    return { hourCount: 0, dayCount: 0 };
  }
}

const FARMER_STATE_FILE = path.join(ROOT, "farmer_state.json");
const FARMER_STATE_BACKUP = `${FARMER_STATE_FILE}.bak`;

function corruptFarmerStatePrimaryAndBackup() {
  fs.writeFileSync(FARMER_STATE_FILE, "{ هذا ليس JSON صحيح ###", "utf8");
  fs.writeFileSync(FARMER_STATE_BACKUP, "{ ده كمان تالف ###", "utf8");
}

async function run() {
  [
    "../lib/farmerState",
    "../lib/campaignRules",
    "../lib/sendFingerprint",
    "../lib/sentTracker",
    "../lib/safeFarmerSend",
    "../lib/rateLimiter",
    "../lib/auditLog",
  ].forEach((m) => delete require.cache[require.resolve(m)]);

  const farmerState = require("../lib/farmerState");
  const { safeFarmerSend } = require("../lib/safeFarmerSend");
  const auditLog = require("../lib/auditLog");

  console.log("=== A) تلف farmer_state.json + النسخة الاحتياطية معًا → حظر واضح (Fail-Closed) ===");
  {
    corruptFarmerStatePrimaryAndBackup();
    const client = fakeClient();
    const r = await safeFarmerSend(client, {
      phone: "966598100001",
      message: "رسالة تسجيل",
      purpose: "REGISTRATION",
    });
    check("A: النتيجة blocked_by_state", r.status === "blocked_by_state");
    check("A: السبب FARMER_STATE_UNAVAILABLE بالضبط", r.reason === "FARMER_STATE_UNAVAILABLE");
    check("A: صفر نداء sendMessage", client._getCallCount() === 0);

    const logs = auditLog.readAll();
    const found = logs.find(
      (e) => e.normalizedPhone === "966598100001" && e.reason === "FARMER_STATE_UNAVAILABLE"
    );
    check("A: مسجّل في Audit Log", !!found);
  }

  console.log("\n=== B) تعطّل Farmer State → صفر إرسال واتساب حقيقي حتى مع عدة أنواع حملات ===");
  {
    // لسه الملفين تالفين من الاختبار فوق - بنتأكد إن campaignType القديم وStale Application
    // (اللي برضه بيعتمدوا على farmerState.getState) بيتحظروا بنفس الصرامة، مش بس purpose
    corruptFarmerStatePrimaryAndBackup();
    const client = fakeClient();

    const r1 = await safeFarmerSend(client, {
      phone: "966598100002",
      message: "تذكير درافت",
      campaignType: "draft_reminder",
    });
    check("B: campaignType القديم اتحظر برضه", r1.status === "blocked_by_state" && r1.reason === "FARMER_STATE_UNAVAILABLE");

    const r2 = await safeFarmerSend(client, {
      phone: "966598100003",
      message: "نقص مستندات لطلب معيّن",
      campaignType: "documents_request",
      applicationId: "300",
    });
    check(
      "B: فحص Stale Application (اللي بيعتمد على farmerState برضه) اتحظر",
      r2.status === "blocked_by_state" && r2.reason === "FARMER_STATE_UNAVAILABLE"
    );

    check("B: صفر نداء sendMessage خلال الاختبار كله", client._getCallCount() === 0);
  }

  // من هنا فاضل، بنرجّع farmer_state.json لحالة سليمة فاضية عشان باقي الاختبارات تشتغل طبيعي
  if (fs.existsSync(FARMER_STATE_FILE)) fs.unlinkSync(FARMER_STATE_FILE);
  if (fs.existsSync(FARMER_STATE_BACKUP)) fs.unlinkSync(FARMER_STATE_BACKUP);

  console.log("\n=== C) DRY_RUN لا يستهلك Rate Limit quota ===");
  {
    process.env.DRY_RUN = "true";
    const before = readRateLimitCounters();
    const client = fakeClient();
    const r = await safeFarmerSend(client, {
      phone: "966598100004",
      message: "رسالة تجريبية DRY RUN",
      purpose: "SURVEY",
    });
    check("C: النتيجة would_send", r.status === "would_send");
    const after = readRateLimitCounters();
    check("C: عداد الساعة ما اتغيّرش", after.hourCount === before.hourCount);
    check("C: عداد اليوم ما اتغيّرش", after.dayCount === before.dayCount);
    check("C: صفر نداء sendMessage", client._getCallCount() === 0);
    process.env.DRY_RUN = "false";
  }

  console.log("\n=== D) DRY_RUN ثم إرسال حقيقي لنفس الرسالة → الإرسال الحقيقي يعمل طبيعي ===");
  {
    const phone = "966598100005";
    const message = "رسالة DRY RUN ثم حقيقي";

    process.env.DRY_RUN = "true";
    const r1 = await safeFarmerSend(fakeClient(), { phone, message, purpose: "SURVEY" });
    check("D: أول مرة (DRY RUN) would_send", r1.status === "would_send");
    process.env.DRY_RUN = "false";

    const client2 = fakeClient();
    const r2 = await safeFarmerSend(client2, { phone, message, purpose: "SURVEY" });
    check("D: الإرسال الحقيقي بعد DRY RUN نجح (sent)", r2.status === "sent");
    check("D: نداء sendMessage حصل فعليًا مرة واحدة", client2._getCallCount() === 1);
  }

  console.log("\n=== E) documents_request جديد بـapplicationId جديد لنفس المزارع → ما يتمنعش غلط ===");
  {
    const phone = "966598100006";
    const r1 = await safeFarmerSend(fakeClient(), {
      phone,
      message: "من فضلك أكمل مستنداتك لطلب #10",
      campaignType: "documents_request",
      applicationId: "10",
    });
    check("E: الإشعار الأول لطلب #10 اتبعت", r1.status === "sent");

    // طلب جديد تمامًا (#20) لنفس المزارع - نص رسالة مختلف فعليًا (رقم الطلب مختلف جوّه النص كمان)
    const r2 = await safeFarmerSend(fakeClient(), {
      phone,
      message: "من فضلك أكمل مستنداتك لطلب #20",
      campaignType: "documents_request",
      applicationId: "20",
    });
    check(
      "E: الإشعار التاني لطلب جديد (#20) اتبعت وما اتمنعش بسبب sentTracker القديم",
      r2.status === "sent"
    );
  }

  console.log("\n=== F) نفس الرسالة بالحرف لنفس الرقم → DUPLICATE (Global Fingerprint لسه شغالة) ===");
  {
    const phone = "966598100007";
    const message = "نفس الرسالة تمامًا";
    const r1 = await safeFarmerSend(fakeClient(), { phone, message, campaignType: "documents_request", applicationId: "30" });
    check("F: أول إرسال نجح", r1.status === "sent");

    const r2 = await safeFarmerSend(fakeClient(), { phone, message, campaignType: "documents_request", applicationId: "30" });
    check("F: نفس applicationId + نفس الرسالة بالحرف = duplicate", r2.status === "duplicate");

    // حتى لو applicationId مختلف، نفس نص الرسالة بالحرف لنفس الرقم لازم يتمنع برضه (Global Fingerprint
    // بتحمي بغض النظر عن التصنيف الداخلي - دي آخر خط دفاع مفيش حاجة تتخطّاه)
    const r3 = await safeFarmerSend(fakeClient(), { phone, message, campaignType: "documents_request", applicationId: "31" });
    check("F: نفس الرسالة بالحرف برضه = duplicate حتى لو applicationId مختلف (Fingerprint)", r3.status === "duplicate");
  }

  console.log("\n=== G) registration_status جديد صحيح (applicationId جديد) → ما يتمنعش بسبب status قديم ===");
  {
    const phone = "966598100008";
    const r1 = await safeFarmerSend(fakeClient(), {
      phone,
      message: "حالة طلبك #40: قيد المراجعة",
      campaignType: "registration_status",
      applicationId: "40",
    });
    check("G: إشعار الحالة الأول لطلب #40 اتبعت", r1.status === "sent");

    const r2 = await safeFarmerSend(fakeClient(), {
      phone,
      message: "حالة طلبك #50: تم القبول",
      campaignType: "registration_status",
      applicationId: "50",
    });
    check(
      "G: إشعار حالة جديد لطلب جديد (#50) اتبعت وما اتمنعش بمجرد إرسال status قديم قبل كده",
      r2.status === "sent"
    );
  }

  console.log("\n=== H) حملة حساسة للحالة (purpose) مع تعطّل كامل لمخزن الحالة → حظر، صفر إرسال ===");
  {
    corruptFarmerStatePrimaryAndBackup();
    const client = fakeClient();
    const r = await safeFarmerSend(client, {
      phone: "966598100009",
      message: "دعوة للتسجيل في الخدمة",
      purpose: "REGISTRATION",
    });
    check("H: النتيجة blocked_by_state", r.status === "blocked_by_state");
    check("H: السبب FARMER_STATE_UNAVAILABLE", r.reason === "FARMER_STATE_UNAVAILABLE");
    check("H: صفر نداء sendMessage", client._getCallCount() === 0);

    if (fs.existsSync(FARMER_STATE_FILE)) fs.unlinkSync(FARMER_STATE_FILE);
    if (fs.existsSync(FARMER_STATE_BACKUP)) fs.unlinkSync(FARMER_STATE_BACKUP);
  }

  console.log(`\n🎉 كل اختبارات المرحلة التالتة نجحت (${passed} اختبار). من غير أي رسالة واتساب حقيقية.`);
}

const snapshot = snapshotFiles();
wipeTestFiles();
run()
  .catch((err) => {
    console.log(`\n💥 فشل الاختبار: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreFiles(snapshot);
    console.log("\n♻️ تم استرجاع كل ملفات البيانات الحقيقية زي ما كانت قبل الاختبار.");
  });
