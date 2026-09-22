process.env.RATE_LIMIT_HOURLY = process.env.RATE_LIMIT_HOURLY || "1000";
process.env.RATE_LIMIT_DAILY = process.env.RATE_LIMIT_DAILY || "1000";
// اختبارات إصلاح حادثة EPERM/EBUSY (حملة c1789640068672) - بند 9 من طلب الإصلاح:
// EPERM/EACCES/EBUSY + Retry، Concurrent Writes، Crash Recovery، WhatsApp نجح ثم Persistence
// فشل (DELIVERY_UNCERTAIN)، عدم تكرار SENT، previous-contact blocking، Portal state blocking،
// Preview + pre-send recheck، Farmer Registry Backfill، أسماء عربية، أوامر Admin (عبر الدوال
// المباشرة، مش عبر واتساب). صفر رسائل واتساب حقيقية (Fake Client فقط).
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = [
  "farmer_state.json",
  "farmer_state.json.bak",
  "send_fingerprints.json",
  "send_fingerprints.json.bak",
  "send_fingerprints.json.tmp",
  "farmer_registry.json",
  "farmer_registry.json.bak",
  "farmer_registry.json.tmp",
  "rate_limit_state.json",
  "sent_history.json",
  "sent_history.json.bak",
  "audit_log.jsonl",
];
const DATA_DIRS = ["campaigns"];

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
  return {
    getNumberId: async (phone) => ({ _serialized: `${phone}@c.us` }),
    sendMessage: async () => true,
    saveOrEditAddressbookContact: async () => true,
    ...overrides,
  };
}

const filesSnap = snapshotFiles();
const dirsSnap = snapshotDirs();
wipeFiles();
wipeDirs();

