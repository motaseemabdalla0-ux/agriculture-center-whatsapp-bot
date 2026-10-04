process.env.RATE_LIMIT_HOURLY = process.env.RATE_LIMIT_HOURLY || "1000";
process.env.RATE_LIMIT_DAILY = process.env.RATE_LIMIT_DAILY || "1000";
process.env.CAMPAIGN_TEST_FAST = "true";
// اختبارات حوار "استلام/توصيل البطاقة" (الموقع الفعلي هو الأساس لتحديد المنطقة تلقائيًا - رقم
// منطقة يدوي متاح بس كـfallback) + توجيه الطلب لمجموعة المنطقة. Fake Client بس - صفر واتساب
// حقيقي، وبيرجّع كل ملفات البيانات الحقيقية زي ما كانت في الآخر.
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
  DELIVERY_LOCATION_UNKNOWN: "LOCATION_UNKNOWN",
  DELIVERY_ASK_DATETIME: "ASK_DATETIME",
  DELIVERY_REMINDER_DATETIME: "REMIND_DATETIME",
  DELIVERY_REGION_CORRECTED: "REGION_CORRECTED {region}",
  DELIVERY_OUTSIDE_HOURS: "OUTSIDE_HOURS",
  DELIVERY_THANKS: "THANKS {region}",
};
const getText = (k) => TEXTS[k];

const snap = snapshot();
wipe();

