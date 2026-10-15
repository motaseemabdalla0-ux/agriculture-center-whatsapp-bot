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
const SEED_BASELINE = { date: "2026-10-08", review: null, waitingPrint: 74, printed: 454, total: null, delivered: null, pendingDelivery: null };

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

// أرقام عربية-هندية زي الشريحة الأصلية
const AR = (v) => String(v).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]).replace(".", "٫");
const signed = (n) => (n > 0 ? `+${n}` : String(n));

function deltaPill(cur, old, prevTotalForPct) {
  if (old === null || old === undefined) return "";
  const d = cur - old;
  const p = old ? Math.round((d * 1000) / old) / 10 : 0;
  const arrow = d > 0 ? "↗" : d < 0 ? "↘" : "→";
  return `<span class="pill ${d < 0 ? "down" : ""}">${arrow} ${AR(signed(d))} · ${AR(signed(p))}٪</span>`;
}

function dateLabel(dateStr) {
  const months = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${AR(d)} ${months[m - 1]} ${AR(y)}`;
}

function renderSlideHtml(data) {
  const { prev } = data;
  const totalDelta = data.delta.total;
  const totalPct = prev.total ? Math.round(((data.total - prev.total) * 1000) / prev.total) / 10 : 0;
  const prevOrDash = (v) => (v === null || v === undefined ? "—" : AR(v));
  const printedAdded = data.delta.printed;
  const deliveredAdded = data.delta.delivered;
  const achievements = [];
  if (printedAdded !== null && printedAdded > 0) achievements.push(`طباعة ${AR(printedAdded)} بطاقة إضافية خلال الأسبوع`);
  if (deliveredAdded !== null && deliveredAdded > 0) achievements.push(`تسليم ${AR(deliveredAdded)} بطاقة إضافية خلال الأسبوع`);
  if (!achievements.length) achievements.push("لا توجد إضافات مسجّلة خلال الأسبوع");
  const follow = [];
  if (data.pendingDelivery > 0) follow.push(`تسليم ${AR(data.pendingDelivery)} بطاقة مطبوعة بانتظار التسليم`);
  if (data.waitingPrint > 0) follow.push(`طباعة ${AR(data.waitingPrint)} بطاقة في انتظار الطباعة`);
  if (data.review > 0) follow.push(`مراجعة ${AR(data.review)} طلب قيد المراجعة`);

  const card = (cls, icon, title, value, percent, prevValue, curValue) => `
    <div class="card ${cls}">
      <div class="card-head"><span class="icon">${icon}</span><span>${title}</span></div>
      <div class="big">${AR(value)}</div>
      <div class="bar"><i style="width:${Math.min(100, percent)}%"></i></div>
      <div class="muted">${AR(percent)}٪ من الإجمالي</div>
      <div class="muted prevrow"><span>الأسبوع السابق: ${prevValue === null || prevValue === undefined ? "—" : AR(prevValue)}</span></div>
      ${deltaPill(curValue, prevValue)}
    </div>`;

  const donutPct = data.printed ? (data.delivered / data.printed) * 100 : 0;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1280px;height:720px;background:#171611;font-family:'Cairo','Segoe UI',Tahoma,Arial,sans-serif;color:#f3ead6}
.slide{width:1280px;height:720px;padding:30px 44px;overflow:hidden;display:flex;flex-direction:row;gap:30px;direction:ltr;
 background:radial-gradient(1200px 700px at 70% 20%,#2a271e 0%,#171611 70%)}
.main{flex:1;direction:rtl;display:flex;flex-direction:column;gap:14px;min-height:0}
.side{width:385px;direction:rtl;border:1px solid #6b5a33;border-radius:26px;padding:26px 24px;background:rgba(24,22,16,.78)}
.top{display:flex;align-items:flex-start;justify-content:space-between}
.title{font-size:40px;font-weight:800;color:#fff;line-height:1.1}
.org{font-size:15px;color:#d8b86a;font-weight:600;margin-bottom:6px}
.pills{display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.pill-total{background:#c9a45c;color:#2a2210;font-weight:800;font-size:18px;padding:8px 22px;border-radius:30px}
.pill-delta{background:#12372f;border:1px solid #1d5a4d;color:#9be0c4;font-weight:700;font-size:14px;padding:6px 16px;border-radius:30px}
.cards{display:flex;gap:16px;direction:rtl}
.card{flex:1;background:#24221b;border-radius:22px;padding:14px 18px;border-top:5px solid var(--c);box-shadow:0 8px 24px rgba(0,0,0,.35)}
.card.printed{--c:#c9a45c}.card.wait{--c:#d9895f}.card.review{--c:#e5cba6}
.card-head{display:flex;justify-content:space-between;align-items:center;font-size:19px;font-weight:700;color:#fff}
.icon{width:36px;height:36px;border-radius:50%;background:var(--c);color:#241d10;display:grid;place-items:center;font-size:17px}
.big{font-size:50px;font-weight:800;color:var(--c);margin:2px 0 2px;line-height:1.25}
.bar{height:7px;border-radius:5px;background:#3a362b;overflow:hidden;margin-bottom:10px}
.bar i{display:block;height:100%;background:var(--c);float:right}
.muted{font-size:13px;color:#b9ad92;margin-top:4px}
.pill{display:inline-block;margin-top:8px;background:#12372f;color:#9be0c4;border-radius:20px;padding:4px 14px;font-size:13px;font-weight:700}
.pill.down{background:#3a1f1c;color:#f0a49a}
.break{background:#24221b;border-radius:22px;padding:14px 24px;flex:1;min-height:0;display:flex;align-items:center;justify-content:space-between;gap:24px}
.break h3{font-size:18px;color:#fff;margin-bottom:8px}
.rows{flex:1}
.row{display:flex;justify-content:space-between;align-items:center;background:#2d2a21;border-right:5px solid #c9a45c;border-radius:10px;padding:7px 16px;margin-bottom:8px;font-size:14px;color:#cdbf9f}
.row b{font-size:22px;color:#e0b86a}
.row.b2{border-right-color:#d9895f}
.donut{width:132px;height:132px;border-radius:50%;background:conic-gradient(#c9a45c 0 ${donutPct}%,#d9895f ${donutPct}% 100%);display:grid;place-items:center}
.donut div{width:92px;height:92px;border-radius:50%;background:#24221b;display:grid;place-items:center;text-align:center;font-size:13px;color:#cdbf9f}
.donut b{display:block;font-size:26px;color:#fff;line-height:1}
.side h2{font-size:27px;color:#fff;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #6b5a33}
.sum{background:#12372f;border-radius:16px;padding:14px 18px;margin-bottom:18px;text-align:center}
.sum small{display:block;font-size:14px;color:#cfe8dd}
.sum b{font-size:34px;color:#fff}
.sum em{display:block;font-style:normal;color:#d8b86a;font-weight:700;font-size:14px;margin-top:4px}
.side h4{font-size:19px;color:#d8b86a;margin:14px 0 8px}
.side li{list-style:none;font-size:14.5px;color:#d8ccb0;margin-bottom:9px;line-height:1.6}
.side li:before{content:"• ";color:#d8b86a}
.foot{margin-top:auto;font-size:11px;color:#8d826a}
</style></head><body><div class="slide">
 <div class="side">
  <h2>التحديث الأسبوعي</h2>
  <div class="sum"><small>إجمالي البطاقات</small><b>${prev.total === null || prev.total === undefined ? AR(data.total) : `${AR(prev.total)} ← ${AR(data.total)}`}</b>
   <em>${totalDelta === null ? "" : `${totalDelta >= 0 ? "ارتفاع" : "انخفاض"} ${AR(Math.abs(totalPct))}٪ عن الأسبوع السابق`}</em></div>
  <h4>الإنجازات</h4><ul>${achievements.map((a) => `<li>${a}</li>`).join("")}</ul>
  <h4>المتابعة</h4><ul>${follow.map((a) => `<li>${a}</li>`).join("") || "<li>لا توجد نقاط متابعة</li>"}</ul>
 </div>
 <div class="main">
  <div class="top">
   <div><div class="org">مركز الزراعة · ${dateLabel(data.dateStr)}</div><div class="title">بطاقة المزارع</div></div>
   <div class="pills"><div class="pill-total">الإجمالي: ${AR(data.total)} بطاقة</div>
   ${totalDelta === null ? "" : `<div class="pill-delta">↗ ${AR(signed(totalDelta))} عن الأسبوع السابق (${AR(prev.total)})</div>`}</div>
  </div>
  <div class="cards">
   ${card("printed", "🪪", "تمت طباعتها", data.printed, data.pct.printed, prev.printed, data.printed)}
   ${card("wait", "🖨", "في انتظار الطباعة", data.waitingPrint, data.pct.waitingPrint, prev.waitingPrint, data.waitingPrint)}
   ${card("review", "🔍", "قيد المراجعة", data.review, data.pct.review, prev.review, data.review)}
  </div>
  <div class="break">
   <div class="rows"><h3>تفصيل البطاقات المطبوعة</h3>
    <div class="row"><span>${AR(data.pct.delivered)}٪ تم تسليمها</span><b>${AR(data.delivered)}</b></div>
    <div class="row b2"><span>${AR(data.pct.pendingDelivery)}٪ بانتظار التسليم</span><b>${AR(data.pendingDelivery)}</b></div>
   </div>
   <div class="donut"><div><span><b>${AR(data.printed)}</b>مطبوعة</span></div></div>
  </div>
 </div>
</div></body></html>`;
}

// بيرسم الشريحة PNG + PDF (1280x720) بمتصفح puppeteer
async function renderSlideFiles(data) {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: true });
  const hardStop = setTimeout(() => browser.close().catch(() => {}), 90 * 1000);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
    await page.setContent(renderSlideHtml(data), { waitUntil: "networkidle2", timeout: 30000 }).catch(async () => {
      await page.setContent(renderSlideHtml(data), { waitUntil: "load" });
    });
    const png = await page.screenshot({ type: "png" });
    const pdf = await page.pdf({ width: "1280px", height: "720px", printBackground: true, pageRanges: "1" });
    return { png: Buffer.from(png), pdf: Buffer.from(pdf) };
  } finally {
    clearTimeout(hardStop);
    await browser.close();
  }
}

module.exports = { computeCounts, computeSlideData, renderSlideHtml, renderSlideFiles, loadSnapshots, saveSnapshot, pickPrevious, SEED_BASELINE, SNAPSHOT_FILE };
