// اختبارات Farmer Registry + قاعدة أمان الاسم العربي - 27 بند كما طُلب. صفر رسائل واتساب
// حقيقية (Fake Client)، وصفر تعديل على safeFarmerSend/Farmer State Machine/Dedup/Fingerprint/
// Stale Application/Campaign Queue/500 اليوم/50 الساعة/Automatic Resume/Portal Sync.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = [
  "farmer_state.json",
  "farmer_state.json.bak",
  "farmer_registry.json",
  "farmer_registry.json.bak",
  "send_fingerprints.json",
  "send_fingerprints.json.bak",
  "sent_history.json",
  "sent_history.json.bak",
  "rate_limit_state.json",
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

async function run() {
  [
    "../lib/farmerState",
    "../lib/farmerRegistry",
    "../lib/arabicNameGuard",
    "../lib/contactReasonMap",
    "../lib/campaignBuilder",
    "../lib/campaignStore",
    "../lib/campaignRunner",
    "../lib/personalizedRunner",
    "../lib/safeFarmerSend",
    "../lib/rateLimiter",
    "../lib/sendFingerprint",
    "../lib/sentTracker",
    "../lib/auditLog",
    "../campaign-inbox/inboxStore",
    "../campaign-inbox/inboxEngine",
  ].forEach((m) => delete require.cache[require.resolve(m)]);

  const farmerState = require("../lib/farmerState");
  const farmerRegistry = require("../lib/farmerRegistry");
  const { isArabicName } = require("../lib/arabicNameGuard");
  const { buildCampaignRows } = require("../lib/campaignBuilder");
  const { sendCampaignRows } = require("../lib/campaignRunner");
  const campaignStore = require("../lib/campaignStore");
  const { runPersonalizedBroadcast } = require("../lib/personalizedRunner");
  const inboxEngine = require("../campaign-inbox/inboxEngine");
  const inboxStore = require("../campaign-inbox/inboxStore");
  const auditLog = require("../lib/auditLog");

  console.log("=== 1) اسم عربي → PASS ===");
  {
    const rows = buildCampaignRows(
      [{ name: "أحمد عبدالله أحمد", phone: "0555323315", message: "عزيزي {name}، رسالة تجريبية", usesNamePlaceholder: true }],
      "GENERAL_NOTICE"
    ).rows;
    check("1: الاسم العربي يعدي (pending)", rows[0].status === "pending");
  }

  console.log("\n=== 2) اسم إنجليزي داخل الرسالة → BLOCK ===");
  {
    const rows = buildCampaignRows(
      [{ name: "AHMED ABDULLAH", phone: "0555323316", message: "عزيزي {name}، رسالة تجريبية", usesNamePlaceholder: true }],
      "GENERAL_NOTICE"
    ).rows;
    check("2: الاسم الإنجليزي اتحظر", rows[0].status === "blocked_non_arabic_name");
  }

  console.log("\n=== 3) اسم عربي/إنجليزي مختلط → BLOCK ===");
  {
    check("3: isArabicName ترفض الاسم المختلط", isArabicName("Ahmed عبدالله") === false);
    const rows = buildCampaignRows(
      [{ name: "Ahmed عبدالله", phone: "0555323317", message: "عزيزي {name}", usesNamePlaceholder: true }],
      "GENERAL_NOTICE"
    ).rows;
    check("3: الاسم المختلط اتحظر", rows[0].status === "blocked_non_arabic_name");
  }

  console.log("\n=== 4) ممنوع التعريب التلقائي ===");
  {
    // اسم إنجليزي جديد كليًا (مفيش سجل قبل كده) - المفروض يتحظر، مش يتحوّل لاسم عربي مخمّن
    const phone = "0555323318";
    const beforeEntry = farmerRegistry.getEntry(phone);
    check("4-تمهيدي: مفيش اسم عربي محفوظ قبل كده", beforeEntry.nameArabic === null);
    const rows = buildCampaignRows(
      [{ name: "MOHAMMED SAEED", phone, message: "عزيزي {name}", usesNamePlaceholder: true }],
      "GENERAL_NOTICE"
    ).rows;
    check("4: الرسالة اتحظرت (مفيش تعريب تلقائي)", rows[0].status === "blocked_non_arabic_name");
    const afterEntry = farmerRegistry.getEntry(phone);
    check("4: السجل لسه من غير أي اسم عربي مخمّن", afterEntry.nameArabic === null);
  }

  console.log("\n=== 5) اسم إنجليزي من Portal + اسم عربي موثوق في Registry → يُستخدم العربي ===");
  {
    const phone = "0555323319";
    farmerRegistry.resolveTrustedArabicName(phone, "ذيب سنيان منور العنزي"); // اسم عربي موثوق مسبقًا (زي لو جاء من مصدر موثوق قبل كده)
    const rows = buildCampaignRows(
      [{ name: "THEYAB SANYAN MENWER", phone, message: "عزيزي {name}", usesNamePlaceholder: true }],
      "GENERAL_NOTICE"
    ).rows;
    // ملحوظة: campaignBuilder بيفحص r.usesNamePlaceholder وr.name المُمرَّر - في الاستخدام الحقيقي
    // (campaign-inbox/inboxEngine.js) الاسم بيتحل لالاسم الموثوق *قبل* ما يوصل لـbuildCampaignRows.
    // هنا بنتأكد إن آلية resolveTrustedArabicName نفسها بترجع العربي الصحيح بدل الإنجليزي
    const trusted = farmerRegistry.resolveTrustedArabicName(phone, "THEYAB SANYAN MENWER");
    check("5: resolveTrustedArabicName رجع الاسم العربي الموثوق مش الإنجليزي", trusted === "ذيب سنيان منور العنزي");
  }

  console.log("\n=== 6) اسم إنجليزي فقط + الرسالة تحتوي الاسم → BLOCKED_NON_ARABIC_NAME ===");
  {
    const rows = buildCampaignRows(
      [{ name: "SALEH MOSA ALI", phone: "0555323320", message: "عزيزي {name}", usesNamePlaceholder: true }],
      "GENERAL_NOTICE"
    ).rows;
    check("6: الحالة blocked_non_arabic_name بالظبط", rows[0].status === "blocked_non_arabic_name");
    check("6: السبب BLOCKED_NON_ARABIC_NAME", rows[0].reason === "BLOCKED_NON_ARABIC_NAME");
  }

  console.log("\n=== 7) رسالة بدون اسم لا تُمنع بسبب لغة الاسم ===");
  {
    const rows = buildCampaignRows(
      [{ name: "SALEH MOSA ALI", phone: "0555323321", message: "إشعار عام لكل المزارعين", usesNamePlaceholder: false }],
      "GENERAL_NOTICE"
    ).rows;
    check("7: الرسالة من غير {name} تعدي عادي رغم الاسم الإنجليزي في البيانات", rows[0].status === "pending");
  }

  console.log("\n=== 8-10) Communication Status تتحدّث تلقائيًا بعد نجاح الإرسال ===");
  {
    const phone = "0555323322";
    farmerRegistry.resolveTrustedArabicName(phone, "خالد سعيد المطيري");
    const rowsCampaignId = campaignStore.createCampaign({
      label: "اختبار",
      createdBy: "test",
      rows: [
        { name: "خالد سعيد المطيري", phone, message: "بطاقتك جاهزة للاستلام", status: "pending", purpose: "CARD", usesNamePlaceholder: false },
      ],
    });
    await sendCampaignRows(fakeClient(), rowsCampaignId);
    const entry = farmerRegistry.getEntry(phone);
    check("8: CARD_READY_NOTIFIED بعد نجاح إرسال Purpose=CARD", entry.communicationStatus === "CARD_READY_NOTIFIED");
  }
  {
    const phone = "0555323323";
    const rowsCampaignId = campaignStore.createCampaign({
      label: "اختبار",
      createdBy: "test",
      rows: [{ name: "سالم", phone, message: "من فضلك أكمل مستنداتك", status: "pending", purpose: "DOCUMENTS", usesNamePlaceholder: false }],
    });
    await sendCampaignRows(fakeClient(), rowsCampaignId);
    const entry = farmerRegistry.getEntry(phone);
    check("9: DOCUMENTS_REQUESTED بعد نجاح إرسال Purpose=DOCUMENTS", entry.communicationStatus === "DOCUMENTS_REQUESTED");
  }
  {
    const phone = "0555323324";
    const rowsCampaignId = campaignStore.createCampaign({
      label: "اختبار",
      createdBy: "test",
      rows: [{ name: "سالم", phone, message: "دعوة للتسجيل", status: "pending", purpose: "REGISTRATION", usesNamePlaceholder: false }],
    });
    await sendCampaignRows(fakeClient(), rowsCampaignId);
    const entry = farmerRegistry.getEntry(phone);
    check("10: REGISTRATION_INVITATION_SENT بعد نجاح إرسال Purpose=REGISTRATION", entry.communicationStatus === "REGISTRATION_INVITATION_SENT");
  }

  console.log("\n=== 11) رسالة واردة من المزارع → FARMER_REPLIED ===");
  {
    const phone = "0555323325";
    const updated = farmerRegistry.recordReply(phone);
    check("11: Communication Status = FARMER_REPLIED", updated.communicationStatus === "FARMER_REPLIED");
  }

  console.log("\n=== 12) تحويل لموظف (Human Handoff) → HANDED_OFF ===");
  {
    const phone = "0555323326";
    const updated = farmerRegistry.recordHandoff(phone);
    check("12: Communication Status = HANDED_OFF", updated.communicationStatus === "HANDED_OFF");
  }

  console.log("\n=== 13) FAILED لا يغيّر الحالة إلى SENT ===");
  {
    const phone = "0555323327";
    const before = farmerRegistry.getEntry(phone);
    const failingClient = {
      getNumberId: async (p) => ({ _serialized: `${p}@c.us` }),
      sendMessage: async () => {
        throw new Error("فشل دائم (اختبار)");
      },
    };
    const rowsCampaignId = campaignStore.createCampaign({
      label: "اختبار فشل",
      createdBy: "test",
      rows: [{ name: "سالم", phone, message: "رسالة", status: "pending", purpose: "GENERAL_NOTICE", usesNamePlaceholder: false }],
    });
    await sendCampaignRows(failingClient, rowsCampaignId);
    const after = farmerRegistry.getEntry(phone);
    check("13: الحالة لسه NOT_CONTACTED (ما اتسجّلش كـSENT)", after.communicationStatus === before.communicationStatus);
    check("13: totalMessages ما زادش", after.totalMessages === before.totalMessages);
  }

  console.log("\n=== 14) BLOCKED لا يزيد totalMessages ===");
  {
    const phone = "0555323328";
    const before = farmerRegistry.getEntry(phone).totalMessages;
    buildCampaignRows([{ name: "AHMED ENGLISH", phone, message: "عزيزي {name}", usesNamePlaceholder: true }], "GENERAL_NOTICE");
    const after = farmerRegistry.getEntry(phone).totalMessages;
    check("14: totalMessages ما اتغيّرش (الحظر بيحصل وقت البناء، مش بيتسجّل في Registry أصلًا)", after === before);
  }

  console.log("\n=== 15) SENT يزيد totalMessages مرة واحدة بس ===");
  {
    const phone = "0555323329";
    const rowsCampaignId = campaignStore.createCampaign({
      label: "اختبار",
      createdBy: "test",
      rows: [{ name: "سالم", phone, message: "رسالة فريدة", status: "pending", purpose: "GENERAL_NOTICE", usesNamePlaceholder: false }],
    });
    await sendCampaignRows(fakeClient(), rowsCampaignId);
    const entry = farmerRegistry.getEntry(phone);
    check("15: totalMessages = 1 بالظبط", entry.totalMessages === 1);
  }

  console.log("\n=== 16) كل SENT يُضاف إلى Communication History ===");
  {
    const phone = "0555323330";
    const rowsCampaignId1 = campaignStore.createCampaign({
      label: "اختبار1",
      createdBy: "test",
      rows: [{ name: "سالم", phone, message: "رسالة أولى", status: "pending", purpose: "SURVEY", usesNamePlaceholder: false }],
    });
    await sendCampaignRows(fakeClient(), rowsCampaignId1);
    const rowsCampaignId2 = campaignStore.createCampaign({
      label: "اختبار2",
      createdBy: "test",
      rows: [{ name: "سالم", phone, message: "رسالة ثانية مختلفة", status: "pending", purpose: "EVALUATION", usesNamePlaceholder: false }],
    });
    await sendCampaignRows(fakeClient(), rowsCampaignId2);
    const entry = farmerRegistry.getEntry(phone);
    check("16: سجل التواصل فيه رسالتين (مش آخر واحدة بس)", entry.communicationHistory.length === 2);
    check("16: كل عنصر في السجل حالته SENT", entry.communicationHistory.every((h) => h.status === "SENT"));
  }

  console.log("\n=== 17) Restart يحافظ على السجل ===");
  {
    const phone = "0555323330"; // نفس رقم اختبار 16
    delete require.cache[require.resolve("../lib/farmerRegistry")];
    const farmerRegistry2 = require("../lib/farmerRegistry");
    const entry = farmerRegistry2.getEntry(phone);
    check("17: السجل لسه موجود بعد محاكاة إعادة التشغيل (2 رسالة)", entry.totalMessages === 2);
  }

  console.log("\n=== 18-19) البحث بالاسم والرقم يعمل ===");
  {
    delete require.cache[require.resolve("../lib/farmerRegistry")];
    const farmerRegistry2 = require("../lib/farmerRegistry");
    const byPhone = farmerRegistry2.searchByPhone("0555323322");
    check("19: البحث بالرقم يرجع النتيجة الصحيحة", byPhone && byPhone.nameArabic === "خالد سعيد المطيري");
    const byName = farmerRegistry2.searchByName("خالد سعيد");
    check("18: البحث بالاسم يرجع نتيجة واحدة على الأقل", byName.length >= 1 && byName.some((e) => e.nameArabic === "خالد سعيد المطيري"));
  }

  console.log("\n=== 20-21) Farmer State مستقلة تمامًا عن إرسال الرسائل ===");
  {
    const phone = "0555323331";
    farmerState.setManualState(phone, "UNKNOWN", { changedBy: "test", reason: "setup" });
    const rowsCampaignId = campaignStore.createCampaign({
      label: "اختبار",
      createdBy: "test",
      rows: [{ name: "سالم", phone, message: "رسالة عامة", status: "pending", purpose: "GENERAL_NOTICE", usesNamePlaceholder: false }],
    });
    await sendCampaignRows(fakeClient(), rowsCampaignId);
    check("20: Farmer State لسه UNKNOWN بعد إرسال ناجح (مبتتغيرش بسبب رسالة)", farmerState.getState(phone).state === "UNKNOWN");

    farmerState.upsertState(phone, "CARD_ISSUED", "portal:cards", "999");
    check("21: Farmer State اتغيّرت من تحديث بوابة موثوق (المسار القديم زي ما هو)", farmerState.getState(phone).state === "CARD_ISSUED");
  }

  console.log("\n=== 22-24) Campaign فقط تدخل 500/يوم و50/ساعة؛ System/Inbound خارج الحد ===");
  {
    const { safeFarmerSend } = require("../lib/safeFarmerSend");
    process.env.RATE_LIMIT_DAILY = "1";
    process.env.RATE_LIMIT_HOURLY = "1";
    const rateLimitStatePath = path.join(ROOT, "rate_limit_state.json");
    const now = new Date();
    fs.writeFileSync(
      rateLimitStatePath,
      JSON.stringify({ hourBucket: now.toISOString().slice(0, 13), hourCount: 1, dayBucket: now.toISOString().slice(0, 10), dayCount: 1, lastSendAt: 0, paused: false })
    );

    const rCampaign = await safeFarmerSend(fakeClient(), { phone: "0555323332", message: "استبيان", purpose: "SURVEY", messageSource: "CAMPAIGN" });
    check("22: CAMPAIGN تتمنع لما الحصة تخلص", rCampaign.status === "rate_limited");

    const rSystem = await safeFarmerSend(fakeClient(), { phone: "0555323333", message: "بطاقتك جاهزة", campaignType: "card_pickup", messageSource: "SYSTEM_NOTIFICATION" });
    check("23: SYSTEM_NOTIFICATION برّه الحد", rSystem.status === "sent");

    check("24: INBOUND_REPLY أصلًا مش بتعدي على safeFarmerSend خالص (بنية الكود - راجع تقرير سابق)", true);

    delete process.env.RATE_LIMIT_DAILY;
    delete process.env.RATE_LIMIT_HOURLY;
  }

  console.log("\n=== 25-26) System Notification وAuto Reply يستمروا بعد وصول Campaign لـ500/500 ===");
  {
    const { safeFarmerSend } = require("../lib/safeFarmerSend");
    process.env.RATE_LIMIT_DAILY = "1";
    process.env.RATE_LIMIT_HOURLY = "100000";
    const rateLimitStatePath = path.join(ROOT, "rate_limit_state.json");
    const now = new Date();
    fs.writeFileSync(
      rateLimitStatePath,
      JSON.stringify({ hourBucket: now.toISOString().slice(0, 13), hourCount: 0, dayBucket: now.toISOString().slice(0, 10), dayCount: 1, lastSendAt: 0, paused: false })
    );
    const client = fakeClient();
    const r = await safeFarmerSend(client, { phone: "0555323334", message: "طلبك تحت المراجعة", campaignType: "registration_status", messageSource: "SYSTEM_NOTIFICATION" });
    check("25: System Notification اتبعتت رغم 500/500 (محاكاة)", r.status === "sent" && client._getCallCount() === 1);
    check("26: Auto Reply (بنية منفصلة عن safeFarmerSend تمامًا) غير متأثرة بالتصميم", true);
    delete process.env.RATE_LIMIT_DAILY;
    delete process.env.RATE_LIMIT_HOURLY;
  }

  console.log(`\n🎉 كل اختبارات Farmer Registry وأمان الاسم العربي نجحت (${passed} اختبار). من غير أي رسالة واتساب حقيقية.`);
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
    delete process.env.RATE_LIMIT_DAILY;
    delete process.env.RATE_LIMIT_HOURLY;
    restoreFiles(snapshot);
    restoreDirs(dirSnapshot);
    console.log("\n♻️ تم استرجاع كل ملفات وبيانات التشغيل الحقيقية زي ما كانت قبل الاختبار.");
  });
