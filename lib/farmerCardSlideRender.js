const fs = require("fs");
const os = require("os");
const path = require("path");

// رسم شريحة "بطاقة المزارع" بتصميم الشريحة الأصلية (لوحة التحديث الأسبوعي + 3 كروت + تفصيل المطبوعة)
// على خلفية صورة (assets/farmer_card_bg.jpg) وشعار الهيئة (assets/rcu_logo.png). كل الأبعاد بوحدات
// 2000x1125 والتصدير بدقة 3840x2160. الحساب نفسه في farmerCardSlide.js (computeSlideData).
const ASSETS_DIR = path.join(__dirname, "..", "assets");

const AR = (v) => String(v).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]).replace(".", "٫");
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${AR(d)} ${MONTHS[m - 1]} ${AR(y)}`;
}

function dataUri(file, mime) {
  try {
    return `data:${mime};base64,${fs.readFileSync(path.join(ASSETS_DIR, file)).toString("base64")}`;
  } catch {
    return "";
  }
}

const svg = (inner, sw = 1.8) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON = {
  calendar: svg('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M12 14h2"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  idcard: svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M6.5 16c.6-1.5 4.4-1.5 5 0M14 10h4M14 13.5h4"/>'),
  printer: svg('<path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="7" y="14" width="10" height="6" rx="1"/>'),
  search: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><circle cx="11.5" cy="14" r="2.5"/><path d="M13.3 15.8l2 2"/>'),
  truck: svg('<path d="M2.5 6.5h11v10h-11zM13.5 10h4l3 3v3.5h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>'),
  trend: svg('<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>', 2.2),
};

// إنجازات بطاقة المزارع (بتظهر في اللوحة الجانبية) - بتتعدّل من هنا
const DELIVERY_PLAN_STEPS = [
  "تجهيز مركز مكالمات يخدم مركز الزراعة",
  "عمل رد آلي (Chat Bot) يرسل للمزارعين إشعارات بجميع مراحل البطاقة، من استلام البطاقة إلى جاهزيتها للاستلام",
  "عمل خدمة توصيل البطاقات للمزارعين في أماكنهم",
  "جعل الرد الآلي مسؤولًا عن تجهيز وإرسال تقارير دورية، وعند الحاجة، بجميع بيانات بطاقة المزارع",
  "عمل مستندات وخطط لجميع الوحدات العاملة في بطاقة المزارع: مركز المكالمات والاستقبال ووحدة مراجعة البيانات",
  "تجهيز رحلة البطاقة من تقديم المزارع للتسجيل في بطاقة المزارع إلى حصوله على جميع الخدمات",
];

function renderSlideHtml(data) {
  const prev = data.prev || {};
  const totalDelta = data.delta.total;
  const totalPct = prev.total ? Math.round(((data.total - prev.total) * 1000) / prev.total) / 10 : 0;
  const printedAdded = data.delta.printed;
  const deliveredAdded = data.delta.delivered;

  // الإنجازات = خطة وإجراءات التوصيل المحدّثة (بطلب الإدارة بدل النص الأسبوعي القديم)
  const achievements = DELIVERY_PLAN_STEPS;
  const follow = [];
  if (data.pendingDelivery > 0) follow.push(`تسليم ${AR(data.pendingDelivery)} بطاقة مطبوعة بانتظار التسليم`);
  if (data.waitingPrint > 0) follow.push(`طباعة ${AR(data.waitingPrint)} بطاقة في انتظار الطباعة`);
  if (data.review > 0) follow.push(`مراجعة ${AR(data.review)} طلب قيد المراجعة`);

  const pill = (cur, old) => {
    if (old === null || old === undefined) return "";
    const d = cur - old;
    const p = old ? Math.round((d * 1000) / old) / 10 : 0;
    return `<div class="dpill ${d < 0 ? "down" : ""}"><span>${AR(signed(d))} · ${AR(signed(p))}٪</span><i>${ICON.trend}</i></div>`;
  };
  const card = (cls, left, icon, title, value, percent, prevValue) => `
    <div class="card ${cls}" style="left:${left}px">
      <div class="chead"><b>${title}</b><i class="ico">${ICON[icon]}</i></div>
      <div class="big">${AR(value)}</div>
      <div class="bar"><u style="width:${Math.min(100, percent)}%"></u></div>
      <div class="pct">${AR(percent)}٪ من الإجمالي</div>
      <div class="prevw">الأسبوع السابق: ${prevValue === null || prevValue === undefined ? "—" : AR(prevValue)}</div>
      ${pill(value, prevValue)}
    </div>`;

  const donutPct = data.printed ? (data.delivered / data.printed) * 100 : 0;
  const bg = dataUri("farmer_card_bg.jpg", "image/jpeg");
  const logo = dataUri("rcu_logo.png", "image/png");
  const sumNums =
    prev.total === null || prev.total === undefined ? AR(data.total) : `${AR(data.total)}<s>→</s>${AR(prev.total)}`;

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:2000px;height:1125px;overflow:hidden;background:#14120e;font-family:'Cairo','Segoe UI',Tahoma,Arial,sans-serif;color:#f3ead6}
.stage{position:absolute;left:0;top:0;width:2000px;height:1125px;direction:ltr;
 background:linear-gradient(rgba(18,16,12,.58),rgba(18,16,12,.70)),url(${bg}) center/cover no-repeat}
.side{position:absolute;left:100px;top:67px;width:500px;height:991px;border:1.5px solid #8a7240;border-radius:30px;background:rgba(28,25,20,.74);direction:rtl}
.side h2{position:absolute;right:104px;top:34px;font-size:36px;font-weight:700;color:#fff;line-height:1.5}
.side .hico{position:absolute;right:34px;top:34px;width:58px;height:58px;border-radius:50%;background:#c9a45c;color:#2a2110;display:grid;place-items:center;padding:14px}
.side hr{position:absolute;left:30px;right:34px;top:118px;border:0;border-top:1.5px solid #8a7240}
.sumbox{position:absolute;left:35px;right:34px;top:141px;height:170px;border-radius:24px;background:#123a31;text-align:center}
.sumbox small{position:absolute;left:0;right:0;top:12px;font-size:22px;color:#d6e6dd}
.sumbox .nums{position:absolute;left:0;right:0;top:46px;font-size:48px;font-weight:800;color:#fff;direction:ltr}
.sumbox .nums s{text-decoration:none;color:#fff;font-weight:600;margin:0 16px}
.sumbox em{position:absolute;left:0;right:0;top:122px;font-style:normal;font-size:24px;font-weight:600;color:#d8b86a}
.side .flow{position:absolute;left:30px;right:34px;top:330px;bottom:26px;overflow:hidden}
.side h4{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:700;color:#d8b86a;margin:4px 0 8px}
.side h4.warm{color:#d9895f;margin-top:16px}
.side .sico{display:block;width:34px;height:34px;color:inherit}
.side ul{list-style:none;margin:0}
.side .plan-title{font-size:23px;font-weight:700;color:#fff;margin:0 0 8px;line-height:1.4}
.side li{font-size:20px;line-height:1.45;color:#e5dcc4;margin-bottom:7px}
.side li:before{content:"• ";color:#d8b86a}
.org{position:absolute;right:355px;top:62px;font-size:26px;font-weight:600;color:#d8b86a;white-space:nowrap}
.title{position:absolute;right:355px;top:100px;font-size:64px;font-weight:800;color:#fff;line-height:1.2;white-space:nowrap}
.divider{position:absolute;left:1678px;top:75px;height:115px;border-left:1.5px solid #6b5a33}
.logo{position:absolute;left:1695px;top:80px;width:215px;height:107px;background:url(${logo}) center/contain no-repeat}
.ptotal{position:absolute;left:633px;top:67px;width:345px;height:65px;border-radius:33px;background:#c9a45c;color:#2a2210;font-size:30px;font-weight:800;display:grid;place-items:center;direction:rtl}
.pdelta{position:absolute;left:612px;top:145px;width:428px;height:55px;border-radius:28px;background:#123a31;border:1.5px solid #2c6b58;color:#fff;font-size:25px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:14px;direction:rtl}
.pdelta i{width:30px;height:30px;color:#d8b86a;display:grid;place-items:center}
.pdelta svg,.dpill svg,.ico svg,.tico svg,.sico svg,.hico svg{width:100%;height:100%}
.card{position:absolute;top:228px;width:405px;height:420px;border-radius:30px;background:rgba(36,32,26,.84);border-top:9px solid var(--c);box-shadow:0 10px 30px rgba(0,0,0,.35);direction:rtl}
.card.rev{--c:#e5cba6}.card.wait{--c:#d9895f}.card.prt{--c:#c9a45c}
.chead{position:absolute;right:28px;left:28px;top:28px;display:flex;align-items:center;justify-content:space-between;font-size:30px;color:#fff;direction:ltr}
.chead b{font-weight:700;direction:rtl}
.ico{width:58px;height:58px;border-radius:50%;background:var(--c);color:#2a2110;display:grid;place-items:center;padding:13px}
.big{position:absolute;right:30px;top:98px;font-size:88px;font-weight:800;color:var(--c);line-height:1.1;direction:rtl}
.bar{position:absolute;left:28px;right:30px;top:216px;height:13px;border-radius:7px;background:#4a4337;overflow:hidden}
.bar u{display:block;height:100%;background:var(--c);float:right;border-radius:7px}
.pct{position:absolute;right:30px;top:248px;font-size:26px;font-weight:600;color:#cdbf9f}
.prevw{position:absolute;right:30px;top:304px;font-size:25px;color:#cdbf9f}
.dpill{position:absolute;right:30px;top:352px;height:50px;border-radius:25px;background:#123a31;padding:0 22px;display:flex;align-items:center;gap:12px;font-size:23px;font-weight:800;color:#fff;direction:rtl}
.dpill i{width:28px;height:28px;color:#d8b86a;display:grid;place-items:center}
.dpill.down{background:#3a1f1c}
.break{position:absolute;left:633px;top:678px;width:1267px;height:272px;border-radius:30px;background:rgba(36,32,26,.84);direction:rtl}
.break h3{position:absolute;right:360px;top:30px;font-size:32px;font-weight:700;color:#fff;line-height:1.5}
.break .tico{position:absolute;right:288px;top:30px;width:58px;height:58px;border-radius:50%;background:#4a4337;color:#d8b86a;display:grid;place-items:center;padding:14px}
.brow{position:absolute;left:38px;right:288px;height:70px;border-radius:12px;background:rgba(66,58,45,.92);border-right:6px solid #c9a45c;display:flex;align-items:center;justify-content:space-between;padding:0 28px;direction:rtl}
.brow.b2{border-right-color:#d9895f}
.brow span{font-size:26px;font-weight:600;color:#cdbf9f}
.brow b{font-size:40px;font-weight:800;color:#e0b86a}
.brow.b2 b{color:#e39a75}
.donut{position:absolute;right:28px;top:38px;width:198px;height:198px;border-radius:50%;background:conic-gradient(#c9a45c 0 ${donutPct}%,#d9895f ${donutPct}% 100%);display:grid;place-items:center}
.donut div{width:142px;height:142px;border-radius:50%;background:#24201a;display:grid;place-items:center;text-align:center;font-size:22px;color:#cdbf9f;line-height:1.1}
.donut b{display:block;font-size:46px;color:#fff;font-weight:800}
</style></head><body><div class="stage">
 <div class="side">
  <i class="hico">${ICON.calendar}</i><h2>التحديث الأسبوعي</h2><hr>
  <div class="sumbox"><small>إجمالي البطاقات</small><div class="nums">${sumNums}</div>
   <em>${totalDelta === null ? "" : `${totalDelta >= 0 ? "ارتفاع" : "انخفاض"} ${AR(Math.abs(totalPct))}٪ عن الأسبوع السابق`}</em></div>
  <div class="flow">
   <h4><i class="sico">${ICON.check}</i><span>الإنجازات</span></h4>
   <ul>${achievements.map((a) => `<li>${a}</li>`).join("")}</ul>
   <h4 class="warm"><i class="sico">${ICON.clock}</i><span>المتابعة</span></h4>
   <ul>${follow.map((a) => `<li>${a}</li>`).join("") || "<li>لا توجد نقاط متابعة</li>"}</ul>
  </div>
 </div>
 <div class="org">مركز الزراعة · ${dateLabel(data.dateStr)}</div>
 <div class="title">بطاقة المزارع</div>
 <div class="divider"></div><div class="logo"></div>
 <div class="ptotal">الإجمالي: ${AR(data.total)} بطاقة</div>
 ${totalDelta === null ? "" : `<div class="pdelta"><span>${AR(signed(totalPct))}٪ عن الأسبوع السابق (${AR(prev.total)})</span><i>${ICON.trend}</i></div>`}
 ${card("rev", 633, "search", "قيد المراجعة", data.review, data.pct.review, prev.review)}
 ${card("wait", 1065, "printer", "في انتظار الطباعة", data.waitingPrint, data.pct.waitingPrint, prev.waitingPrint)}
 ${card("prt", 1495, "idcard", "تمت طباعتها", data.printed, data.pct.printed, prev.printed)}
 <div class="break">
  <i class="tico">${ICON.truck}</i><h3>تفصيل البطاقات المطبوعة</h3>
  <div class="brow" style="top:95px"><span>${AR(data.pct.delivered)}٪ · تم تسليمها</span><b>${AR(data.delivered)}</b></div>
  <div class="brow b2" style="top:179px"><span>${AR(data.pct.pendingDelivery)}٪ · بانتظار التسليم</span><b>${AR(data.pendingDelivery)}</b></div>
  <div class="donut"><div><span><b>${AR(data.printed)}</b>مطبوعة</span></div></div>
 </div>
</div></body></html>`;
}

