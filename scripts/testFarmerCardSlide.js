// اختبارات شريحة "بطاقة المزارع": حساب الأرقام (بدون المؤرشف والمرفوض) والأسبوع السابق والـHTML. من غير متصفح ولا منصة
const assert = require("assert");
const s = require("../lib/farmerCardSlide");

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

const stats = { pendingReview: 20, transferredToLts: 0, onHold: 6, approved: 4, rejected: 99, archived: 500, pendingPrinting: 78, delivered: 191, pendingDelivery: 286 };
const c = s.computeCounts(stats);
check("1: قيد المراجعة = مراجعة+معلّق+مقبول (30) بدون المرفوض والمؤرشف", c.review === 30);
check("1ب: المطبوعة = تم تسليمها + بانتظار التسليم (477)", c.printed === 477 && c.delivered === 191 && c.pendingDelivery === 286);
check("1ج: الإجمالي 585 ولا يشمل المرفوض/المؤرشف", c.total === 585);
check("1د: لو pendingPrinting مش متاح بيرجع لـissuingPending", s.computeCounts({ ...stats, pendingPrinting: null, issuingPending: 70 }).waitingPrint === 70);

const snaps = [
  { date: "2026-09-30", total: 500, review: 20, waitingPrint: 60, printed: 420 },
  { date: "2026-10-08", total: 557, review: 29, waitingPrint: 74, printed: 454 },
  { date: "2026-10-14", total: 580, review: 29, waitingPrint: 75, printed: 476 },
];
check("2: الأسبوع السابق = آخر لقطة عمرها 6 أيام أو أكتر (10-08)", s.pickPrevious(snaps, "2026-10-15").date === "2026-10-08");
check("2ب: من غير لقطات قديمة -> القيمة المرجعية (انتظار الطباعة 54، مطبوعة 503)", (() => { const p = s.pickPrevious([{ date: "2026-10-14", total: 1 }], "2026-10-15"); return p.waitingPrint === 54 && p.printed === 503; })());

const data = s.computeSlideData(stats, { dateStr: "2026-10-15", previous: snaps[1] });
check("3: فرق الإجمالي +28 والمطبوعة +23", data.delta.total === 28 && data.delta.printed === 23);
check("3ب: النسب 5.1 / 13.3 / 81.5", data.pct.review === 5.1 && data.pct.waitingPrint === 13.3 && data.pct.printed === 81.5);
const html = s.renderSlideHtml(data);
check("3ج: الـHTML فيه الأرقام بالعربي-الهندي (٥٨٥ و٤٧٧ و٣٠ و٧٨)", ["٥٨٥", "٤٧٧", "٣٠", "٧٨"].every((n) => html.includes(n)));
check("3د: الـHTML فيه عنوان الشريحة وأقسامها", html.includes("بطاقة المزارع") && html.includes("تفصيل البطاقات المطبوعة") && html.includes("التحديث الأسبوعي"));

console.log(`\n🎉 كل اختبارات شريحة بطاقة المزارع نجحت (${passed} اختبار). صفر متصفح وصفر منصة.`);

// إضافات الكشف (farmer card مع الكشف)
{
  const adj = require("../lib/farmerCardAdjust");
  const assertL = require("assert");
  const p1 = adj.parseAdjustmentText("قيد المراجعة 136 انتظار الطباعة 13");
  assertL(p1 && p1.review === 136 && p1.waitingPrint === 13, "parse both");
  const p2 = adj.parseAdjustmentText("تحت الطباعة 13 و قيد المراجعة ١٣٦");
  assertL(p2 && p2.review === 136 && p2.waitingPrint === 13, "parse arabic digits and alt wording");
  assertL(adj.parseAdjustmentText("كلام عادي") === null, "no numbers -> null");
  const base = { pendingReview: 57, transferredToLts: 41, onHold: 52, approved: 2, pendingPrinting: 54, pendingDelivery: 299, delivered: 204 };
  const merged = adj.applyAdjustments(base, { review: 136, waitingPrint: 13 });
  const c = s.computeCounts(merged);
  assertL(c.review === 288 && c.waitingPrint === 67 && c.total === 858, "applied totals 288/67/858");
  assertL(base.pendingReview === 57, "original stats untouched");
  console.log("✅ 4: إضافات الكشف: تحليل النص (حتى بالأرقام العربية) + جمعها على المنصة = 288 / 67 / إجمالي 858");
}
