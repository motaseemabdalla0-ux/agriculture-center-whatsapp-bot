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

// فحص صحة أرقام المنصة قبل رسم الشريحة
{
  const assertV = require("assert");
  const good = { pendingReview: 57, transferredToLts: 41, onHold: 52, approved: 2, pendingPrinting: 54, issuingPending: 54, pendingDelivery: 299, delivered: 204, totalInQueue: 557 };
  const v1 = s.validateStats(good);
  assertV(v1.ok && v1.warnings.length === 0, "good stats pass");
  const v2 = s.validateStats({ ...good, transferredToLts: null });
  assertV(!v2.ok && v2.errors[0].includes("محوّل إلى LTS"), "missing stat is an error");
  const v3 = s.validateStats({ ...good, issuingPending: 55 });
  assertV(v3.ok && v3.warnings.length >= 1, "mismatch between pages is a warning");
  const v4 = s.validateStats({ ...good, totalInQueue: 500 });
  assertV(v4.ok && v4.warnings.some((w) => w.includes("Total in Queue")), "queue total mismatch warns");
  console.log("✅ 5: فحص الأرقام: ناقص = خطأ (بيمنع الشريحة)، تعارض صفحتين/مجموع الطابور = تحذير");
}

// كرت مخفي في المنصة (عدده صفر) = 0 مع تنبيه، مش خطأ يمنع التقرير
{
  const assertZ = require("assert");
  const z = { pendingReview: 40, transferredToLts: 32, onHold: 53, approved: 0, pendingPrinting: 92, issuingPending: 92, pendingDelivery: 299, delivered: 204, totalInQueue: 595, assumedZero: ["approved"] };
  const vz = s.validateStats(z);
  assertZ(vz.ok && vz.warnings.some((w) => w.includes("مقبول")), "assumed-zero approved is a warning, not an error");
  console.log("✅ 6: كرت 'مقبول' غير الظاهر (صفر) بيعدّي بتنبيه ومش بيمنع التقرير");
}