// بيرسم الشريحة PNG (3840x2160) + PDF (صفحة واحدة 16:9 فيها صورة الشريحة) بمتصفح puppeteer
async function renderSlideFiles(data) {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: true });
  const hardStop = setTimeout(() => browser.close().catch(() => {}), 120 * 1000);
  const tmpFiles = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 2000, height: 1125, deviceScaleFactor: 1.92 });
    const html = renderSlideHtml(data);
    await page.setContent(html, { waitUntil: "networkidle2", timeout: 40000 }).catch(async () => {
      await page.setContent(html, { waitUntil: "load" });
    });
    // الخط العربي بيتحمّل بالـunicode-range: لازم نطلب حروف عربية صراحةً قبل الرسم
    await page.evaluate(async () => {
      const sample = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي٠١٢٣٤٥٦٧٨٩٪+·";
      for (const w of [400, 600, 700, 800]) await document.fonts.load(`${w} 40px Cairo`, sample);
      await document.fonts.ready;
    });
    await new Promise((r) => setTimeout(r, 400));
    const png = Buffer.from(await page.screenshot({ type: "png" }));

    const stamp = `${process.pid}-${Date.now()}`;
    const pngPath = path.join(os.tmpdir(), `farmer-card-${stamp}.png`);
    const htmlPath = path.join(os.tmpdir(), `farmer-card-${stamp}.html`);
    tmpFiles.push(pngPath, htmlPath);
    fs.writeFileSync(pngPath, png);
    fs.writeFileSync(
      htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:1280px 720px;margin:0}html,body{margin:0;padding:0;width:1280px;height:720px;background:#000}img{display:block;width:1280px;height:720px}</style></head><body><img src="file:///${pngPath.replace(/\\/g, "/")}"></body></html>`,
      "utf8"
    );
    const pdfPage = await browser.newPage();
    await pdfPage.goto(`file:///${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "load" });
    const pdf = Buffer.from(
      await pdfPage.pdf({ width: "1280px", height: "720px", printBackground: true, pageRanges: "1", preferCSSPageSize: true })
    );
    return { png, pdf };
  } finally {
    clearTimeout(hardStop);
    tmpFiles.forEach((f) => {
      try {
        fs.unlinkSync(f);
      } catch {
        // ملف مؤقت - مش مهم
      }
    });
    await browser.close();
  }
}

module.exports = { renderSlideHtml, renderSlideFiles };
