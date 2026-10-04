// اختبارات نتيجة التوصيل (تم / تعذّر + السبب) - أمر موظف التوصيل ورسالة المزارع. صفر واتساب حقيقي
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const FILES = ["delivery_state.json", "delivery_state.json.bak"];
const snap = Object.fromEntries(FILES.map((n) => [n, fs.existsSync(path.join(ROOT, n)) ? fs.readFileSync(path.join(ROOT, n)) : null]));
const wipe = () => FILES.forEach((n) => fs.existsSync(path.join(ROOT, n)) && fs.unlinkSync(path.join(ROOT, n)));
const restore = () => FILES.forEach((n) => {
  const p = path.join(ROOT, n);
  if (snap[n] === null) { if (fs.existsSync(p)) fs.unlinkSync(p); } else fs.writeFileSync(p, snap[n]);
});

let passed = 0;
const check = (label, cond) => { assert(cond, `❌ FAILED: ${label}`); console.log(`✅ ${label}`); passed++; };

wipe();
try {
  const { parseOutcomeCommand, buildFailedNotice } = require("../lib/deliveryOutcome");
  const store = require("../lib/deliveryStore");
  const cfg = require("../config");

  console.log("\n=== 1) فهم الأوامر ===");
  check("تم التوصيل D-5", JSON.stringify(parseOutcomeCommand("تم التوصيل D-5")) === JSON.stringify({ kind: "DELIVERED", id: "D-5", reason: "" }));
  const f = parseOutcomeCommand("تعذر التوصيل D-12 المزارع مش موجود في الموقع");
  check("تعذر التوصيل + سبب", f && f.kind === "FAILED" && f.id === "D-12" && f.reason === "المزارع مش موجود في الموقع");
  check("تعذّر التسليم (بتشكيل) + حروف صغيرة", parseOutcomeCommand("تعذّر التسليم d-3 الجوال مغلق").id === "D-3");
  check("تعذر الاستلام من غير سبب", parseOutcomeCommand("تعذر الاستلام D-7").reason === "");
  check("رقم عربي في المعرّف غير مدعوم لكن النص العادي مش أمر", parseOutcomeCommand("مرحبا") === null && parseOutcomeCommand("تعذر التوصيل") === null);

  console.log("\n=== 2) رسالة المزارع ===");
  const req = { id: "D-9", name: "خالد" };
  const msgWith = buildFailedNotice(cfg.DELIVERY_FAILED_NOTICE, req, "الجوال مغلق");
  check("فيها الاسم والطلب والسبب", msgWith.includes("خالد") && msgWith.includes("D-9") && msgWith.includes("الجوال مغلق") && !msgWith.includes("{"));
  check("من غير سبب -> سبب افتراضي", buildFailedNotice(cfg.DELIVERY_FAILED_NOTICE, req, "").includes("تعذّر الوصول إليكم"));

  console.log("\n=== 3) تسجيل التعذّر في الـstore ===");
  const r = store.createRequest({ phone: "966501111111", name: "خالد", regionKey: "NORTH", preferredDateTime: "الأحد 10 صباحًا" });
  check("الطلب مفتوح", store.listOpenRequests().some((x) => x.id === r.id));
  const failed = store.markFailed(r.id, "الجوال مغلق");
  check("markFailed بيسجّل الحالة والسبب", failed && failed.status === "FAILED_DELIVERY" && failed.failureReason === "الجوال مغلق");
  check("بيخرج من الطلبات المفتوحة", !store.listOpenRequests().some((x) => x.id === r.id));
  check("مرتين -> null (اتقفل)", store.markFailed(r.id, "x") === null);
  const redelivered = store.markDelivered(r.id);
  check("لو اتسلّمت بعد موعد جديد، markDelivered بتقفل الطلب المتعذّر كمسلَّم", redelivered && redelivered.status === "DELIVERED");
  check("findRequest بيلاقي الطلب بأي حالة", store.findRequest(r.id.toLowerCase()).id === r.id);

  console.log(`\n🎉 كل اختبارات نتيجة التوصيل نجحت (${passed} اختبار).`);
} catch (err) {
  console.error("💥 فشل:", err.message);
  wipe(); restore();
  process.exit(1);
}
wipe(); restore();
console.log("♻️ تم استرجاع ملفات البيانات الحقيقية.");
