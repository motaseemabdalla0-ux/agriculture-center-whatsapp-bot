// فحص تقرير إشعارات إصدار البطاقات: تصنيف كل بطاقة (وصلها الإشعار / لم يصلها + السبب)، الملخص، ملف Excel. من غير واتساب.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const r = require("../lib/cardNoticeReport");

const rows = [
  { name: "أحمد", phone: "966500000001", nationalId: "1000000001", formNumber: "101" }, // أُرسل
  { name: "Mohammed", phone: "966500000002", nationalId: "1000000002", formNumber: "102" }, // اسم غير عربي
  { name: "سالم", phone: "966500000003", nationalId: "1000000003", formNumber: "103" }, // مش على واتساب
  { name: "خالد", phone: "", nationalId: "1000000004", formNumber: "104" }, // بدون جوال
  { name: "فهد", phone: "96650000", nationalId: "1000000005", formNumber: "105" }, // جوال غلط
  { name: "ناصر", phone: "966500000006", nationalId: "1000000006", formNumber: "106" }, // لسه ما جاش دوره
  { name: "عمر", phone: "966500000007", nationalId: "1000000007", formNumber: "107" }, // حد الإرسال
  { name: "ابن أحمد", phone: "966500000001", nationalId: "1000000008", formNumber: "108" }, // نفس جوال أحمد
  { name: "أحمد", phone: "966500000001", nationalId: "1000000001", formNumber: "101" }, // تكرار لنفس الطلب
];
const sent = new Set(["966500000001"]);
const decisions = {
  966500000002: { decision: "BLOCKED_NON_ARABIC_NAME", reason: "x" },
  966500000003: { decision: "FAILED", reason: "not_on_whatsapp" },
  966500000007: { decision: "RATE_LIMITED", reason: "hourly" },
};
const ctx = { hasBeenSent: (p) => sent.has(p), lastDecision: (p) => decisions[p] || null, sentDate: (p) => (p === "966500000001" ? "2026-10-20" : "") };
const rep = r.buildCardNoticeReport(rows, ctx, new Date("2026-10-27T08:00:00Z"));
assert.strictEqual(rep.total, 8, "التكرار اتشال");
assert.strictEqual(rep.sent, 2, "أحمد + ابنه (نفس الجوال)");
assert.strictEqual(rep.notSent, 6);
const by = (n) => rep.items.find((i) => i.name === n);
assert.strictEqual(by("أحمد").sentAt, "2026-10-20");
assert.ok(/مرة واحدة لكل رقم/.test(by("أحمد").note) && /3 بطاقات/.test(by("أحمد").note), "ملاحظة الرقم المشترك");
assert.ok(/غير عربي/.test(by("Mohammed").reason));
assert.ok(/غير مسجّل على واتساب/.test(by("سالم").reason));
assert.ok(/مفيش رقم جوال/.test(by("خالد").reason));
assert.ok(/غير صحيح/.test(by("فهد").reason));
assert.ok(/لم تتم محاولة الإرسال/.test(by("ناصر").reason));
assert.ok(/طابور الإرسال/.test(by("عمر").reason));
const msg = r.formatCardNoticeMessage(rep);
assert.ok(/وصلهم إشعار الإصدار: 2/.test(msg) && /لم يصلهم: 6/.test(msg) && /أسباب عدم الإرسال/.test(msg) && /Mohammed/.test(msg));
(async () => {
  const buf = await r.buildCardNoticeBuffer(rep);
  const tmp = path.join(os.tmpdir(), "cnr-test.xlsx");
  fs.writeFileSync(tmp, buf);
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(tmp);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ["الملخص", "لم يُرسل (مع السبب)", "تم الإرسال", "كل البطاقات"]);
  assert.strictEqual(wb.getWorksheet("لم يُرسل (مع السبب)").rowCount, 7);
  assert.strictEqual(wb.getWorksheet("كل البطاقات").rowCount, 9);
  fs.unlinkSync(tmp);
  assert.ok(/تقرير إشعارات إصدار البطاقات - 2026-10-27/.test(r.cardNoticeFileName(new Date("2026-10-27T08:00:00Z"))));
  // قائمة كاملة فاضية = رسالة نجاح
  const empty = r.buildCardNoticeReport([{ name: "أحمد", phone: "966500000001", formNumber: "1" }], ctx);
  assert.ok(/كل البطاقات الجاهزة وصلها/.test(r.formatCardNoticeMessage(empty)));
  console.log("✅ كل الفحوصات نجحت");
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
