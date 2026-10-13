// اختبارات التحقق من إرسال إشعار استلام كل بطاقة جاهزة (cardNoticeVerify). منطق نقي - صفر واتساب وصفر ملفات
const assert = require("assert");
const v = require("../lib/cardNoticeVerify");

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

const rows = [
  { name: "أحمد", phone: "966501111111", formNumber: "30001" }, // اتبعتله
  { name: "خالد", phone: "966502222222", formNumber: "30002" }, // مش على واتساب
  { name: "SAEED", phone: "966503333333", formNumber: "30003" }, // اسم غير عربي
  { name: "منى", phone: "", nationalId: "1000000009", formNumber: "30004" }, // بدون جوال
  { name: "ليلى", phone: "96650123", formNumber: "30005" }, // جوال غلط
  { name: "سعد", phone: "966505555555", formNumber: "30006" }, // محاولة لسه ما حصلت
  { name: "نورة", phone: "966506666666", formNumber: "30007" }, // حد الإرسال (مؤقت)
  { name: "أحمد مكرر", phone: "966501111111", formNumber: "30001" }, // نفس الصف تاني
  { name: "فهد", phone: "966507777777", formNumber: "30008" }, // فشل عادي
];
const decisions = {
  "966502222222": { decision: "FAILED", reason: "not_on_whatsapp" },
  "966503333333": { decision: "BLOCKED_NON_ARABIC_NAME", reason: "BLOCKED_NON_ARABIC_NAME" },
  "966506666666": { decision: "RATE_LIMITED", reason: "daily" },
  "966507777777": { decision: "FAILED", reason: "timeout" },
};
const ctx = {
  hasBeenSent: (p) => p === "966501111111",
  lastDecision: (p) => decisions[p] || null,
};

const r = v.verify(rows, ctx);
const code = (phoneOrId) => (r.problems.find((p) => p.phone === phoneOrId || p.nationalId === phoneOrId) || {}).code;

check("1: الإجمالي 8 (المكرر اتحسب مرة)", r.total === 8);
check("1ب: اللي وصله الإشعار 1", r.sent === 1);
check("1ج: مش على واتساب", code("966502222222") === "NOT_ON_WHATSAPP");
check("1د: الاسم غير عربي", code("966503333333") === "BLOCKED_NON_ARABIC_NAME");
check("1هـ: بدون جوال", code("1000000009") === "NO_PHONE");
check("1و: جوال غلط", r.problems.some((p) => p.code === "INVALID_PHONE" && p.formNumber === "30005"));
check("1ز: ما حاولناش لسه", code("966505555555") === "NOT_ATTEMPTED");
check("1ح: حد الإرسال مؤقت", r.problems.find((p) => p.phone === "966506666666").temporary === true);
check("1ط: فشل عادي", code("966507777777") === "FAILED");

const state = {};
const first = v.selectToNotify(r.problems, state, 1000);
check("2: أول مرة بيتبلّغ بكل المشاكل الحقيقية (6) من غير المؤقتة", first.length === 6 && !first.some((p) => p.temporary));
v.markNotified(first, state, 1000);
check("2ب: نفس المشاكل تاني بعد ساعة -> مفيش تنبيه جديد", v.selectToNotify(r.problems, state, 1000 + 60 * 60 * 1000).length === 0);
check("2ج: بعد 25 ساعة -> تذكير بكل المشاكل", v.selectToNotify(r.problems, state, 1000 + 25 * 60 * 60 * 1000).length === 6);
decisions["966505555555"] = { decision: "FAILED", reason: "not_on_whatsapp" };
const r2 = v.verify(rows, ctx);
const again = v.selectToNotify(r2.problems, state, 2000);
check("2د: لو سبب نفس الرقم اتغيّر -> بيتبلّغ هو بس", again.length === 1 && again[0].phone === "966505555555" && again[0].code === "NOT_ON_WHATSAPP");
v.pruneResolved([r.problems[0]], state);
check("2هـ: المشاكل اللي اتحلّت بتتشال من الحالة", Object.keys(state).length === 1);

const text = v.formatAlert(r, first);
check("3: نص التنبيه فيه العدد والاسم والرقم والسبب", text.includes("لم يصل لـ 6") && text.includes("خالد") && text.includes("+966502222222") && text.includes("الرقم غير مسجّل على واتساب") && text.includes("طلب 30002"));
check("3ب: اللي بدون جوال بيتكتب 'بدون رقم'", text.includes("بدون رقم"));

console.log(`\n🎉 كل اختبارات التحقق من إشعارات البطاقات نجحت (${passed} اختبار). صفر واتساب حقيقي.`);