async function run() {
  const safeJsonStore = require("../lib/safeJsonStore");

  // ===== 1-3) EPERM/EACCES/EBUSY + Retry على writeJsonAtomicSync =====
  console.log("\n=== 1-3) EPERM/EACCES/EBUSY على rename - لازم يعيد المحاولة وينجح =====");
  ["EPERM", "EACCES", "EBUSY"].forEach((code, i) => {
    const testFile = path.join(ROOT, `__test_store_${code}.json`);
    const realRename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = function (from, to) {
      attempts++;
      if (attempts < 3) {
        const err = new Error(`${code}: simulated`);
        err.code = code;
        throw err;
      }
      return realRename(from, to);
    };
    try {
      safeJsonStore.writeJsonAtomicSync(testFile, null, { ok: true, code });
      const result = JSON.parse(fs.readFileSync(testFile, "utf8"));
      check(`${i + 1}) ${code}: نجحت الكتابة بعد ${attempts} محاولات (Retry شغال)`, result.ok === true && attempts === 3);
    } finally {
      fs.renameSync = realRename;
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
  });

  // ===== 4) فشل دائم (كل المحاولات EPERM) - لازم يرمي استثناء واضح (Fail Loud) =====
  console.log("\n=== 4) EPERM دائم على كل المحاولات - لازم يرمي استثناء مش يتجاهل بصمت ===");
  {
    const testFile = path.join(ROOT, "__test_store_permanent.json");
    const realRename = fs.renameSync;
    fs.renameSync = function () {
      const err = new Error("EPERM: permanent");
      err.code = "EPERM";
      throw err;
    };
    let threw = false;
    try {
      safeJsonStore.writeJsonAtomicSync(testFile, null, { ok: true });
    } catch (err) {
      threw = err.code === "EPERM";
    } finally {
      fs.renameSync = realRename;
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
      if (fs.existsSync(`${testFile}.tmp`)) fs.unlinkSync(`${testFile}.tmp`);
    }
    check("4: فشل دائم رمى استثناء EPERM بوضوح (Fail Loud) بدل التجاهل الصامت", threw);
  }

  // ===== 5) Crash Recovery من ملف .tmp يتيم =====
  console.log("\n=== 5) استرجاع بيانات من .tmp يتيم بعد انقطاع قبل rename ===");
  {
    const testFile = path.join(ROOT, "__test_crash_recovery.json");
    fs.writeFileSync(`${testFile}.tmp`, JSON.stringify({ recovered: true }), "utf8");
    const result = safeJsonStore.readJsonSync(testFile, null, () => ({ recovered: false }));
    check("5: استرجع البيانات من .tmp اليتيم بدل القيمة الافتراضية", result.recovered === true);
    if (fs.existsSync(`${testFile}.tmp`)) fs.unlinkSync(`${testFile}.tmp`);
  }

  // ===== 6) checkHealth: HEALTHY لما مفيش .tmp عالق، FAILED لما فيه =====
  console.log("\n=== 6) checkHealth - كشف ملفات .tmp عالقة (لأمر 'حالة البوت') ===");
  {
    const testFile = path.join(ROOT, "__test_health.json");
    let health = safeJsonStore.checkHealth([testFile]);
    check("6a: HEALTHY لما مفيش .tmp عالق", health.healthy === true);
    fs.writeFileSync(`${testFile}.tmp`, "{}", "utf8");
    health = safeJsonStore.checkHealth([testFile]);
    check("6b: FAILED لما فيه .tmp عالق فعلًا", health.healthy === false && health.orphanedTmp.includes(testFile));
    fs.unlinkSync(`${testFile}.tmp`);
  }

  // ===== 7) Concurrent writes عبر withFileLock - لازم يتسلسلوا مش يتصادموا =====
  console.log("\n=== 7) Concurrent writes لنفس الملف عبر withFileLock ===");
  {
    const testFile = path.join(ROOT, "__test_concurrent.json");
    const order = [];
    const tasks = [1, 2, 3, 4, 5].map((n) =>
      safeJsonStore.withFileLock(testFile, async () => {
        order.push(`start-${n}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end-${n}`);
      })
    );
    await Promise.all(tasks);
    let sequential = true;
    for (let i = 0; i < order.length; i += 2) {
      const startN = order[i].split("-")[1];
      if (order[i + 1] !== `end-${startN}`) sequential = false;
    }
    check("7: كل عملية خلصت (start/end) قبل ما التالية تبدأ - مفيش تداخل", sequential);
  }

  // ===== 8-11) WhatsApp نجح فعليًا ثم Persistence فشل -> DELIVERY_UNCERTAIN (مش failed) =====
  console.log("\n=== 8-11) نجاح إرسال فعلي ثم فشل حفظ الحالة -> DELIVERY_UNCERTAIN ===");
  {
    delete require.cache[require.resolve("../lib/sendFingerprint")];
    delete require.cache[require.resolve("../lib/safeFarmerSend")];
    const sendFingerprint = require("../lib/sendFingerprint");
    const { safeFarmerSend } = require("../lib/safeFarmerSend");

    const realConfirmSent = sendFingerprint.confirmSent;
    sendFingerprint.confirmSent = () => {
      const err = new Error("EPERM: simulated persistence failure after successful send");
      err.code = "EPERM";
      throw err;
    };

    let sendCallCount = 0;
    const client = fakeClient({
      sendMessage: async () => {
        sendCallCount++;
        return true;
      },
    });

    const result1 = await safeFarmerSend(client, {
      phone: "0501111111",
      name: "مزارع اختبار",
      message: "رسالة اختبار DELIVERY_UNCERTAIN",
      messageSource: "CAMPAIGN",
    });
    check("8: الحالة الراجعة delivery_uncertain (مش failed) لما الإرسال نجح والحفظ فشل", result1.status === "delivery_uncertain");
    check("9: sendMessage اتنادى مرة واحدة بالظبط (الإرسال الفعلي حصل)", sendCallCount === 1);

    sendFingerprint.confirmSent = realConfirmSent;

    // بعد إصلاح الحفظ، نفس الرسالة (نفس البصمة) - المفروض تتمنع كـduplicate، مش تتبعت تاني
    const result2 = await safeFarmerSend(client, {
      phone: "0501111111",
      name: "مزارع اختبار",
      message: "رسالة اختبار DELIVERY_UNCERTAIN",
      messageSource: "CAMPAIGN",
    });
    check("10: نفس الرسالة تاني مش هتتبعت تاني (duplicate) - مفيش تكرار إرسال حقيقي", result2.status === "duplicate");
    check("11: sendMessage لسه اتنادى مرة واحدة بس إجمالاً (مفيش إرسال تاني فعلي)", sendCallCount === 1);
  }

  // ===== 12-14) campaignRunner: صف delivery_uncertain ما بيوقّفش باقي الحملة، وما بيتكررش =====
  console.log("\n=== 12-14) campaignRunner: DELIVERY_UNCERTAIN لا يوقف الحملة ولا يتكرر ===");
  {
    delete require.cache[require.resolve("../lib/sendFingerprint")];
    delete require.cache[require.resolve("../lib/safeFarmerSend")];
    delete require.cache[require.resolve("../lib/campaignRunner")];
    delete require.cache[require.resolve("../lib/campaignStore")];
    delete require.cache[require.resolve("../lib/farmerRegistry")];
    const sendFingerprint = require("../lib/sendFingerprint");
    const campaignStore = require("../lib/campaignStore");
    const { sendCampaignRows } = require("../lib/campaignRunner");

    const realConfirmSent = sendFingerprint.confirmSent;
    let confirmCallCount = 0;
    sendFingerprint.confirmSent = (fp) => {
      confirmCallCount++;
      if (confirmCallCount === 2) {
        const err = new Error("EPERM: simulated on row 2");
        err.code = "EPERM";
        throw err;
      }
      return realConfirmSent(fp);
    };

    const rows = [1, 2, 3].map((n) => ({
      name: `مزارع${n}`,
      phone: `050222220${n}`,
      message: `رسالة رقم ${n}`,
      status: "pending",
      purpose: "GENERAL_NOTICE",
    }));
    const campaignId = campaignStore.createCampaign({ label: "اختبار DELIVERY_UNCERTAIN", createdBy: "test", rows });

    process.env.CAMPAIGN_TEST_FAST = "true";
    const client = fakeClient();
    const summary = await sendCampaignRows(client, campaignId);
    sendFingerprint.confirmSent = realConfirmSent;

    check("12: الحملة كملت كل الصفوف الثلاثة (ما توقفتش عند صف 2)", summary.sent + summary.deliveryUncertain === 3);
    check("13: صف واحد بالظبط اتصنّف delivery_uncertain", summary.deliveryUncertain === 1);

    const finalCampaign = campaignStore.getCampaign(campaignId);
    const statuses = finalCampaign.rows.map((r) => r.status);
    check("14: الصف التاني status=delivery_uncertain في campaignStore (مش pending ومش failed)", statuses[1] === "delivery_uncertain");
  }

  // ===== 15) PAUSED_SAFE يمنع أي استئناف تلقائي/يدوي حتى لو فيه صفوف pending =====
  console.log("\n=== 15) PAUSED_SAFE يمنع الاستئناف تمامًا ===");
  {
    delete require.cache[require.resolve("../lib/campaignStore")];
    delete require.cache[require.resolve("../lib/campaignRunner")];
    const campaignStore = require("../lib/campaignStore");
    const { sendCampaignRows } = require("../lib/campaignRunner");

    const rows = [{ name: "مزارع", phone: "0503333333", message: "رسالة", status: "pending", purpose: "GENERAL_NOTICE" }];
    const campaignId = campaignStore.createCampaign({ label: "اختبار PAUSED_SAFE", createdBy: "test", rows });
    campaignStore.setPausedSafe(campaignId, "TEST_INCIDENT_PAUSE");

    let sendCalled = false;
    const client = fakeClient({ sendMessage: async () => { sendCalled = true; return true; } });
    const summary = await sendCampaignRows(client, campaignId);

    check("15a: sendCampaignRows رجع فورًا من غير أي إرسال", sendCalled === false);
    check("15b: pausedReason = paused_safe في النتيجة", summary.pausedReason === "paused_safe");

    campaignStore.clearPausedSafe(campaignId);
    check("15c: isPausedSafe = false بعد clearPausedSafe صريح", campaignStore.isPausedSafe(campaignId) === false);
  }

  // ===== 16-19) Farmer Registry Backfill - بدون أي إرسال =====
  console.log("\n=== 16-19) Farmer Registry Backfill (بدون إرسال) ===");
  {
    delete require.cache[require.resolve("../lib/farmerRegistry")];
    const farmerRegistry = require("../lib/farmerRegistry");

    const entry = farmerRegistry.backfillFromCampaignRow({
      phone: "0504444444",
      nameArabic: "سعيد الحربي",
      campaignId: "c1789640068672",
      campaignPurpose: "REGISTRATION",
      campaignLabel: "حملة تسجيل",
    });
    check("16: الاسم العربي اتسجّل فورًا وقت القبول (قبل أي إرسال)", entry.nameArabic === "سعيد الحربي");
    check("17: communicationStatus فضل NOT_CONTACTED (Backfill مش إرسال)", entry.communicationStatus === "NOT_CONTACTED");
    check("18: totalMessages فضل صفر (Backfill مش إرسال)", entry.totalMessages === 0);
    check('19: campaignLabel = "حملة تسجيل" محفوظ بالظبط', entry.campaignLabel === "حملة تسجيل");

    const entryEnglish = farmerRegistry.backfillFromCampaignRow({
      phone: "0505555555",
      nameArabic: "Mohammed Ali",
      campaignId: "c1789640068672",
      campaignPurpose: "REGISTRATION",
      campaignLabel: "حملة تسجيل",
    });
    check("20: اسم إنجليزي ممنوع يتحفظ في nameArabic أبدًا", entryEnglish.nameArabic === null);

    farmerRegistry.recordSuccessfulContact({ phone: "0506666666", messageSource: "CAMPAIGN", contactReason: "REGISTRATION_INVITATION", nameArabic: "خالد سالم" });
    const entryProtected = farmerRegistry.backfillFromCampaignRow({
      phone: "0506666666",
      nameArabic: "اسم عربي مختلف",
      campaignId: "c1789640068672",
      campaignPurpose: "REGISTRATION",
      campaignLabel: "حملة تسجيل",
    });
    check("21: اسم عربي موثوق محفوظ مسبقًا لم يُستبدل بـBackfill لاحق", entryProtected.nameArabic === "خالد سالم");
  }

  // ===== 22) بعد الإرسال الفعلي: communicationStatus/messageSource/totalMessages صح =====
  console.log("\n=== 22) بعد نجاح إرسال فعلي: communicationStatus/totalMessages صح ===");
  {
    const farmerRegistry = require("../lib/farmerRegistry");
    farmerRegistry.backfillFromCampaignRow({ phone: "0507777777", nameArabic: "فهد ناصر", campaignId: "c1789640068672", campaignPurpose: "REGISTRATION", campaignLabel: "حملة تسجيل" });
    const afterSend = farmerRegistry.recordSuccessfulContact({ phone: "0507777777", messageSource: "CAMPAIGN", contactReason: "REGISTRATION_INVITATION", nameArabic: "فهد ناصر" });
    check("22a: communicationStatus = REGISTRATION_INVITATION_SENT بعد إرسال فعلي", afterSend.communicationStatus === "REGISTRATION_INVITATION_SENT");
    check("22b: totalMessages = 1 بعد إرسال فعلي واحد فقط", afterSend.totalMessages === 1);
  }

  // ===== 23-26) منع إعادة إرسال دعوة تسجيل سبق إرسالها (BLOCKED_PREVIOUS_CONTACT) =====
  console.log("\n=== 23-26) BLOCKED_PREVIOUS_CONTACT لحملة REGISTRATION فقط ===");
  {
    delete require.cache[require.resolve("../lib/safeFarmerSend")];
    delete require.cache[require.resolve("../lib/farmerRegistry")];
    delete require.cache[require.resolve("../lib/contactHistoryGuard")];
    const farmerRegistry = require("../lib/farmerRegistry");
    const { safeFarmerSend } = require("../lib/safeFarmerSend");

    // مزارع سبق إرساله دعوة تسجيل فعلًا (SENT حقيقي) قبل كده
    farmerRegistry.recordSuccessfulContact({
      phone: "0508888888",
      messageSource: "CAMPAIGN",
      contactReason: "REGISTRATION_INVITATION",
      nameArabic: "ماجد فهد",
    });

    const client = fakeClient();
    const result = await safeFarmerSend(client, {
      phone: "0508888888",
      name: "ماجد فهد",
      message: "دعوة تسجيل جديدة (نص مختلف تمامًا عن قبل)",
      purpose: "REGISTRATION",
      messageSource: "CAMPAIGN",
    });
    check("23: BLOCKED_PREVIOUS_CONTACT حتى لو نص الرسالة مختلف تمامًا (نفس الغرض REGISTRATION)", result.status === "blocked_previous_contact");

    // نفس المزارع، بس Purpose مختلف (GENERAL_NOTICE) - مسموح، مفيش حظر previous-contact خارج REGISTRATION
    const result2 = await safeFarmerSend(client, {
      phone: "0508888888",
      name: "ماجد فهد",
      message: "إشعار عام جديد",
      purpose: "GENERAL_NOTICE",
      messageSource: "CAMPAIGN",
    });
    check("24: GENERAL_NOTICE مش متأثر بحظر previous-contact الخاص بـREGISTRATION", result2.status === "sent");

    // مزارع تاني لسه ما اتبعتلوش REGISTRATION قبل كده - يعدي عادي
    const result3 = await safeFarmerSend(client, {
      phone: "0509999999",
      name: "سلطان عبدالله",
      message: "دعوة تسجيل أولى",
      purpose: "REGISTRATION",
      messageSource: "CAMPAIGN",
    });
    check("25: مزارع جديد (مفيش تواصل سابق لنفس الغرض) - مسموح يتبعت عادي", result3.status === "sent");

    // مفيش منع لمجرد إن المزارع بعت رسالة للبوت (INBOUND_REPLY) - سيناريو صريح ممنوع نمنعه بغلط
    farmerRegistry.recordReply("0507000000", "GENERAL_NOTICE");
    const result4 = await safeFarmerSend(client, {
      phone: "0507000000",
      name: "ياسر سعد",
      message: "دعوة تسجيل",
      purpose: "REGISTRATION",
      messageSource: "CAMPAIGN",
    });
    check("26: رد سابق من المزارع للبوت (FARMER_REPLIED) لا يمنع إرسال REGISTRATION جديد", result4.status === "sent");
  }

  // ===== 27) BLOCKED_REVIEW_REQUIRED عند تعارض بين Registry وFarmer State =====
  console.log("\n=== 27) BLOCKED_REVIEW_REQUIRED عند تعارض أدلة ===");
  {
    delete require.cache[require.resolve("../lib/safeFarmerSend")];
    delete require.cache[require.resolve("../lib/farmerRegistry")];
    delete require.cache[require.resolve("../lib/farmerState")];
    delete require.cache[require.resolve("../lib/contactHistoryGuard")];
    const farmerRegistry = require("../lib/farmerRegistry");
    const { safeFarmerSend } = require("../lib/safeFarmerSend");

    // السجل يقول "اتبعت إشعار جاهزية بطاقة" بس البوابة (farmerState) لسه UNKNOWN - تعارض حقيقي
    farmerRegistry.recordSuccessfulContact({
      phone: "0501010101",
      messageSource: "SYSTEM_NOTIFICATION",
      contactReason: "CARD_READY",
      nameArabic: "تركي حمد",
    });

    const client = fakeClient();
    const result = await safeFarmerSend(client, {
      phone: "0501010101",
      name: "تركي حمد",
      message: "دعوة تسجيل",
      purpose: "REGISTRATION",
      messageSource: "CAMPAIGN",
    });
    check("27: BLOCKED_REVIEW_REQUIRED عند تعارض CARD_READY_NOTIFIED مقابل Farmer State=UNKNOWN", result.status === "blocked_review_required");
  }

  // ===== 28-30) Preview (campaignBuilder) بيطبّق نفس الفحص قبل الإرسال =====
  console.log("\n=== 28-30) Preview: نفس الفحص قبل الإرسال (campaignBuilder) ===");
  {
    delete require.cache[require.resolve("../lib/farmerRegistry")];
    delete require.cache[require.resolve("../lib/campaignBuilder")];
    delete require.cache[require.resolve("../lib/contactHistoryGuard")];
    const farmerRegistry = require("../lib/farmerRegistry");
    const { buildCampaignRows, summarizeCampaignRows } = require("../lib/campaignBuilder");

    farmerRegistry.recordSuccessfulContact({
      phone: "0502020202",
      messageSource: "CAMPAIGN",
      contactReason: "REGISTRATION_INVITATION",
      nameArabic: "بندر سعود",
    });

    const { rows } = buildCampaignRows(
      [{ name: "بندر سعود", phone: "0502020202", message: "دعوة تسجيل مختلفة تمامًا" }],
      "REGISTRATION"
    );
    check("28: Preview بيرفض نفس الصف بحالة blocked_previous_contact قبل أي إرسال", rows[0].status === "blocked_previous_contact");

    const counts = summarizeCampaignRows(rows);
    check("29: العدّاد blocked_previous_contact في summarizeCampaignRows اتحدّث صح", counts.blocked_previous_contact === 1);
    check("30: valid = 0 (الصف الوحيد اتمنع، مفيش صفوف جاهزة)", counts.valid === 0);
  }

  // ===== 31) safeJsonStore.checkHealth مستخدم في أمر 'حالة البوت' الإداري =====
  console.log("\n=== 31) أمر 'حالة البوت': لا يغيّر أي حالة (قراءة فقط) ===");
  {
    const rateLimiter = require("../lib/rateLimiter");
    const before = rateLimiter.getStatus();
    rateLimiter.getStatus(); // يُستدعى في أمر "حالة البوت" - قراءة فقط
    const after = rateLimiter.getStatus();
    check("31: rateLimiter.getStatus() قراءة فقط - مفيش تغيير في العدادات", before.hourly.used === after.hourly.used && before.daily.used === after.daily.used);
  }

  console.log(`\n🎉 كل اختبارات إصلاح حادثة الحملة نجحت (${passed} اختبار). من غير أي رسالة واتساب حقيقية.`);
}

run()
  .then(() => {
    wipeFiles();
    wipeDirs();
    restoreFiles(filesSnap);
    restoreDirs(dirsSnap);
    console.log("\n♻️ تم استرجاع كل ملفات وبيانات التشغيل الحقيقية زي ما كانت قبل الاختبار.");
    delete require.cache[require.resolve("../lib/sendFingerprint")];
    delete require.cache[require.resolve("../lib/safeFarmerSend")];
    delete require.cache[require.resolve("../lib/campaignRunner")];
    delete require.cache[require.resolve("../lib/campaignStore")];
    delete require.cache[require.resolve("../lib/farmerRegistry")];
    delete require.cache[require.resolve("../lib/campaignBuilder")];
    delete require.cache[require.resolve("../lib/contactHistoryGuard")];
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    wipeFiles();
    wipeDirs();
    restoreFiles(filesSnap);
    restoreDirs(dirsSnap);
    console.log("\n♻️ تم استرجاع كل ملفات وبيانات التشغيل الحقيقية زي ما كانت قبل الاختبار (بعد فشل).");
    process.exit(1);
  });
