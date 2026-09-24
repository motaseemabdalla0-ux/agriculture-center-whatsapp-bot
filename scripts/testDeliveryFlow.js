process.env.RATE_LIMIT_HOURLY = process.env.RATE_LIMIT_HOURLY || "1000";
process.env.RATE_LIMIT_DAILY = process.env.RATE_LIMIT_DAILY || "1000";
process.env.CAMPAIGN_TEST_FAST = "true";
// اختبارات حوار "استلام/توصيل البطاقة" + توجيه الطلب لمجموعة المنطقة. Fake Client بس - صفر واتساب
// حقيقي، وبيرجّع كل ملفات البيانات الحقيقية زي ما كانت في الآخر (نجح أو فشل).
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
  DELIVERY_THANKS: "THANKS {region}",
};
const getText = (k) => TEXTS[k];

const snap = snapshot();
wipe();

async function run() {
  const store = require("../lib/deliveryStore");
  const flow = require("../lib/deliveryFlow");
  const cfg = require("../config");

  console.log("\n=== 1) رسالة الاستلام الحالية ما اتعدّلتش، وحالة الانتظار مش بتتفعّل بيها ===");
  check("1: CARD_PICKUP_TEMPLATE الحالي مفيهوش خيار توصيل -> مفيش حالة انتظار", store.templateOffersDelivery(cfg.CARD_PICKUP_TEMPLATE) === false);
  check("1ب: نص فيه كلمة توصيل بيفعّل الحالة", store.templateOffersDelivery("1- الاستلام 2- توصيل البطاقة") === true);

  console.log("\n=== 2) من غير حالة انتظار: مش مُعالَج (يكمّل قائمة البوت العادية) ===");
  check("2: handled=false", flow.handleReply("966501111111", "2", getText).handled === false);

  console.log("\n=== 3) استلام من المركز (1) ===");
  store.markAwaitingChoice("966501111111", "أحمد");
  let r = flow.handleReply("966501111111", "1", getText);
  check("3: رد تأكيد الاستلام", r.handled && r.reply === "PICKUP_OK" && !r.request);
  check("3ب: حالة الانتظار اتمسحت", flow.handleReply("966501111111", "1", getText).handled === false);

  console.log("\n=== 4) توصيل (2) ثم منطقة ===");
  store.markAwaitingChoice("966502222222", "خالد");
  r = flow.handleReply("966502222222", "hello", getText);
  check("4: رد غير صحيح -> تذكير بالخيارين وتفضل الحالة", r.handled && r.reply === "REMIND_CHOICE" && store.getPending("966502222222").step === "CHOICE");
  r = flow.handleReply("966502222222", "2", getText);
  check("4ب: اختيار توصيل -> سؤال المنطقة", r.reply === "ASK_REGION" && store.getPending("966502222222").step === "REGION");
  r = flow.handleReply("966502222222", "9", getText);
  check("4ج: منطقة غير صحيحة -> تذكير بالمناطق", r.reply === "REMIND_REGION" && !r.request);
  r = flow.handleReply("966502222222", "2", getText);
  check("4د: منطقة 2 = الجنوب، طلب اتسجّل", r.handled && r.request && r.request.regionKey === "SOUTH" && r.reply === "THANKS الجنوب" && r.request.name === "خالد");
  check("4هـ: حالة الانتظار اتمسحت بعد الطلب", store.getPending("966502222222") === null);

  console.log("\n=== 5) توجيه الطلب لمجموعة المنطقة الصح فقط ===");
  store.setGroup("NORTH", "111@g.us");
  store.setGroup("SOUTH", "222@g.us");
  store.setGroup("CENTER", "333@g.us");
  const sent = [];
  const fakeClient = { sendMessage: async (to, text) => { sent.push({ to, text }); return true; } };
  const fwd = await flow.forwardRequest(fakeClient, r.request);
  check("5: اتبعت مرة واحدة لمجموعة الجنوب بس", fwd.ok && sent.length === 1 && sent[0].to === "222@g.us");
  check("5ب: نص المجموعة فيه الاسم ورابط wa.me والمنطقة ومعرّف الطلب", sent[0].text.includes("خالد") && sent[0].text.includes("https://wa.me/966502222222") && sent[0].text.includes("الجنوب") && sent[0].text.includes(r.request.id));
  check("5ج: الطلب متعلّم كمُرسل", store.listOpenRequests().find((x) => x.id === r.request.id).forwarded === true);

  store.markAwaitingChoice("966503333333", "سعد");
  flow.handleReply("966503333333", "2", getText);
  const r3 = flow.handleReply("966503333333", "1", getText);
  const sent2 = [];
  await flow.forwardRequest({ sendMessage: async (to) => { sent2.push(to); } }, r3.request);
  check("5د: منطقة 1 = الشمال -> مجموعة الشمال", sent2.length === 1 && sent2[0] === "111@g.us");

  console.log("\n=== 6) مجموعة مش مربوطة أو فشل إرسال: الطلب ما بيضيعش ===");
  fs.unlinkSync(path.join(ROOT, "delivery_state.json"));
  if (fs.existsSync(path.join(ROOT, "delivery_state.json.bak"))) fs.unlinkSync(path.join(ROOT, "delivery_state.json.bak"));
  store.markAwaitingChoice("966504444444", "ماجد");
  flow.handleReply("966504444444", "2", getText);
  const r4 = flow.handleReply("966504444444", "3", getText);
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
  fs.writeFileSync(csv, "أحمد سالم,0506666666\n", "utf8");
  const calls = [];
  const client = { getNumberId: async (p) => ({ _serialized: `${p}@c.us` }), sendMessage: async () => true };
  const summary = await runPersonalizedBroadcast(client, {
    csvPath: csv, columns: ["name", "phone"], template: "عزيزي {name} 1- استلام 2- توصيل",
    logFile: path.join(os.tmpdir(), `pickup_log_${Date.now()}.txt`), logLabel: "اختبار", campaignType: "card_pickup", messageSource: "SYSTEM_NOTIFICATION",
    onSent: (info) => calls.push(info),
  });
  check("8: الإرسال نجح والـhook اتنادى مرة واحدة بالرقم والاسم", summary.sent === 1 && calls.length === 1 && calls[0].phone === "966506666666" && calls[0].name === "أحمد سالم");
  fs.unlinkSync(csv);

  console.log("\n=== 9) صفر واتساب حقيقي / رسالة الاستلام الأصلية ما اتلمستش ===");
  const cfgSrc = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  check("9: CARD_PICKUP_TEMPLATE سليم (إبراز الهوية) وبدون خيار توصيل", cfgSrc.includes("نفيدكم بجاهزية بطاقة المزرعة للاستلام من مركز الزراعة – حي ساق") && !/CARD_PICKUP_TEMPLATE: `[^`]*توصيل/.test(cfgSrc));
  const flowSrc = fs.readFileSync(path.join(ROOT, "lib", "deliveryFlow.js"), "utf8") + fs.readFileSync(path.join(ROOT, "lib", "deliveryStore.js"), "utf8");
  check("9ب: منطق التوصيل مفيهوش أي استدعاء واتساب غير client.sendMessage لمجموعة المنطقة", (flowSrc.match(/sendMessage/g) || []).length === 1);

  console.log(`\n🎉 كل اختبارات حوار الاستلام/التوصيل نجحت (${passed} اختبار). صفر رسائل واتساب حقيقية.`);
}

run()
  .then(() => { wipe(); restore(snap); console.log("♻️ تم استرجاع كل ملفات البيانات الحقيقية زي ما كانت قبل الاختبار."); })
  .catch((err) => { console.error("💥 فشل الاختبار:", err.message); wipe(); restore(snap); console.log("♻️ تم استرجاع ملفات البيانات (بعد فشل)."); process.exit(1); });
