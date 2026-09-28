process.env.RATE_LIMIT_HOURLY = process.env.RATE_LIMIT_HOURLY || "1000";
process.env.RATE_LIMIT_DAILY = process.env.RATE_LIMIT_DAILY || "1000";
process.env.CAMPAIGN_TEST_FAST = "true";
// اختبارات حوار "استلام/توصيل البطاقة" (بما فيها خطوة اليوم/الوقت الجديدة) + توجيه الطلب لمجموعة
// المنطقة. Fake Client بس - صفر واتساب حقيقي، وبيرجّع كل ملفات البيانات الحقيقية زي ما كانت في الآخر.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = [
  "delivery_state.json", "delivery_state.json.bak",
  "farmer_state.json", "farmer_state.json.bak",
  "send_fingerprints.json", "send_fingerprints.json.bak",
  "farmer_registry.json", "farmer_registry.json.bak",
  "rate_limit_state.json", "sent_history.json", "sent_history.json.bak",
  "send_log.json", "send_log.json.bak", "audit_log.jsonl",
];
const snapshot = () => Object.fromEntries(DATA_FILES.map((n) => [n, fs.existsSync(path.join(ROOT, n)) ? fs.readFileSync(path.join(ROOT, n)) : null]));
const wipe = () => DATA_FILES.forEach((n) => fs.existsSync(path.join(ROOT, n)) && fs.unlinkSync(path.join(ROOT, n)));
const restore = (s) => DATA_FILES.forEach((n) => {
  const p = path.join(ROOT, n);
  if (s[n] === null) { if (fs.existsSync(p)) fs.unlinkSync(p); } else fs.writeFileSync(p, s[n]);
});

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

const TEXTS = {
  DELIVERY_PICKUP_CONFIRM: "PICKUP_OK",
  DELIVERY_ASK_REGION: "ASK_REGION",
  DELIVERY_REMINDER_CHOICE: "REMIND_CHOICE",
  DELIVERY_REMINDER_REGION: "REMIND_REGION",
  DELIVERY_ASK_DATETIME: "ASK_DATETIME",
  DELIVERY_REMINDER_DATETIME: "REMIND_DATETIME",
  DELIVERY_THANKS: "THANKS {region}",
  DELIVERY_LOCATION_UNKNOWN: "LOCATION_UNKNOWN",
};
const getText = (k) => TEXTS[k];

const snap = snapshot();
wipe();

