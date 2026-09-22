// اختبارات المرحلة التانية: Campaign Purpose الإلزامي، Preview تفصيلي، DRY RUN، Stale
// Application، Retry+Backoff، Audit Log، Ticket categories صريحة، Rate Limit مايتستهلكش
// من غير إرسال فعلي. + Simulation كاملة لرحلة مزارع من UNKNOWN لحد CARD_COLLECTED.
// من غير أي رسالة واتساب حقيقية - بيعمل نسخة احتياطية من ملفات البيانات الحقيقية ويرجّعها
// زي ما كانت في الآخر (نجح أو فشل).
// حدود Rate Limiter صريحة للاختبار، مستقلة عن القيم الافتراضية الحقيقية في lib/rateLimiter.js
process.env.RATE_LIMIT_HOURLY = process.env.RATE_LIMIT_HOURLY || "1000";
process.env.RATE_LIMIT_DAILY = process.env.RATE_LIMIT_DAILY || "1000";

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
  return {
    getNumberId: overrides.getNumberId || (async (phone) => ({ _serialized: `${phone}@c.us` })),
    sendMessage: overrides.sendMessage || (async () => true),
  };
}

async function run() {
  [
    "../lib/farmerState",
    "../lib/campaignRules",
    "../lib/sendFingerprint",
    "../lib/sentTracker",
    "../lib/safeFarmerSend",
    "../lib/rateLimiter",
    "../lib/ticketStore",
    "../lib/sessionStore",
    "../lib/campaignBuilder",
    "../lib/auditLog",
  ].forEach((m) => delete require.cache[require.resolve(m)]);

  const farmerState = require("../lib/farmerState");
  const sendFingerprint = require("../lib/sendFingerprint");
  const { safeFarmerSend } = require("../lib/safeFarmerSend");
  const rateLimiter = require("../lib/rateLimiter");
  const ticketStore = require("../lib/ticketStore");
  const { buildCampaignRows } = require("../lib/campaignBuilder");
  const campaignStore = require("../lib/campaignStore");
  const { sendCampaignRows } = require("../lib/campaignRunner");
  const auditLog = require("../lib/auditLog");

  console.log("=== 1) GENERAL_NOTICE + CARD_COLLECTED → ALLOW ===");
  {
    const phone = "966598000001";
    farmerState.setManualState(phone, "CARD_COLLECTED", { changedBy: "test", reason: "setup" });
    const r = await safeFarmerSend(fakeClient(), { phone, message: "إشعار عام للجميع", purpose: "GENERAL_NOTICE" });
    check("1: النتيجة sent (مش ممنوعة)", r.status === "sent");
  }

  console.log("\n=== 2) REGISTRATION + CARD_ISSUED → BLOCK ===");
  {
    const phone = "966598000002";
    farmerState.setManualState(phone, "CARD_ISSUED", { changedBy: "test", reason: "setup" });
    const r = await safeFarmerSend(fakeClient(), { phone, message: "ادعوك للتسجيل", purpose: "REGISTRATION" });
    check("2: النتيجة blocked_by_state", r.status === "blocked_by_state");
  }

  console.log("\n=== 3) Custom Campaign بدون Purpose → BLOCK ===");
  {
    const built = buildCampaignRows([{ name: "مزارع", phone: "966598000003", message: "رسالة" }], undefined);
    check("3: الحملة اترفضت كلها", built.rejected === true);
    check("3: السبب MISSING_CAMPAIGN_PURPOSE", built.reason === "MISSING_CAMPAIGN_PURPOSE");
    const builtInvalid = buildCampaignRows([{ name: "مزارع", phone: "966598000003", message: "رسالة" }], "NOT_A_REAL_PURPOSE");
    check("3ب: قيمة Purpose غير معروفة كمان بترفض", builtInvalid.rejected === true);
  }

  console.log("\n=== 4) CARD_ISSUED داخل ملف دعوة تسجيل → Excluded في Preview ===");
  {
    const phone = "966598000004";
    farmerState.setManualState(phone, "CARD_ISSUED", { changedBy: "test", reason: "setup" });
    const { rows } = buildCampaignRows([{ name: "مزارع", phone, message: "دعوة تسجيل" }], "REGISTRATION");
    const { summarizeCampaignRows } = require("../lib/campaignBuilder");
    const counts = summarizeCampaignRows(rows);
    check("4: excluded_card_issued = 1", counts.excluded_card_issued === 1);
    check("4: valid = 0", counts.valid === 0);
  }

  console.log("\n=== 5) نفس الرسالة لنفس الرقم بصيغ 05 / 966 / +966 → Duplicate واحد ===");
  {
    const msg = "رسالة اختبار توحيد الأرقام";
    const r1 = await safeFarmerSend(fakeClient(), { phone: "0598000005", message: msg, purpose: "GENERAL_NOTICE" });
    check("5: الصيغة المحلية 05 نجحت", r1.status === "sent");
    const r2 = await safeFarmerSend(fakeClient(), { phone: "966598000005", message: msg, purpose: "GENERAL_NOTICE" });
    check("5: نفس الرقم بصيغة 966 اتمنع (مكرر)", r2.status === "duplicate");
    const r3 = await safeFarmerSend(fakeClient(), { phone: "+966598000005", message: msg, purpose: "GENERAL_NOTICE" });
    check("5: نفس الرقم بصيغة +966 اتمنع كمان (مكرر)", r3.status === "duplicate");
  }

  console.log("\n=== 6) Documents Request لطلب قديم → BLOCK_STALE_APPLICATION ===");
  {
    const phone = "966598000006";
    // طلب #100 ناقص مستندات
    farmerState.upsertState(phone, "SUBMITTED", "portal:review", "100");
    // بعدين اتقدّم طلب جديد #105 واتقبل
    farmerState.upsertState(phone, "APPROVED", "portal:review", "105");

    const r = await safeFarmerSend(fakeClient(), {
      phone,
      message: "من فضلك استكمل مستندات طلبك #100",
      campaignType: "documents_request",
      applicationId: "100",
    });
    check("6: النتيجة blocked_stale_application", r.status === "blocked_stale_application");

    // نفس النوع بس على الطلب الصحيح الحالي (#105) المفروض يعدي عادي
    const r2 = await safeFarmerSend(fakeClient(), {
      phone,
      message: "متابعة طلبك #105",
      campaignType: "registration_status",
      applicationId: "105",
    });
    check("6ب: الطلب الحالي (#105) مش Stale", r2.status !== "blocked_stale_application");
  }

  console.log("\n=== 7) Ticket: شكوى → category=COMPLAINT ===");
  {
    const t = ticketStore.createTicket({ farmerName: "مزارع", phone: "966598000007", category: "COMPLAINT", message: "عندي مشكلة" });
    check("7: category=COMPLAINT محفوظة", ticketStore.getTicket(t.ticket_id).category === "COMPLAINT");
  }

  console.log("\n=== 8) Ticket: استفسار → category=INQUIRY ===");
  {
    const t = ticketStore.createTicket({ farmerName: "مزارع", phone: "966598000008", category: "INQUIRY", message: "عندي سؤال" });
    check("8: category=INQUIRY محفوظة", ticketStore.getTicket(t.ticket_id).category === "INQUIRY");
  }

  console.log("\n=== 9) BLOCKED message لا تستهلك Rate Limit ===");
  {
    const rateLimitFile = path.join(ROOT, "rate_limit_state.json");
    const readHourCount = () => (fs.existsSync(rateLimitFile) ? JSON.parse(fs.readFileSync(rateLimitFile, "utf8")).hourCount : 0);
    const beforeCount = readHourCount();

    const phone = "966598000009";
    farmerState.setManualState(phone, "CARD_ISSUED", { changedBy: "test", reason: "setup" });
    const r = await safeFarmerSend(fakeClient(), { phone, message: "دعوة تسجيل ممنوعة", purpose: "REGISTRATION" });
    check("9: النتيجة blocked_by_state فعلًا", r.status === "blocked_by_state");

    const afterCount = readHourCount();
    check("9: عداد الـRate Limit ما اتغيّرش بسبب رسالة ممنوعة", afterCount === beforeCount);
  }

  console.log("\n=== 10) DUPLICATE لا تستهلك Rate Limit ===");
  {
    const rateLimitFile = path.join(ROOT, "rate_limit_state.json");
    const readHourCount = () => JSON.parse(fs.readFileSync(rateLimitFile, "utf8")).hourCount;

    const phone = "966598000010";
    const msg = "رسالة لاختبار عدم استهلاك الحصة عند التكرار";
    await safeFarmerSend(fakeClient(), { phone, message: msg, purpose: "GENERAL_NOTICE" });
    const beforeCount = readHourCount();

    const r = await safeFarmerSend(fakeClient(), { phone, message: msg, purpose: "GENERAL_NOTICE" });
    check("10: النتيجة duplicate", r.status === "duplicate");

    const afterCount = readHourCount();
    check("10: عداد الـRate Limit ما اتغيّرش بسبب التكرار", afterCount === beforeCount);
  }

  console.log("\n=== 11) DRY_RUN لا يستدعي client.sendMessage ===");
  {
    process.env.DRY_RUN = "true";
    let called = 0;
    const client = fakeClient({ sendMessage: async () => { called++; return true; } });
    const r = await safeFarmerSend(client, { phone: "966598000011", message: "رسالة DRY RUN", purpose: "GENERAL_NOTICE" });
    check("11: النتيجة would_send", r.status === "would_send");
    check("11: client.sendMessage ماتناداش خالص", called === 0);
    process.env.DRY_RUN = "false";
  }

  console.log("\n=== 12) DRY_RUN لا يسجل الرسالة SENT ===");
  {
    process.env.DRY_RUN = "true";
    const phone = "966598000012";
    const msg = "رسالة DRY RUN تانية";
    await safeFarmerSend(fakeClient(), { phone, message: msg, purpose: "GENERAL_NOTICE" });
    process.env.DRY_RUN = "false";

    const fp = sendFingerprint.buildFingerprint(phone, msg);
    const entry = sendFingerprint.getEntry(fp);
    check("12: مفيش بصمة محفوظة كـSENT بعد DRY RUN", !entry || entry.status !== "SENT");

    // وبعد كده الإرسال الحقيقي لازم يشتغل عادي (مش متمنّع من الـDRY RUN اللي فات)
    const real = await safeFarmerSend(fakeClient(), { phone, message: msg, purpose: "GENERAL_NOTICE" });
    check("12ب: الإرسال الحقيقي بعد DRY RUN اشتغل عادي", real.status === "sent");
  }

  console.log("\n=== 13) Failed send لا يسجل fingerprint SENT ===");
  {
    const phone = "966598000013";
    const msg = "رسالة هتفشل";
    const client = fakeClient({ sendMessage: async () => { throw new Error("فشل شبكة دائم"); } });
    const r = await safeFarmerSend(client, { phone, message: msg, purpose: "GENERAL_NOTICE" });
    check("13: النتيجة failed", r.status === "failed");
    const fp = sendFingerprint.buildFingerprint(phone, msg);
    const entry = sendFingerprint.getEntry(fp);
    check("13: مفيش بصمة SENT بعد الفشل", !entry || entry.status !== "SENT");
  }

  console.log("\n=== 14) Retry ينجح في المحاولة الثانية → SENT مرة واحدة ===");
  {
    const phone = "966598000014";
    let attempts = 0;
    const client = fakeClient({
      sendMessage: async () => {
        attempts++;
        if (attempts === 1) throw new Error("فشل مؤقت");
        return true;
      },
    });
    const r = await safeFarmerSend(client, { phone, message: "رسالة تحتاج إعادة محاولة", purpose: "GENERAL_NOTICE" });
    check("14: النتيجة sent بعد إعادة المحاولة", r.status === "sent");
    check("14: اتحاول مرتين بالظبط (فشل ثم نجاح)", attempts === 2);
  }

  console.log("\n=== 15) CARD_COLLECTED manual override → Audit Record موجود ===");
  {
    const phone = "966598000015";
    farmerState.setManualState(phone, "CARD_ISSUED", { changedBy: "test", reason: "إصدار البطاقة" });
    farmerState.setManualState(phone, "CARD_COLLECTED", { changedBy: "staff:966501111111", reason: "تم تسليم البطاقة للمزارع يدويًا" });

    const entries = auditLog.readAll();
    const record = entries.find(
      (e) => e.decision === "MANUAL_STATE_CHANGE" && e.normalizedPhone === phone && e.extra && e.extra.newState === "CARD_COLLECTED"
    );
    check("15: فيه سجل Audit للتغيير اليدوي", !!record);
    check("15: الـreason محفوظ", record.extra.reason === "تم تسليم البطاقة للمزارع يدويًا");
    check("15: الـchangedBy محفوظ", record.extra.changedBy === "staff:966501111111");
    check("15: oldState محفوظة صح", record.extra.oldState === "CARD_ISSUED");

    // تصحيح عكسي لازم برضه يحتاج سبب - من غير سبب لازم يرمي خطأ
    let threw = false;
    try {
      farmerState.setManualState(phone, "CARD_ISSUED", { changedBy: "staff:966501111111" });
    } catch {
      threw = true;
    }
    check("15ب: تغيير يدوي من غير سبب اترفض", threw === true);
  }

  console.log("\n=== 16) Campaign Pause/Resume → لا يعيد الرسائل الناجحة ===");
  {
    const { rows } = buildCampaignRows(
      [
        { name: "واحد", phone: "966598000101", message: "رسالة 1" },
        { name: "اتنين", phone: "966598000102", message: "رسالة 2" },
        { name: "تلاتة", phone: "966598000103", message: "رسالة 3" },
      ],
      "GENERAL_NOTICE"
    );
    const campaignId = campaignStore.createCampaign({ label: "اختبار Pause/Resume", rows });

    // فشل دائم لرقم الصف التاني بس (مش عدد مرات النداء) - عشان آلية Retry الجديدة (بتحاول
    // 3 مرات) متعتبرش الفشل المؤقت نجاح بالغلط؛ الرقم ده هيفشل في كل الـ3 محاولات فعلًا
    const crashClient = fakeClient({
      sendMessage: async (numberId) => {
        if (numberId.startsWith("966598000102")) throw new Error("محاكاة توقف الحملة (فشل دائم لهذا الرقم)");
        return true;
      },
    });
    const summary1 = await sendCampaignRows(crashClient, campaignId);
    check("16: أول تشغيلة: 2 نجحوا و1 فشل", summary1.sent === 2 && summary1.failed === 1);

    // "استئناف" الحملة - بيعالج بس الصفوف المتبقية (مفيش صفوف pending فعليًا هنا لأن الفاشل
    // اتسجّل "failed" مش "pending" - فده يثبت إن المرة الجاية مش هتعيد إرسال أي حاجة تانية)
    let callAfterResume = 0;
    const resumeClient = fakeClient({ sendMessage: async () => { callAfterResume++; return true; } });
    const summary2 = await sendCampaignRows(resumeClient, campaignId);
    check("16ب: الاستئناف مبعتش أي رسالة تانية (مفيش pending باقي)", summary2.total === 0 && callAfterResume === 0);

    const finalCampaign = campaignStore.getCampaign(campaignId);
    check("16ج: الصفين اللي نجحوا فضلوا 'sent' من غير إعادة إرسال", finalCampaign.rows.filter((r) => r.status === "sent").length === 2);

    const cf = path.join(ROOT, "campaigns", `${campaignId}.json`);
    if (fs.existsSync(cf)) fs.unlinkSync(cf);
  }

  console.log("\n=== Simulation: رحلة مزارع كاملة UNKNOWN → CARD_COLLECTED ===");
  {
    const phone = "966598999000";
    const JOURNEY = ["INVITED", "DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "CARD_ISSUED"];
    // في كل مرحلة، بنحاول نبعت كل نوع إشعار ونتأكد إن البوت بيمنع اللي مايناسبش المرحلة دي
    const ATTEMPTS = [
      { purpose: "REGISTRATION", label: "دعوة تسجيل" },
      { purpose: "DOCUMENTS", label: "طلب مستندات" },
      { purpose: "CARD", label: "استلام البطاقة" },
    ];

    for (const stage of JOURNEY) {
      farmerState.upsertState(phone, stage, "portal:simulation");
      for (const attempt of ATTEMPTS) {
        const msg = `${attempt.label} - مرحلة ${stage} - ${Date.now()}-${Math.random()}`;
        const r = await safeFarmerSend(fakeClient(), { phone, message: msg, purpose: attempt.purpose });
        const currentState = farmerState.getState(phone).state;
        const { isPurposeBlocked } = require("../lib/campaignRules");
        const { blocked } = isPurposeBlocked(attempt.purpose, currentState);
        const expected = blocked ? "blocked_by_state" : "sent";
        check(`Journey[${stage}] ${attempt.purpose} -> ${expected}`, r.status === expected);
      }
    }

    // آخر خطوة: CARD_COLLECTED (يدوي بس - مفيش مصدر بوابة موثوق)
    farmerState.setManualState(phone, "CARD_COLLECTED", { changedBy: "test", reason: "محاكاة استلام البطاقة" });
    for (const attempt of ATTEMPTS) {
      const msg = `${attempt.label} - مرحلة CARD_COLLECTED - ${Date.now()}-${Math.random()}`;
      const r = await safeFarmerSend(fakeClient(), { phone, message: msg, purpose: attempt.purpose });
      const { isPurposeBlocked } = require("../lib/campaignRules");
      const { blocked } = isPurposeBlocked(attempt.purpose, "CARD_COLLECTED");
      const expected = blocked ? "blocked_by_state" : "sent";
      check(`Journey[CARD_COLLECTED] ${attempt.purpose} -> ${expected}`, r.status === expected);
    }

    check("Journey: الحالة النهائية CARD_COLLECTED", farmerState.getState(phone).state === "CARD_COLLECTED");
  }

  console.log("\n=== Simulation: نقص مستندات → استكمال → اعتماد → منع إشعار النواقص القديم ===");
  {
    const phone = "966598999001";
    // طلب #200: نقص مستندات (لسه SUBMITTED)
    farmerState.upsertState(phone, "SUBMITTED", "portal:review", "200");
    const r1 = await safeFarmerSend(fakeClient(), {
      phone,
      message: "من فضلك أكمل مستنداتك لطلب #200",
      campaignType: "documents_request",
      applicationId: "200",
    });
    check("Journey مستندات: إشعار النواقص الأول اتبعت عادي", r1.status === "sent");

    // المزارع كمّل مستنداته، الطلب اتقبل (نفس رقم الطلب #200 برضه - نفس الطلب اتحدّثت حالته)
    farmerState.upsertState(phone, "APPROVED", "portal:review", "200");

    // إشعار نواقص تاني لنفس رقم الطلب (applicationId واحد، فمفيش Stale، والحالة APPROVED مش
    // ممنوعة أصلًا لـdocuments_request حسب BLOCK_RULES الحالية). لكن sentTracker القديم (خطوة 3
    // في safeFarmerSend) بيمنع تكرار إرسال أي نوع حملة قديم لنفس الرقم مهما كان نص الرسالة،
    // فالمتوقع فعليًا "duplicate" (حماية زيادة، مش خطأ) - ده سلوك موجود من قبل ومش جزء من
    // المطلوب تعديله دلوقتي
    const r2 = await safeFarmerSend(fakeClient(), {
      phone,
      message: "من فضلك أكمل مستنداتك لطلب #200 (تاني)",
      campaignType: "documents_request",
      applicationId: "200",
    });
    check("Journey مستندات: إشعار نواقص تاني لنفس الرقم اتمنع كـduplicate (sentTracker القديم)", r2.status === "duplicate");

    // دلوقتي المزارع قدّم طلب جديد تمامًا #205
    farmerState.upsertState(phone, "SUBMITTED", "portal:review", "205"); // ملحوظة: SUBMITTED رانكها أقل من APPROVED فمش هتترقّي، بس applicationId هيتحدّث لو 205>200
    check("Journey مستندات: applicationId اتحدّث لـ205", farmerState.getState(phone).applicationId === "205");

    // إشعار نواقص قديم بيخص الطلب الأول #200 - لازم يتمنع كـStale (فيه طلب أحدث #205)
    const r3 = await safeFarmerSend(fakeClient(), {
      phone,
      message: "من فضلك أكمل مستنداتك لطلب #200 (قديم جدًا)",
      campaignType: "draft_reminder",
      applicationId: "200",
    });
    check("Journey مستندات: إشعار الطلب القديم #200 اتمنع BLOCK_STALE_APPLICATION", r3.status === "blocked_stale_application");
  }

  console.log(`\n🎉 كل اختبارات المرحلة التانية نجحت (${passed} اختبار). من غير أي رسالة واتساب حقيقية.`);
}

(async () => {
  const snapshot = snapshotFiles();
  wipeTestFiles();
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    console.error("\n💥 فشل الاختبار:", err.message, "\n", err.stack);
    process.exitCode = 1;
  } finally {
    restoreFiles(snapshot);
    console.log("\n♻️ تم استرجاع كل ملفات البيانات الحقيقية زي ما كانت قبل الاختبار.");
  }
})();
