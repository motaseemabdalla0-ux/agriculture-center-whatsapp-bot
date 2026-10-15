// اختبارات شريحة "بطاقة المزارع": حساب الأرقام (بدون المؤرشف والمرفوض) والأسبوع السابق والـHTML. من غير متصفح ولا منصة
const assert = require("assert");
const s = require("../lib/farmerCardSlide");

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

const stats = { pendingReview: 20, onHold: 6, approved: 4, rejected: 99, archived: 500, pendingPrinting: 78, delivered: 191, pendingDelivery: 286 };
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
check("2ب: من غير لقطات قديمة -> القيمة المرجعية (557)", s.pickPrevious([{ date: "2026-10-14", total: 1 }], "2026-10-15").total === 557);

const data = s.computeSlideData(stats, { dateStr: "2026-10-15", previous: snaps[1] });
check("3: فرق الإجمالي +28 والمطبوعة +23", data.delta.total === 28 && data.delta.printed === 23);
check("3ب: النسب 5.1 / 13.3 / 81.5", data.pct.review === 5.1 && data.pct.waitingPrint === 13.3 && data.pct.printed === 81.5);
const html = s.renderSlideHtml(data);
check("3ج: الـHTML فيه الأرقام بالعربي-الهندي (٥٨٥ و٤٧٧ و٣٠ و٧٨)", ["٥٨٥", "٤٧٧", "٣٠", "٧٨"].every((n) => html.includes(n)));
check("3د: الـHTML فيه عنوان الشريحة وأقسامها", html.includes("بطاقة المزارع") && html.includes("تفصيل البطاقات المطبوعة") && html.includes("التحديث الأسبوعي"));

console.log(`\n🎉 كل اختبارات شريحة بطاقة المزارع نجحت (${passed} اختبار). صفر متصفح وصفر منصة.`);
