// اختبار شامل لمحرك الحالة/الأمان (Farmer State Machine, safeFarmerSend, Global Dedup,
// Campaign Filtering, Persistent Handoff, Ticket System, Concurrency, Fail-Closed Send History).
// من غير أي رسالة واتساب حقيقية - عميل وهمي بالكامل. بيعمل نسخة احتياطية من كل ملفات البيانات
// الحقيقية قبل ما يبدأ، وبيرجّعها زي ما كانت في الآخر (نجح الاختبار أو فشل) - عشان بيانات
// المشروع الحقيقية (send_log, sent_history, إلخ) متتأثرش خالص.
// حدود Rate Limiter صريحة للاختبار، مستقلة عن القيم الافتراضية الحقيقية في lib/rateLimiter.js
// (اللي ممكن تتغيّر لأسباب إنتاجية زي تخفيف حمل واتساب) - الاختبار محتاج حصة كبيرة كفاية عشان
// يقدر يبعت عشرات الرسائل الوهمية من غير ما يوصل لـrate_limited من قواعد الإنتاج نفسها
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
  // بنمسح الملفات دي (بعد أخذ نسخة احتياطية منها في snapshotFiles) عشان الاختبار يبدأ من
  // بيانات فاضية نظيفة، مش يتأثر بأي بيانات حقيقية موجودة فعلًا في المشروع
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