async function run() {
  const store = require("../lib/deliveryStore");
  const flow = require("../lib/deliveryFlow");
  const cfg = require("../config");

  console.log("\n=== 1) رسالة الاستلام الرسمية بتفعّل حالة الانتظار (فيها خيار توصيل) ===");
  check("1: CARD_PICKUP_TEMPLATE الرسمي فيه خيار توصيل -> بيفعّل حالة الانتظار", store.templateOffersDelivery(cfg.CARD_PICKUP_TEMPLATE) === true);
  check("1ب: نص فيه كلمة توصيل بيفعّل الحالة", store.templateOffersDelivery("1- الاستلام 2- توصيل البطاقة") === true);

  console.log("\n=== 2) من غير حالة انتظار: مش مُعالَج (يكمّل قائمة البوت العادية) ===");
  check("2: handled=false", flow.handleReply("966501111111", "2", getText).handled === false);

  console.log("\n=== 3) استلام من المركز (1) ===");
  store.markAwaitingChoice("966501111111", "أحمد");
  let r = flow.handleReply("966501111111", "1", getText);
  check("3: رد تأكيد الاستلام", r.handled && r.reply === "PICKUP_OK" && !r.request);
  check("3ب: حالة الانتظار اتمسحت", flow.handleReply("966501111111", "1", getText).handled === false);

  console.log("\n=== 4) توصيل (2) ثم موقع فعلي يحدد المنطقة تلقائيًا ثم يوم/وقت ===");
  store.markAwaitingChoice("966502222222", "خالد");
  r = flow.handleReply("966502222222", "hello", getText);
  check("4: رد غير صحيح -> تذكير بالخيارين وتفضل الحالة", r.handled && r.reply === "REMIND_CHOICE" && store.getPending("966502222222").step === "CHOICE");
  r = flow.handleReply("966502222222", "2", getText);
  check("4ب: اختيار توصيل -> طلب الموقع (أو رقم يدوي)", r.reply === "ASK_REGION" && store.getPending("966502222222").step === "REGION");
  // نقطة مركز "Al Ibriq" الفعلية من ملف مناطق_مركز_الزراعة_العلا.kmz الرسمي -> المفروض الجنوب تلقائيًا
  r = flow.handleLocation("966502222222", 25.7152, 38.6513, getText);
  check("4ج: موقع فعلي -> تحديد الجنوب تلقائيًا وينتقل لخطوة اليوم/الوقت، مفيش طلب لسه", r.handled && !r.request && r.reply === "ASK_DATETIME" && store.getPending("966502222222").step === "DATETIME" && store.getPending("966502222222").regionKey === "SOUTH" && store.getPending("966502222222").district === "Al Ibriq" && store.getPending("966502222222").autoDetected === true && store.getPending("966502222222").latitude === 25.7152);
  r = flow.handleReply("966502222222", "ح", getText);
  check("4د: يوم/وقت قصير جدًا -> تذكير ولا يتسجّل طلب", r.reply === "REMIND_DATETIME" && !r.request && store.getPending("966502222222").step === "DATETIME");
  r = flow.handleReply("966502222222", "الأحد الساعة 5 مساء", getText);
  check("4د2: وقت برّه الدوام (5 مساء) -> رسالة خارج أوقات العمل، مفيش طلب، ولسه مستني وقت صحيح", r.handled && r.reply === "OUTSIDE_HOURS" && !r.request && store.getPending("966502222222").step === "DATETIME");
  r = flow.handleReply("966502222222", "الأحد الساعة 10 صباحًا", getText);
  check(
    "4هـ: يوم/وقت صحيح -> الطلب اتسجّل بالمنطقة التلقائية + الموقع + الوقت",
    r.handled && r.request && r.request.regionKey === "SOUTH" && r.request.district === "Al Ibriq" && r.request.autoDetected === true &&
      r.request.latitude === 25.7152 && r.request.longitude === 38.6513 &&
      r.request.preferredDateTime === "الأحد الساعة 10 صباحًا" && r.reply === "THANKS الجنوب" && r.request.name === "خالد"
  );
  check("4و: حالة الانتظار اتمسحت بعد الطلب", store.getPending("966502222222") === null);
  const khaledRequest = r.request;

  console.log("\n=== 4ز) الموقع إلزامي - رقم منطقة (حتى لو صحيح شكليًا) بيترفض قبل أي محاولة موقع ===");
  store.markAwaitingChoice("966502333333", "منصور");
  flow.handleReply("966502333333", "2", getText);
  r = flow.handleReply("966502333333", "3", getText); // رقم منطقة صحيح شكليًا، بس قبل أي محاولة موقع خالص
  check("4ح: رقم منطقة قبل أي محاولة موقع -> يترفض ويتذكّر بإرسال الموقع، مش بيتقبل كبديل", r.reply === "REMIND_REGION" && !r.request && store.getPending("966502333333").step === "REGION" && !store.getPending("966502333333").locationFailed);
  r = flow.handleLocation("966502333333", 22.0, 39.0, getText); // موقع فعلي برّه كل المناطق المعروفة -> فشل تصنيف
  check("4ط: فشل تصنيف موقع فعلي -> دلوقتي رقم يدوي بقى مقبول كـfallback", r.reply === "LOCATION_UNKNOWN" && store.getPending("966502333333").locationFailed === true);
  r = flow.handleReply("966502333333", "9", getText); // رقم غير صحيح
  check("4ي: رقم غير صحيح بعد فشل الموقع -> تذكير بالمناطق (LOCATION_UNKNOWN) تاني", r.reply === "LOCATION_UNKNOWN" && !r.request);
  r = flow.handleReply("966502333333", "3", getText);
  check("4ك: رقم يدوي 3 = الوسط بعد فشل الموقع -> ينتقل لخطوة اليوم/الوقت، مفيش تحديد تلقائي", r.handled && !r.request && r.reply === "ASK_DATETIME" && store.getPending("966502333333").regionKey === "CENTER" && store.getPending("966502333333").autoDetected === false && store.getPending("966502333333").district === null);
  r = flow.handleReply("966502333333", "غدًا صباحًا", getText);
  check("4ل: الطلب اتسجّل بالمنطقة اليدوية (autoDetected=false)", r.request && r.request.regionKey === "CENTER" && r.request.autoDetected === false);

  console.log("\n=== 4ن) تصحيح المنطقة تلقائيًا لو موقع لاحق مختلف عن الاختيار اليدوي (بعد fallback) ===");
  store.markAwaitingChoice("966502444444", "فيصل");
  flow.handleReply("966502444444", "2", getText);
  flow.handleLocation("966502444444", 22.0, 39.0, getText); // فشل موقع الأول - بيفتح الـfallback اليدوي
  r = flow.handleReply("966502444444", "1", getText); // اختار الشمال يدويًا (fallback)
  check("4س: اختار الشمال يدويًا بعد فشل الموقع -> ASK_DATETIME", r.reply === "ASK_DATETIME" && store.getPending("966502444444").regionKey === "NORTH" && store.getPending("966502444444").autoDetected === false);
  // لكن موقعه الفعلي (Al Ibriq) في الجنوب فعليًا - المفروض يصحح المنطقة تلقائيًا
  r = flow.handleLocation("966502444444", 25.7152, 38.6513, getText);
  check("4ع: موقع فعلي مختلف عن الاختيار اليدوي -> تصحيح تلقائي للمنطقة الصح (الجنوب) وفضل في خطوة اليوم/الوقت", r.handled && !r.request && r.reply === "REGION_CORRECTED الجنوب" && store.getPending("966502444444").step === "DATETIME" && store.getPending("966502444444").regionKey === "SOUTH" && store.getPending("966502444444").autoDetected === true && store.getPending("966502444444").district === "Al Ibriq");
  r = flow.handleReply("966502444444", "الثلاثاء ظهرًا", getText);
  check("4ف: الطلب النهائي اتسجّل بالمنطقة المصحَّحة (الجنوب) مش المنطقة اليدوية الأصلية (الشمال)", r.request && r.request.regionKey === "SOUTH" && r.request.autoDetected === true);
  // موقع تاني بعد ما المنطقة اتصححت بالفعل ونفس المنطقة (الجنوب) - مفيش "تصحيح" يتقال، رد عادي
  store.markAwaitingChoice("966502555555", "هند");
  flow.handleReply("966502555555", "2", getText);
  flow.handleLocation("966502555555", 25.7152, 38.6513, getText); // الجنوب تلقائيًا من الأول
  r = flow.handleLocation("966502555555", 25.7152, 38.6513, getText); // نفس الموقع تاني في خطوة DATETIME
  check("4ص: موقع تاني بنفس المنطقة (مفيش تغيير فعلي) -> رد عادي (ASK_DATETIME) مش رسالة تصحيح", r.reply === "ASK_DATETIME");

  console.log("\n=== 4ك) clearGroups بيشيل الربط الثلاثة كلهم دفعة واحدة (لأمر تفكيك مجموعات التوصيل) ===");
  store.setGroup("NORTH", "999@g.us");
  store.setGroup("SOUTH", "999@g.us");
  store.setGroup("CENTER", "999@g.us");
  check("4ل: التلاتة مربوطين قبل التفكيك", Object.keys(store.getGroups()).length === 3);
  store.clearGroups();
  check("4م: مفيش أي مجموعة مربوطة بعد clearGroups", Object.keys(store.getGroups()).length === 0);

  console.log("\n=== 5) توجيه الطلب لمجموعة المنطقة الصح فقط + pin الموقع (لما اتحددت من موقع فعلي) ===");
  store.setGroup("NORTH", "111@g.us");
  store.setGroup("SOUTH", "222@g.us");
  store.setGroup("CENTER", "333@g.us");
  const sent = [];
  const fakeClient = { sendMessage: async (to, content) => { sent.push({ to, content }); return true; } };
  const fwd = await flow.forwardRequest(fakeClient, khaledRequest);
  check("5: اتبعتت رسالتين لمجموعة الجنوب بس (نص + pin موقع)", fwd.ok && sent.length === 2 && sent.every((s) => s.to === "222@g.us"));
  check("5ب: نص المجموعة فيه الاسم ورابط wa.me والمنطقة والمنطقة الزراعية الدقيقة ومعرّف الطلب واليوم/الوقت وتنويه التحديد التلقائي", typeof sent[0].content === "string" && sent[0].content.includes("خالد") && sent[0].content.includes("https://wa.me/966502222222") && sent[0].content.includes("الجنوب") && sent[0].content.includes("Al Ibriq") && sent[0].content.includes(khaledRequest.id) && sent[0].content.includes("الأحد الساعة 10 صباحًا") && sent[0].content.includes("محدَّدة تلقائيًا من الموقع"));
  check("5ج: الرسالة التانية pin موقع حقيقي بنفس الإحداثيات", sent[1].content.latitude === 25.7152 && sent[1].content.longitude === 38.6513);
  check("5د: الطلب متعلّم كمُرسل", store.listOpenRequests().find((x) => x.id === khaledRequest.id).forwarded === true);

  // مزارع تاني بموقعه برّه كل المناطق الـ14 المعروفة (زي وسط البحر الأحمر) - ممنوع نخمّن، لازم يرجع لرقم يدوي
  console.log("\n=== 5هـ) موقع برّه كل المناطق المعروفة -> رسالة توضيحية بدون تخمين، وفضل يقبل رقم يدوي ===");
  store.markAwaitingChoice("966503333333", "سعد");
  flow.handleReply("966503333333", "2", getText);
  r = flow.handleLocation("966503333333", 22.0, 39.0, getText);
  check("5و: موقع خارج كل المناطق المعروفة -> رسالة توضيحية، وحالة الانتظار فاضلة في REGION", r.handled && !r.request && r.reply === "LOCATION_UNKNOWN" && store.getPending("966503333333").step === "REGION");
  r = flow.handleReply("966503333333", "1", getText);
  check("5ز: بعد فشل الموقع، رقم يدوي 1 = الشمال بيشتغل عادي", r.handled && !r.request && r.reply === "ASK_DATETIME" && store.getPending("966503333333").regionKey === "NORTH" && store.getPending("966503333333").autoDetected === false);
  const r3 = flow.handleReply("966503333333", "غدًا صباحًا", getText);
  const sent2 = [];
  await flow.forwardRequest({ sendMessage: async (to) => { sent2.push(to); } }, r3.request);
  check("5ح: منطقة 1 = الشمال (اختيار يدوي بعد فشل الموقع) -> مجموعة الشمال، رسالة نصية بس (من غير pin - المنطقة اتحددت يدويًا مش من موقع)", sent2.length === 1 && sent2[0] === "111@g.us");

  console.log("\n=== 6) مجموعة مش مربوطة أو فشل إرسال: الطلب ما بيضيعش ===");
  fs.unlinkSync(path.join(ROOT, "delivery_state.json"));
  if (fs.existsSync(path.join(ROOT, "delivery_state.json.bak"))) fs.unlinkSync(path.join(ROOT, "delivery_state.json.bak"));
  store.markAwaitingChoice("966504444444", "ماجد");
  flow.handleReply("966504444444", "2", getText);
  flow.handleLocation("966504444444", 22.0, 39.0, getText); // فشل الموقع الأول - بيفتح الـfallback اليدوي
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

  console.log("\n=== 9) صفر واتساب حقيقي / منطق التوصيل فيه استدعاءين بس للإرسال الحقيقي ===");
  const cfgSrc = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  check("9: CARD_PICKUP_TEMPLATE الرسمي موجود بالكامل", cfgSrc.includes("يسرّنا إشعاركم بجاهزية بطاقة المزارع") && cfgSrc.includes("من مركز الزراعة بحي ساق"));
  const flowSrc = fs.readFileSync(path.join(ROOT, "lib", "deliveryFlow.js"), "utf8") + fs.readFileSync(path.join(ROOT, "lib", "deliveryStore.js"), "utf8");
  // استدعاءين بس: نص رسالة المجموعة + pin الموقع - الاتنين لمجموعة المنطقة بس
  check("9ب: منطق التوصيل مفيهوش أي استدعاء واتساب غير client.sendMessage (نص + pin موقع) لمجموعة المنطقة", (flowSrc.match(/sendMessage/g) || []).length === 2);

  console.log("\n=== 10) getAllPending + sentTracker.unmarkSent (لإعادة إرسال إشعار الاستلام لمن لسه في انتظار قرار) ===");
  const sentTracker = require("../lib/sentTracker");
  store.markAwaitingChoice("966510000001", "منصور");
  store.markAwaitingChoice("966510000002", "فهد");
  flow.handleReply("966510000002", "1", getText); // ده حسم قراره (استلام) - المفروض يختفي من getAllPending
  const allPending = store.getAllPending();
  check("10: getAllPending بترجع بس اللي لسه في انتظار (مش اللي حسموا قرارهم)", allPending.some((p) => p.phone === "966510000001") && !allPending.some((p) => p.phone === "966510000002"));
  sentTracker.markSent("card_pickup", "966510000001");
  check("10ب: markSent + hasBeenSent شغالين", sentTracker.hasBeenSent("card_pickup", "966510000001") === true);
  check("10ج: unmarkSent بيشيل الرقم فعليًا", sentTracker.unmarkSent("card_pickup", "966510000001") === true && sentTracker.hasBeenSent("card_pickup", "966510000001") === false);
  check("10د: unmarkSent لرقم مش موجود أصلًا بيرجع false", sentTracker.unmarkSent("card_pickup", "966599999999") === false);
  sentTracker.markSent("card_pickup", "966510000003");
  check("10هـ: getSentList بترجع كل الأرقام المسجّلة لنوع معيّن", sentTracker.getSentList("card_pickup").includes("966510000003") && sentTracker.getSentList("nonexistent_type").length === 0);

  console.log("\n=== 11) groupNameMatchesRegion (التحقق من اسم مجموعة التوصيل مقابل منطقتها) ===");
  check("11: اسم فيه كلمة المنطقة (من غير أداة التعريف) -> مطابق", store.groupNameMatchesRegion("NORTH", "توصيل بطاقات - الشمال") === true);
  check("11ب: اسم منطقة تانية تمامًا -> مش مطابق", store.groupNameMatchesRegion("NORTH", "توصيل بطاقات - الجنوب") === false);
  check("11ج: اسم عام بدون ذكر أي منطقة -> مش مطابق", store.groupNameMatchesRegion("CENTER", "مجموعة الفريق") === false);
  check("11د: منطقة غير معروفة أو اسم فاضي -> false من غير كراش", store.groupNameMatchesRegion("UNKNOWN", "أي اسم") === false && store.groupNameMatchesRegion("NORTH", "") === false);

  console.log(`\n🎉 كل اختبارات حوار الاستلام/التوصيل نجحت (${passed} اختبار). صفر رسائل واتساب حقيقية.`);
}

run()
  .then(() => { wipe(); restore(snap); console.log("♻️ تم استرجاع كل ملفات البيانات الحقيقية زي ما كانت قبل الاختبار."); })
  .catch((err) => { console.error("💥 فشل الاختبار:", err.message); wipe(); restore(snap); console.log("♻️ تم استرجاع ملفات البيانات (بعد فشل)."); process.exit(1); });
