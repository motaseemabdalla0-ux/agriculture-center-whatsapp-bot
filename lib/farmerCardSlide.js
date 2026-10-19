const fs = require("fs");
const path = require("path");

// شريحة "بطاقة المزارع" (لوحة حالة البطاقات الأسبوعية): بتحسب الأرقام من إحصائيات المنصة وبترسم
// الشريحة (HTML -> PNG + PDF بمتصفح puppeteer الموجود أصلًا مع البوت). فصل الحساب (computeSlideData)
// والـHTML (renderSlideHtml) عن الرسم الفعلي عشان يتختبروا من غير متصفح ولا منصة.
//
// تعريف الأرقام (بطلب الإدارة):
//   قيد المراجعة     = كل حالات صفحة المراجعة (قيد المراجعة + محوّل إلى LTS + معلّق + مقبول) ما عدا المؤرشف
//                      والمرفوض و"قيد الطباعة" (اللي ليها كارت لوحدها)
//   في انتظار الطباعة = كارت "قيد الطباعة" (Pending Printing)
//   تمت طباعتها       = بانتظار التسليم + تم التسليم (من صفحة الإصدار)
const SNAPSHOT_FILE = path.join(__dirname, "..", "farmer_card_snapshots.json");

// أرقام الأسبوع السابق في الشريحة الأصلية (15 أكتوبر 2026) - مرجع أول مرة لحد ما يتراكم تاريخ حقيقي
// (قيد المراجعة والإجمالي في الشريحة الأصلية كانا بتعريف مختلف - "قيد المراجعة" بس - فمش قابلين للمقارنة)
const SEED_BASELINE = { date: "2026-10-19", review: 152, waitingPrint: 54, printed: 503, total: 709, delivered: 204, pendingDelivery: 299 };

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function computeCounts(stats) {
  const review = num(stats.pendingReview) + num(stats.transferredToLts) + num(stats.onHold) + num(stats.approved);
  const waitingPrint = stats.pendingPrinting !== null && stats.pendingPrinting !== undefined ? num(stats.pendingPrinting) : num(stats.issuingPending);
  const delivered = num(stats.delivered);
  const pendingDelivery = num(stats.pendingDelivery);
  const printed = delivered + pendingDelivery;
  return { review, waitingPrint, printed, delivered, pendingDelivery, total: review + waitingPrint + printed };
}

function loadSnapshots() {
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSnapshot(counts, dateStr) {
  const all = loadSnapshots().filter((s) => s.date !== dateStr);
  all.push({ date: dateStr, ...counts });
  all.sort((a, b) => a.date.localeCompare(b.date));
  try {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(all.slice(-60)), "utf8");
  } catch (err) {
    console.log(`⚠️ تعذّر حفظ لقطة بطاقة المزارع: ${err.message}`);
  }
}

// أقرب لقطة عمرها 6 أيام أو أكتر (الأسبوع السابق) - وإلا الأقدم المتاحة - وإلا القيمة المرجعية
function pickPrevious(snapshots, dateStr) {
  const cutoff = new Date(`${dateStr}T00:00:00Z`).getTime() - 6 * 86400000;
  const older = snapshots.filter((s) => new Date(`${s.date}T00:00:00Z`).getTime() <= cutoff);
  if (older.length) return older[older.length - 1];
  return SEED_BASELINE;
}

const pct = (part, total) => (total ? Math.round((part * 1000) / total) / 10 : 0);

function computeSlideData(stats, { dateStr, previous } = {}) {
  const c = computeCounts(stats);
  const prev = previous || SEED_BASELINE;
  const delta = (cur, old) => (old === null || old === undefined ? null : cur - old);
  return {
    dateStr,
    ...c,
    prev,
    pct: { review: pct(c.review, c.total), waitingPrint: pct(c.waitingPrint, c.total), printed: pct(c.printed, c.total), delivered: pct(c.delivered, c.printed), pendingDelivery: pct(c.pendingDelivery, c.printed) },
    delta: {
      total: delta(c.total, prev.total),
      review: delta(c.review, prev.review),
      waitingPrint: delta(c.waitingPrint, prev.waitingPrint),
      printed: delta(c.printed, prev.printed),
      delivered: delta(c.delivered, prev.delivered),
    },
  };
}

// فحص صحة الأرقام المقروءة من المنصة قبل رسم أي شريحة: أي رقم ناقص = خطأ (ما نرسمش شريحة بأصفار غلط)،
// وتعارض بين صفحتين لنفس الرقم أو في مجموع الطابور = تحذير بيظهر في ملخص التقرير
const REQUIRED_STATS = ["pendingReview", "transferredToLts", "onHold", "approved", "pendingPrinting", "pendingDelivery", "delivered"];
const STAT_LABEL = {
  pendingReview: "قيد المراجعة",
  transferredToLts: "محوّل إلى LTS",
  onHold: "معلّق",
  approved: "مقبول",
  pendingPrinting: "قيد الطباعة",
  pendingDelivery: "بانتظار التسليم",
  delivered: "تم التسليم",
};
function validateStats(stats) {
  const errors = [];
  const warnings = [];
  const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const missing = REQUIRED_STATS.filter((k) => !isNum(stats[k]));
  if (missing.length) errors.push(`تعذّر قراءة: ${missing.map((k) => STAT_LABEL[k]).join("، ")}`);
  if (isNum(stats.issuingPending) && isNum(stats.pendingPrinting) && stats.issuingPending !== stats.pendingPrinting) {
    warnings.push(`قيد الطباعة في صفحة المراجعة (${stats.pendingPrinting}) لا يطابق صفحة الإصدار (${stats.issuingPending})`);
  }
  if (isNum(stats.totalInQueue) && isNum(stats.pendingPrinting) && isNum(stats.pendingDelivery) && isNum(stats.delivered)) {
    const sum = (isNum(stats.issuingPending) ? stats.issuingPending : stats.pendingPrinting) + stats.pendingDelivery + stats.delivered;
    if (sum !== stats.totalInQueue) warnings.push(`مجموع الطابور (${sum}) لا يطابق "Total in Queue" (${stats.totalInQueue})`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

const { renderSlideHtml, renderSlideFiles } = require("./farmerCardSlideRender");

module.exports = { validateStats, computeCounts, computeSlideData, renderSlideHtml, renderSlideFiles, loadSnapshots, saveSnapshot, pickPrevious, SEED_BASELINE, SNAPSHOT_FILE };