async function run() {
  const store = require("../lib/deliveryStore");
  const flow = require("../lib/deliveryFlow");
  const cfg = require("../config");

  console.log("\n=== 1) رسالة الاستلام الرسمية الجديدة بتفعّل حالة الانتظار (فيها خيار توصيل) ===");
  check("1: CARD_PICKUP_TEMPLATE الرسمي الجديد فيه خيار توصيل -> بيفعّل حالة الانتظار", store.templateOffersDelivery(cfg.CARD_PICKUP_TEMPLATE) === true);
  check("1ب: نص فيه كلمة توصيل بيفعّل الحالة", store.templateOffersDelivery("1- الاستلام 2- توصيل البطاقة") === true);

  console.log("\n=== 2) من غير حالة انتظار: مش مُعالَج (يكمّل قائمة البوت العادية) ===");
  check("2: handled=false", flow.handleReply("966501111111", "2", getText).handled === false);

  console.log("\n=== 3) استلام من المركز (1) ===");
  store.markAwaitingChoice("966501111111", "أحمد");
  let r = flow.handleReply("966501111111", "1", getText);
  check("3: رد تأكيد الاستلام", r.handled && r.reply === "PICKUP_OK" && !r.request);
  check("3ب: حالة الانتظار اتمسحت", flow.handleReply("966501111111", "1", getText).handled === false);

  console.log("\n=== 4) توصيل (2) ثم منطقة ثم اليوم/الوقت ===");
  store.markAwaitingChoice("966502222222", "خالد");
  r = flow.handleReply("966502222222", "hello", getText);
  check("4: رد غير صحيح -> تذكير بالخيارين وتفضل الحالة", r.handled && r.reply === "REMIND_CHOICE" && store.getPending("966502222222").step === "CHOICE");
  r = flow.handleReply("966502222222", "2", getText);
  check("4ب: اختيار توصيل -> سؤال المنطقة", r.reply === "ASK_REGION" && store.getPending("966502222222").step === "REGION");
  r = flow.handleReply("966502222222", "9", getText);
  check("4ج: منطقة غير صحيحة -> تذكير بالمناطق", r.reply === "REMIND_REGION" && !r.request);
  r = flow.handleReply("966502222222", "2", getText);
  check("4د: منطقة 2 = الجنوب -> ينتقل لخطوة اليوم/الوقت، مفيش طلب لسه", r.handled && !r.request && r.reply === "ASK_DATETIME" && store.getPending("966502222222").step === "DATETIME" && store.getPending("966502222222").regionKey === "SOUTH");
  r = flow.handleReply("966502222222", "ح", getText);
  check("4هـ: يوم/وقت قصير جدًا -> تذكير ولا يتسجّل طلب", r.reply === "REMIND_DATETIME" && !r.request && store.getPending("966502222222").step === "DATETIME");
  r = flow.handleReply("966502222222", "الأحد الساعة 10 صباحًا", getText);
  check("4و: يوم/وقت صحيح -> الطلب اتسجّل بمنطقته ووقته", r.handled && r.request && r.request.regionKey === "SOUTH" && r.request.preferredDateTime === "الأحد الساعة 10 صباحًا" && r.reply === "THANKS الجنوب" && r.request.name === "خالد");
  check("4ز: حالة الانتظار اتمسحت بعد الطلب", store.getPending("966502222222") === null);

  console.log("\n=== 4ح) clearGroups بيشيل الربط الثلاثة كلهم دفعة واحدة (لأمر تفكيك مجموعات التوصيل) ===");
  store.setGroup("NORTH", "999@g.us");
  store.setGroup("SOUTH", "999@g.us");
  store.setGroup("CENTER", "999@g.us");
  check("4ط: التلاتة مربوطين قبل التفكيك", Object.keys(store.getGroups()).length === 3);
  store.clearGroups();
  check("4ي: مفيش أي مجموعة مربوطة بعد clearGroups", Object.keys(store.getGroups()).length === 0);

  console.log("\n=== 5) توجيه الطلب لمجموعة المنطقة الصح فقط ===");
  store.setGroup("NORTH", "111@g.us");
  store.setGroup("SOUTH", "222@g.us");
  store.setGroup("CENTER", "333@g.us");
  const sent = [];
  const fakeClient = { sendMessage: async (to, text) => { sent.push({ to, text }); return true; } };
  const fwd = await flow.forwardRequest(fakeClient, r.request);
  check("5: اتبعت مرة واحدة لمجموعة الجنوب بس", fwd.ok && sent.length === 1 && sent[0].to === "222@g.us");
  check("5ب: نص المجموعة فيه الاسم ورابط wa.me والمنطقة ومعرّف الطلب واليوم/الوقت", sent[0].text.includes("خالد") && sent[0].text.includes("https://wa.me/966502222222") && sent[0].text.includes("الجنوب") && sent[0].text.includes(r.request.id) && sent[0].text.includes("الأحد الساعة 10 صباحًا"));
  check("5ج: الطلب متعلّم كمُرسل", store.listOpenRequests().find((x) => x.id === r.request.id).forwarded === true);

  store.markAwaitingChoice("966503333333", "سعد");
  flow.handleReply("966503333333", "2", getText);
  flow.handleReply("966503333333", "1", getText);
  const r3 = flow.handleReply("966503333333", "غدًا صباحًا", getText);
  const sent2 = [];
  await flow.forwardRequest({ sendMessage: async (to) => { sent2.push(to); } }, r3.request);
  check("5د: منطقة 1 = الشمال -> مجموعة الشمال", sent2.length === 1 && sent2[0] === "111@g.us");

  console.log("\n=== 6) مجموعة مش مربوطة أو فشل إرسال: الطلب ما بيضيعش ===");
  fs.unlinkSync(path.join(ROOT, "delivery_state.json"));
  if (fs.existsSync(path.join(ROOT, "delivery_state.json.bak"))) fs.unlinkSync(path.join(ROOT, "delivery_state.json.bak"));
  store.markAwaitingChoice("966504444444", "ماجد");
  flow.handleReply("966504444444", "2", getText);
  flow.handleReply("966504444444", "3", getText);
  const r4 = flow.handleReply("966504444444", "الخميس بعد الظهر", getText);
  const noSend = [];
  const res4 = await flow.forwardRequest({ sendMessage: async (to) => noSend.push(to) }, r4.request);
  check("6: مفيش مجموعة مربوطة -> مفيش إرسال والطلب محفوظ بتنبيه", !res4.ok && noSend.length === 0 && store.listOpenRequests()[0].forwarded === false);
  store.setGroup("CENTER", "333@g.us");
  const res5 = await flow.forwardRequest({ sendMessage: async () => { throw new Error("boom"); } }, r4.request);
  check("6ب: فشل إرسال -> الطلب محفوظ ومسجّل سبب الفشل", !res5.ok && store.listOpenRequests()[0].forwardError === "boom");

  console.log("\n=== 7) تم التوصيل + ذاكرة @lid ===");
  const done = store.markDelivered(r4.request.id.toLowerCase());
  check("7: تم التوصيل بيقفل الطلب", done && done.status === "DELIVERED" && store.listOpenRequests().length === 0);
  store.cacheLid("999@lid", "966505555555");
  check("7ب: ذاكرة @lid", store.lookupLid("999@lid") === "966505555555");

  console.log("\n=== 7ج) تحديد المنطقة تلقائيًا من الموقع (KMZ 14 منطقة زراعية -> 3 مناطق توصيل) ===");
  {
    // من غير حالة انتظار: مش مُعالَج
    check("7ج: من غير حالة انتظار، الموقع مش مُعالَج", flow.handleLocation("966506666666", 26.6260, 37.9265, getText).handled === false);

    // في خطوة CHOICE (لسه ما اختارش توصيل) - الموقع مش المفروض يتفعّل غير في خطوة REGION بالظبط
    store.markAwaitingChoice("966506666666", "سالم");
    check("7د: في خطوة CHOICE، الموقع مش مُعالَج (لسه محتاج يختار توصيل الأول)", flow.handleLocation("966506666666", 26.6260, 37.9265, getText).handled === false);

    flow.handleReply("966506666666", "2", getText); // اختار توصيل -> بقى في خطوة REGION
    // نقطة مركز "AlUla" الفعلية من ملف مناطق_مركز_الزراعة_العلا.kmz الرسمي -> المفروض تتصنّف "الشمال"
    let r = flow.handleLocation("966506666666", 26.626, 37.9265, getText);
    check("7هـ: موقع داخل منطقة AlUla -> اتصنّف الشمال تلقائيًا، وينتقل لخطوة اليوم/الوقت", r.handled && !r.request && r.reply === "ASK_DATETIME" && store.getPending("966506666666").step === "DATETIME" && store.getPending("966506666666").regionKey === "NORTH" && store.getPending("966506666666").district === "AlUla" && store.getPending("966506666666").autoDetected === true && store.getPending("966506666666").latitude === 26.626);
    r = flow.handleReply("966506666666", "الاثنين صباحًا", getText);
    check("7و: بعد كتابة الوقت، الطلب اتسجّل بالمنطقة التلقائية وحالة الانتظار اتمسحت والإحداثيات محفوظة", r.request && r.request.regionKey === "NORTH" && r.request.district === "AlUla" && r.request.autoDetected === true && r.request.preferredDateTime === "الاثنين صباحًا" && r.request.latitude === 26.626 && r.request.longitude === 37.9265 && r.reply === "THANKS الشمال" && store.getPending("966506666666") === null);
    const alUlaRequest = r.request;

    // نقطة مركز "Al Ibriq" -> المفروض الجنوب
    store.markAwaitingChoice("966507777777", "منى");
    flow.handleReply("966507777777", "2", getText);
    flow.handleLocation("966507777777", 25.7152, 38.6513, getText);
    r = flow.handleReply("966507777777", "أي وقت مناسب", getText);
    check("7ز: موقع داخل منطقة Al Ibriq -> اتصنّف الجنوب تلقائيًا", r.request && r.request.regionKey === "SOUTH" && r.request.district === "Al Ibriq");

    // موقع برّه كل المناطق الـ14 المعروفة (زي وسط البحر الأحمر) -> ممنوع نخمّن، نطلب اختيار يدوي
    store.markAwaitingChoice("966508888888", "فيصل");
    flow.handleReply("966508888888", "2", getText);
    r = flow.handleLocation("966508888888", 22.0, 39.0, getText);
    check("7ح: موقع خارج كل المناطق المعروفة -> رسالة توضيحية بدون تخمين، وحالة الانتظار فاضلة في REGION", r.handled && !r.request && r.reply === "LOCATION_UNKNOWN" && store.getPending("966508888888").step === "REGION");

    // نص رسالة المجموعة يوضّح إن المنطقة اتحددت تلقائيًا من الموقع
    const groupText = flow.formatGroupMessage(store.listOpenRequests().find((x) => x.regionKey === "NORTH"));
    check("7ط: نص المجموعة يوضّح 'محدَّدة تلقائيًا من الموقع' واسم المنطقة الفعلية (AlUla) والوقت المفضّل", groupText.includes("محدَّدة تلقائيًا من الموقع") && groupText.includes("AlUla") && groupText.includes("الاثنين صباحًا"));

    // لما الطلب فيه إحداثيات فعلية (اتحدد من موقع، مش رقم منطقة يدوي)، forwardRequest المفروض
    // يبعت رسالة نصية + pin موقع حقيقي كمان (Location) عشان فريق التوصيل يفتحه على الخريطة مباشرة
    console.log("\n=== 7ي) forwardRequest بيبعت pin موقع حقيقي لو الطلب فيه إحداثيات ===");
    store.setGroup("NORTH", "444@g.us");
    const sentWithLocation = [];
    const fwdWithLocation = await flow.forwardRequest(
      { sendMessage: async (to, content) => { sentWithLocation.push({ to, content }); return true; } },
      alUlaRequest
    );
    check(
      "7ي: اتبعتت رسالتين لمجموعة الشمال - نص المجموعة + pin موقع بنفس الإحداثيات",
      fwdWithLocation.ok &&
        sentWithLocation.length === 2 &&
        sentWithLocation.every((s) => s.to === "444@g.us") &&
        typeof sentWithLocation[0].content === "string" &&
        sentWithLocation[1].content.latitude === 26.626 &&
        sentWithLocation[1].content.longitude === 37.9265
    );

    // طلب اتحدد برقم منطقة يدوي (مفيش إحداثيات) - forwardRequest يبعت النص بس، من غير pin موقع
    console.log("\n=== 7ك) forwardRequest ما بيبعتش pin موقع لطلب اتحدد يدويًا (من غير إحداثيات) ===");
    const sentNoLocation = [];
    const fwdNoLocation = await flow.forwardRequest(
      { sendMessage: async (to, content) => { sentNoLocation.push({ to, content }); return true; } },
      r3.request // من قسم (5): منطقة اتحددت برقم يدوي "1"، مفيش latitude/longitude خالص
    );
    check("7ك: طلب يدوي (من غير إحداثيات) - رسالة واحدة بس (نص المجموعة)، من غير pin موقع", fwdNoLocation.ok && sentNoLocation.length === 1);
  }

  console.log("\n=== 8) Hook onSent في runPersonalizedBroadcast (نفس رسالة الاستلام + fake client) ===");
  const { runPersonalizedBroadcast } = require("../lib/personalizedRunner");
  const csv = path.join(os.tmpdir(), `pickup_${Date.now()}.csv`);
  fs.writeFileSync(csv, "أحمد سالم,0509999999\n", "utf8");
  const calls = [];
  const client = { getNumberId: async (p) => ({ _serialized: `${p}@c.us` }), sendMessage: async () => true };
  const summary = await runPersonalizedBroadcast(client, {
    csvPath: csv, columns: ["name", "phone"], template: "عزيزي {name} 1- استلام 2- توصيل",
    logFile: path.join(os.tmpdir(), `pickup_log_${Date.now()}.txt`), logLabel: "اختبار", campaignType: "card_pickup", messageSource: "SYSTEM_NOTIFICATION",
    onSent: (info) => calls.push(info),
  });
  check("8: الإرسال نجح والـhook اتنادى مرة واحدة بالرقم والاسم", summary.sent === 1 && calls.length === 1 && calls[0].phone === "966509999999" && calls[0].name === "أحمد سالم");
  fs.unlinkSync(csv);

  console.log("\n=== 9) صفر واتساب حقيقي / منطق التوصيل فيه استدعاء واحد بس للإرسال الحقيقي ===");
  const cfgSrc = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  check("9: CARD_PICKUP_TEMPLATE الرسمي الجديد موجود بالكامل", cfgSrc.includes("يسرّنا إشعاركم بجاهزية بطاقة") && cfgSrc.includes("الاستلام المباشر: من مركز الزراعة بحي ساق"));
  const flowSrc = fs.readFileSync(path.join(ROOT, "lib", "deliveryFlow.js"), "utf8") + fs.readFileSync(path.join(ROOT, "lib", "deliveryStore.js"), "utf8");
  // استدعاءين بس: نص رسالة المجموعة + pin الموقع (لو الطلب فيه إحداثيات) - الاتنين لمجموعة المنطقة بس
  check("9ب: منطق التوصيل مفيهوش أي استدعاء واتساب غير client.sendMessage (نص + pin موقع اختياري) لمجموعة المنطقة", (flowSrc.match(/sendMessage/g) || []).length === 2);

  console.log(`\n🎉 كل اختبارات حوار الاستلام/التوصيل نجحت (${passed} اختبار). صفر رسائل واتساب حقيقية.`);
}

run()
  .then(() => { wipe(); restore(snap); console.log("♻️ تم استرجاع كل ملفات البيانات الحقيقية زي ما كانت قبل الاختبار."); })
  .catch((err) => { console.error("💥 فشل الاختبار:", err.message); wipe(); restore(snap); console.log("♻️ تم استرجاع ملفات البيانات (بعد فشل)."); process.exit(1); });
