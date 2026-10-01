// اختبارات تقرير طلبات التوصيل اليومي (مقسّم شمال/جنوب/وسط). صفر واتساب حقيقي - بناء وتنسيق
// بس، وبيرجّع ملف البيانات الحقيقي delivery_state.json زي ما كان بعد الاختبار
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = ["delivery_state.json", "delivery_state.json.bak"];
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

const snap = snapshot();
wipe();

function run() {
  const store = require("../lib/deliveryStore");
  const { buildDeliveryDailyReport, formatDeliveryDailyReport } = require("../lib/deliveryReport");

  console.log("\n=== 1) تقرير فاضي (مفيش طلبات توصيل مفتوحة) ===");
  let data = buildDeliveryDailyReport();
  check("1: الإجمالي صفر", data.total === 0);
  const emptyText = formatDeliveryDailyReport(data);
  check("1ب: النص بيوضّح إنه مفيش طلبات", emptyText.includes("لا يوجد طلبات توصيل مفتوحة"));

  console.log("\n=== 2) تقرير فيه طلبات في المناطق الثلاثة ===");
  store.createRequest({ phone: "966501111111", name: "أحمد", regionKey: "NORTH", district: "AlUla", autoDetected: true, preferredDateTime: "الأحد 10 صباحًا" });
  store.createRequest({ phone: "966502222222", name: "خالد", regionKey: "SOUTH", district: "Al Ibriq", autoDetected: true, preferredDateTime: "الاثنين عصرًا" });
  store.createRequest({ phone: "966503333333", name: "سعد", regionKey: "CENTER", district: null, autoDetected: false, preferredDateTime: "غدًا صباحًا" });
  data = buildDeliveryDailyReport();
  check("2: الإجمالي 3 (واحد لكل منطقة)", data.total === 3 && data.byRegion.NORTH.length === 1 && data.byRegion.SOUTH.length === 1 && data.byRegion.CENTER.length === 1);
  const text = formatDeliveryDailyReport(data);
  check("2ب: النص فيه الثلاثة أسماء وأرقامهم كروابط wa.me", text.includes("أحمد") && text.includes("خالد") && text.includes("سعد") && text.includes("https://wa.me/966501111111") && text.includes("https://wa.me/966502222222") && text.includes("https://wa.me/966503333333"));
  check("2ج: النص فيه أسماء المناطق الثلاثة والإجمالي الصحيح", text.includes("الشمال") && text.includes("الجنوب") && text.includes("الوسط") && text.includes("إجمالي الطلبات المفتوحة: 3"));

  console.log("\n=== 3) طلب اتسلّم -> يختفي من التقرير ===");
  const toDeliver = store.listOpenRequests().find((r) => r.regionKey === "NORTH");
  store.markDelivered(toDeliver.id);
  data = buildDeliveryDailyReport();
  check("3: الإجمالي بقى 2 بعد تسليم طلب الشمال", data.total === 2 && data.byRegion.NORTH.length === 0);

  console.log("\n=== 4) إدارة أرقام استقبال التقرير (addReportRecipient/removeReportRecipient/getReportRecipients) ===");
  check("4: مفيش أرقام مسجّلة في الأول", store.getReportRecipients().length === 0);
  check("4ب: addReportRecipient بيضيف فعليًا", store.addReportRecipient("966509999999") === true);
  check("4ج: نفس الرقم تاني -> false (مضاف بالفعل)", store.addReportRecipient("966509999999") === false);
  check("4د: الرقم ظاهر في القائمة", store.getReportRecipients().includes("966509999999"));
  check("4هـ: removeReportRecipient بيشيل فعليًا", store.removeReportRecipient("966509999999") === true);
  check("4و: رقم مش موجود -> false", store.removeReportRecipient("966509999999") === false);

  console.log("\n=== 5) صفر واتساب حقيقي ===");
  const reportSrc = fs.readFileSync(path.join(ROOT, "lib", "deliveryReport.js"), "utf8");
  check("5: lib/deliveryReport.js مفيهوش أي استدعاء sendMessage - بناء وتنسيق نص بس", !/sendMessage/.test(reportSrc));

  console.log(`\n🎉 كل اختبارات تقرير التوصيل اليومي نجحت (${passed} اختبار). صفر رسائل واتساب حقيقية.`);
}

try {
  run();
  wipe();
  restore(snap);
  console.log("♻️ تم استرجاع كل ملفات البيانات الحقيقية زي ما كانت قبل الاختبار.");
} catch (err) {
  console.error("💥 فشل الاختبار:", err.message);
  wipe();
  restore(snap);
  console.log("♻️ تم استرجاع ملفات البيانات (بعد فشل).");
  process.exit(1);
}