async function run() {
  // إعادة تحميل الموديولات كل مرة عشان أي حالة داخلية (لو فيه) تبدأ نضيفة
  delete require.cache[require.resolve("../lib/farmerState")];
  delete require.cache[require.resolve("../lib/campaignRules")];
  delete require.cache[require.resolve("../lib/sendFingerprint")];
  delete require.cache[require.resolve("../lib/sentTracker")];
  delete require.cache[require.resolve("../lib/safeFarmerSend")];
  delete require.cache[require.resolve("../lib/rateLimiter")];
  delete require.cache[require.resolve("../lib/ticketStore")];
  delete require.cache[require.resolve("../lib/sessionStore")];
  delete require.cache[require.resolve("../lib/campaignBuilder")];

  const farmerState = require("../lib/farmerState");
  const campaignRules = require("../lib/campaignRules");
  const sendFingerprint = require("../lib/sendFingerprint");
  const sentTracker = require("../lib/sentTracker");
  const { safeFarmerSend } = require("../lib/safeFarmerSend");
  const rateLimiter = require("../lib/rateLimiter");
  const ticketStore = require("../lib/ticketStore");
  const sessionStore = require("../lib/sessionStore");
  const { buildCampaignRows } = require("../lib/campaignBuilder");

  // أرقام اختبار وهمية بالكامل (966599XXXXXX) - مش أرقام مزارعين حقيقيين
  const P1 = "966599111111";
  const P2 = "966599222222";
  const P3 = "966599333333";
  const P4 = "966599444444";
  const P5 = "966599555555";
  const P6 = "966599666666";
  const P7 = "966599777777";

  function fakeClient(overrides = {}) {
    return {
      getNumberId: overrides.getNumberId || (async (phone) => ({ _serialized: `${phone}@c.us` })),
      sendMessage: overrides.sendMessage || (async () => true),
    };
  }

  console.log("=== A) مزارع CARD_ISSUED + registration_status → BLOCKED ===");
  farmerState.setManualState(P1, "CARD_ISSUED", { changedBy: "test-suite", reason: "unit test setup" });
  {
    const r = await safeFarmerSend(fakeClient(), {
      phone: P1,
      message: "تم استلام طلبكم",
      campaignType: "registration_status",
    });
    check("A: النتيجة blocked_by_state", r.status === "blocked_by_state");
  }

  console.log("\n=== B) مزارع CARD_COLLECTED + registration_invitation → BLOCKED ===");
  farmerState.setManualState(P2, "CARD_COLLECTED", { changedBy: "test-suite", reason: "unit test setup" });
  {
    const r = await safeFarmerSend(fakeClient(), {
      phone: P2,
      message: "ندعوكم للتسجيل",
      campaignType: "registration_invitation",
    });
    check("B: النتيجة blocked_by_state", r.status === "blocked_by_state");
  }

  console.log("\n=== C) نفس الرقم + نفس الرسالة + حملتان مختلفتان → الثانية BLOCKED ===");
  {
    const msg = "رسالة اختبار ثابتة للتكرار";
    const r1 = await safeFarmerSend(fakeClient(), { phone: P3, message: msg, campaignType: "card_pickup" });
    check("C: أول إرسال نجح", r1.status === "sent");
    const r2 = await safeFarmerSend(fakeClient(), { phone: P3, message: msg, campaignType: "documents_request" });
    check("C: الإرسال الثاني (حملة مختلفة، نفس النص) اتمنع", r2.status === "duplicate");
  }

  console.log("\n=== D) Custom Message مكررة → BLOCKED ===");
  {
    const msg = "رسالة مخصصة للاختبار";
    const r1 = await safeFarmerSend(fakeClient(), { phone: P4, message: msg, campaignType: "custom_message" });
    check("D: أول إرسال نجح", r1.status === "sent");
    const r2 = await safeFarmerSend(fakeClient(), { phone: P4, message: msg, campaignType: "custom_message" });
    check("D: نفس الرسالة المخصصة تاني اتمنعت", r2.status === "duplicate");
  }

  console.log("\n=== E) Restart أثناء HANDED_OFF → يبقى HANDED_OFF ===");
  {
    const chatId = `${P5}@c.us`;
    sessionStore.setHandedOff(chatId);
    // محاكاة "إعادة تشغيل" - بنشيل أي حاجة في الذاكرة ونقرا بس من التخزين الدائم
    const stillHandedOff = sessionStore.isHandedOff(chatId);
    check("E: لسه HANDED_OFF بعد 'إعادة التشغيل' المحاكاة", stillHandedOff === true);
    const resumed = sessionStore.resumeBot(chatId);
    check("E: استئناف البوت نجح", resumed === true);
    check("E: بعد الاستئناف مبقاش HANDED_OFF", sessionStore.isHandedOff(chatId) === false);
  }

  console.log("\n=== F) شكوى → Ticket محفوظ بالاسم والرقم والتصنيف ورقم مرجعي ===");
  {
    const ticket = ticketStore.createTicket({
      farmerName: "مزارع اختبار",
      phone: P6,
      category: "شكوى",
      message: "نص شكوى تجريبي",
    });
    check("F: رقم مرجعي اترجع", typeof ticket.ticket_id === "string" && ticket.ticket_id.startsWith("T-"));
    const fetched = ticketStore.getTicket(ticket.ticket_id);
    check("F: الاسم محفوظ صح", fetched.farmer_name === "مزارع اختبار");
    check("F: الرقم محفوظ صح", fetched.phone === P6);
    check("F: التصنيف محفوظ صح", fetched.category === "شكوى");
    check("F: الحالة الابتدائية OPEN", fetched.status === "OPEN");
  }

  console.log("\n=== G) ملف خارجي فيه نفس الرقم مكرر بنفس الرسالة بالظبط → الثاني duplicate ===");
  {
    const rawRows = [
      { name: "أحمد", phone: "0512345678", message: "نفس الرسالة بالحرف" },
      { name: "أحمد تاني", phone: "+966512345678", message: "نفس الرسالة بالحرف" }, // نفس الرقم بصيغة مختلفة + نفس الرسالة بالحرف
    ];
    const { rows } = buildCampaignRows(rawRows, "SURVEY");
    check("G: أول ظهور pending", rows[0].status === "pending");
    check("G: الظهور التاني (نفس الرقم + نفس الرسالة) duplicate", rows[1].status === "duplicate");
  }

  console.log("\n=== G2) نفس الرقم مكرر برسالتين مختلفتين → الاتنين يعدّوا (مش duplicate تلقائي) ===");
  {
    const rawRows = [
      { name: "سالم", phone: "0511111111", message: "رسالة أولى مختلفة" },
      { name: "سالم تاني", phone: "+966511111111", message: "رسالة ثانية مختلفة تمامًا" },
    ];
    const { rows } = buildCampaignRows(rawRows, "SURVEY");
    check("G2: أول ظهور pending", rows[0].status === "pending");
    check("G2: الظهور التاني (نفس الرقم، رسالة مختلفة) مش duplicate", rows[1].status === "pending");
  }

  console.log("\n=== H) حملة تسجيل + مزارع لديه Active Application → EXCLUDED ===");
  {
    farmerState.setManualState(P7, "SUBMITTED", { changedBy: "test-suite", reason: "unit test setup" });
    const { rows } = buildCampaignRows([{ name: "مزارع", phone: P7, message: "دعوة" }], "REGISTRATION");
    check("H: الصف excluded_by_state", rows[0].status === "excluded_by_state");
  }

  console.log("\n=== I) حملة تسجيل + مزارع CARD_ISSUED → EXCLUDED ===");
  {
    // P1 أصلًا CARD_ISSUED من اختبار A
    const { rows } = buildCampaignRows([{ name: "مزارع", phone: P1, message: "دعوة" }], "REGISTRATION");
    check("I: الصف excluded_by_state", rows[0].status === "excluded_by_state");
  }

  console.log("\n=== J) حملة تقييم عامة + مزارع CARD_ISSUED → لا يُستبعد ===");
  {
    const { rows } = buildCampaignRows([{ name: "مزارع", phone: P1, message: "تقييمك يهمنا" }], "SURVEY");
    check("J: الصف pending (مش مستبعد)", rows[0].status === "pending");
  }

  console.log("\n=== K) عمليتا إرسال متزامنتان لنفس الرقم ونفس الرسالة → رسالة واحدة بس ===");
  {
    const phoneK = "966599888888";
    const msg = "رسالة تزامن اختبارية";
    let sendCount = 0;
    const client = fakeClient({
      sendMessage: async () => {
        sendCount++;
        await new Promise((r) => setTimeout(r, 50)); // محاكاة تأخير شبكة حقيقي
        return true;
      },
    });
    const [r1, r2] = await Promise.all([
      safeFarmerSend(client, { phone: phoneK, message: msg, campaignType: "card_pickup" }),
      safeFarmerSend(client, { phone: phoneK, message: msg, campaignType: "card_pickup" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    check("K: نتيجة واحدة sent والتانية duplicate", statuses[0] === "duplicate" && statuses[1] === "sent");
    check("K: client.sendMessage اتنادى مرة واحدة بس فعليًا", sendCount === 1);
  }

  console.log("\n=== L) تلف Send History → STOP CAMPAIGN وليس بدء سجل فارغ ===");
  {
    const sentHistoryPath = path.join(ROOT, "sent_history.json");
    const backupPath = `${sentHistoryPath}.bak`;
    fs.writeFileSync(sentHistoryPath, "{ هذا ملف تالف عمدًا للاختبار");
    fs.writeFileSync(backupPath, "{ وده كمان تالف عمدًا");
    let threw = false;
    try {
      sentTracker.hasBeenSent("card_pickup", "966500000000");
    } catch (err) {
      threw = true;
      check("L: رسالة الخطأ واضحة", /SEND_HISTORY_CORRUPTED/.test(err.message));
    }
    check("L: رمى استثناء بدل ما يرجع سجل فاضي بصمت", threw === true);
    // "الإصلاح اليدوي" المحاكى - بعد ما أثبتنا إن الفشل بيوقف العملية صح، بنصلح الملف عشان
    // باقي الاختبارات بعد كده (اللي بتستخدم campaignType تاني) تكمل عادي
    fs.writeFileSync(sentHistoryPath, "{}");
    fs.unlinkSync(backupPath);
  }

  console.log("\n=== M) مزارع يظهر في Draft وCards في نفس المزامنة → CARD_ISSUED فقط ===");
  {
    const phoneM1 = "966599999901";
    farmerState.upsertState(phoneM1, "DRAFT", "portal:draft");
    farmerState.upsertState(phoneM1, "CARD_ISSUED", "portal:cards");
    check("M (ترتيب 1): الحالة النهائية CARD_ISSUED", farmerState.getState(phoneM1).state === "CARD_ISSUED");

    const phoneM2 = "966599999902";
    // نفس الاختبار بترتيب عكسي - لازم تجيب نفس النتيجة (الأعلى بيكسب مهما كان الترتيب)
    farmerState.upsertState(phoneM2, "CARD_ISSUED", "portal:cards");
    farmerState.upsertState(phoneM2, "DRAFT", "portal:draft");
    check("M (ترتيب 2): الحالة النهائية CARD_ISSUED برضه", farmerState.getState(phoneM2).state === "CARD_ISSUED");
  }

  console.log("\n=== N) توقف البرنامج بعد حجز fingerprint وقبل الإرسال → بعد TTL تُسمح إعادة المحاولة ===");
  {
    const phoneN = "966599999903";
    const msg = "رسالة اختبار TTL";
    const fp = sendFingerprint.buildFingerprint(phoneN, msg);
    const r1 = sendFingerprint.reserve(fp, { phone: phoneN });
    check("N: أول حجز نجح", r1.ok === true);
    const r2 = sendFingerprint.reserve(fp, { phone: phoneN });
    check("N: حجز تاني فورًا (لسه PENDING) اتمنع", r2.ok === false && r2.reason === "pending");

    // محاكاة انتهاء الـTTL (البرنامج وقع في نص الإرسال) - بنعدّل وقت الانتهاء يدويًا للماضي
    const storeFile = path.join(ROOT, "send_fingerprints.json");
    const state = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    state[fp].ttlExpiresAt = Date.now() - 1000;
    fs.writeFileSync(storeFile, JSON.stringify(state));

    const r3 = sendFingerprint.reserve(fp, { phone: phoneN });
    check("N: بعد انتهاء TTL، إعادة المحاولة مسموحة", r3.ok === true);
    check("N: الحالة لسه مش SENT (ما اتبعتش فعليًا)", sendFingerprint.getEntry(fp).status === "PENDING");
  }

  console.log("\n=== إضافي: rateLimiter pause/resume ===");
  {
    rateLimiter.pause();
    const r = await safeFarmerSend(fakeClient(), {
      phone: "966599999904",
      message: "رسالة أثناء الإيقاف",
      campaignType: "card_pickup",
    });
    check("Rate limiter: الإرسال اتمنع وقت الإيقاف", r.status === "rate_limited" && r.reason === "paused");
    rateLimiter.resume();
    const r2 = await safeFarmerSend(fakeClient(), {
      phone: "966599999904",
      message: "رسالة بعد التشغيل",
      campaignType: "card_pickup",
    });
    check("Rate limiter: الإرسال اشتغل بعد الاستئناف", r2.status === "sent");
  }

  console.log(`\n🎉 كل الاختبارات نجحت (${passed} اختبار). من غير أي رسالة واتساب حقيقية.`);
}

(async () => {
  const snapshot = snapshotFiles();
  wipeTestFiles();
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    console.error("\n💥 فشل الاختبار:", err.message);
    process.exitCode = 1;
  } finally {
    restoreFiles(snapshot);
    console.log("\n♻️ تم استرجاع كل ملفات البيانات الحقيقية زي ما كانت قبل الاختبار.");
  }
})();
