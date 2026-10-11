// اختبارات مطابقة طلبات التوصيل مع تاب "Delivered" في المنصة. صفر متصفح وصفر واتساب حقيقي، وبيرجّع
// ملف بيانات التوصيل الحقيقي زي ما كان بعد الاختبار
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

try {
  const store = require("../lib/deliveryStore");
  const { matchDelivered, applyDeliveredFromPortal, normPhone } = require("../lib/portalDeliveryCheck");

  const mk = (name, phone, regionKey, extra = {}) => store.createRequest({ phone, name, regionKey, preferredDateTime: "الأحد 10 ص", ...extra });
  const a = mk("أحمد", "966501111111", "NORTH"); // يطابق بالجوال
  const b = mk("خالد", "966502222222", "SOUTH", { platformRequestNumber: "30412" }); // يطابق برقم النموذج بس
  const c = mk("سعد", "966503333333", "CENTER"); // مش ظاهر في Delivered
  const d = mk("منى", "966504444444", "SOUTH"); // متعذّر ثم ظاهر في Delivered
  const e = mk("ليلى", "966505555555", "NORTH"); // اتسلّم أصلًا بالموظف
  store.markFailed(d.id, "لا يرد");
  store.markDelivered(e.id);

  console.log("\n=== 1) المطابقة ===");
  check("1: normPhone بيوحّد 05... و9665... و+966", normPhone("0501111111") === "966501111111" && normPhone("+966501111111") === "966501111111");
  const rows = [
    { phone: "966501111111", formNumber: "30001" }, // أحمد بالجوال
    { phone: "966599999999", formNumber: "30412" }, // خالد برقم النموذج (جوال مختلف)
    { phone: "966504444444", formNumber: "30500" }, // منى (متعذّر قبل كده)
    { phone: "966505555555", formNumber: "30600" }, // ليلى (مسلَّم أصلًا)
  ];
  const matches = matchDelivered(store.getAllRequests(), rows);
  const ids = matches.map((m) => m.request.id).sort();
  check("1ب: بيطابق أحمد وخالد ومنى بس (مش سعد ولا ليلى المسلَّمة)", ids.join() === [a.id, b.id, d.id].sort().join());
  check("1ج: خالد اتطابق برقم النموذج وأحمد بالجوال", matches.find((m) => m.request.id === b.id).by === "form" && matches.find((m) => m.request.id === a.id).by === "phone");

  console.log("\n=== 2) التطبيق على الـstore ===");
  const updated = applyDeliveredFromPortal(rows);
  check("2: 3 طلبات اتحدّثت", updated.length === 3);
  check("2ب: الحالة DELIVERED ومصدرها portal", ["a", "b", "d"].every((k) => { const r = store.findRequest({ a, b, d }[k].id); return r.status === "DELIVERED" && r.deliveredSource === "portal"; }));
  check("2ج: سبب التعذّر السابق لمنى محفوظ", store.findRequest(d.id).failureReason === "لا يرد");
  check("2د: سعد لسه مفتوح", store.findRequest(c.id).status === "NEW");
  check("2هـ: مصدر ليلى بقى staff (ما اتغيّرش)", store.findRequest(e.id).deliveredSource === "staff");
  check("2و: تشغيل تاني مفيش تحديثات جديدة", applyDeliveredFromPortal(rows).length === 0);
  check("2ز: صفوف فاضية -> مفيش تحديث", applyDeliveredFromPortal([]).length === 0);

  console.log(`\n🎉 كل اختبارات فحص تسليم المنصة نجحت (${passed} اختبار). صفر متصفح وصفر واتساب حقيقي.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  restore(snap);
  console.log("♻️ تم استرجاع ملفات البيانات الحقيقية.");
}
