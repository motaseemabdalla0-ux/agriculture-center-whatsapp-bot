const fs = require("fs");
const os = require("os");
const path = require("path");
const fr = require("./farmerRequests");

// رسم تقرير "حالة طلبات خدمات المزارعين" (صفحتين 2000x1125) بنفس تصميم التقرير الأصلي:
// خلفية النخيل + شعار الهيئة + ألواح داكنة. التصدير PNG لكل صفحة + PDF من صفحتين.
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function dataUri(file, mime) {
  try {
    return `data:${mime};base64,${fs.readFileSync(path.join(ASSETS_DIR, file)).toString("base64")}`;
  } catch {
    return "";
  }
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const pad = (n) => String(n).padStart(2, "0");

function dateParts(now) {
  const d = new Date(now);
  return { day: d.getDate(), month: MONTHS[d.getMonth()], year: d.getFullYear(), slash: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` };
}

const CSS = (bg, logo) => `
@import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:2000px;height:1125px;overflow:hidden;background:#14120e;font-family:'Cairo','Segoe UI',Tahoma,Arial,sans-serif;color:#f3ead6}
.stage{position:relative;width:2000px;height:1125px;direction:rtl;
 background:linear-gradient(rgba(18,16,12,.50),rgba(18,16,12,.62)),url(${bg}) center/cover no-repeat}
.logo{position:absolute;left:86px;top:30px;width:215px;height:107px;background:url(${logo}) center/contain no-repeat;filter:brightness(2.1) saturate(1.3)}
.org{position:absolute;right:113px;top:50px;font-size:22px;font-weight:600;color:#d8b86a}
.title{position:absolute;right:113px;top:100px;font-size:46px;font-weight:700;color:#fff;line-height:1.3}
.foot{position:absolute;right:113px;left:113px;bottom:28px;display:flex;justify-content:space-between;font-size:16px;color:#d9cfb6}
.panel{position:absolute;border-radius:28px;background:rgba(30,26,20,.80)}
.side{left:83px;top:155px;width:467px;height:880px;border:1.5px solid #8a7240;background:rgba(28,25,20,.78)}
.side h2{position:absolute;right:34px;top:30px;font-size:30px;font-weight:700;color:#fff}
.side hr{position:absolute;left:30px;right:30px;top:92px;border:0;border-top:1px solid #6e5c36}
.sumbox{position:absolute;left:30px;right:30px;top:118px;height:146px;border-radius:14px;background:#12403a;text-align:right;padding:6px 38px}
.sumbox b{display:block;font-size:48px;font-weight:800;color:#fff;line-height:1.35}
.sumbox span{display:block;font-size:22px;font-weight:600;color:#f1e7cf}
.side h3{position:absolute;right:42px;font-size:26px;font-weight:700}
.ind{position:absolute;left:34px;right:34px;height:88px;border-bottom:1px solid #4a4030;display:flex;align-items:center;justify-content:space-between}
.ind b{font-size:34px;font-weight:800;color:#d8b86a;width:110px;text-align:left;direction:ltr}
.ind span{font-size:20px;color:#e5dcc4;flex:1;text-align:left;direction:rtl}
.ind{flex-direction:row-reverse}
.prio{position:absolute;right:46px;left:40px;top:820px;list-style:none}
.prio li{font-size:18px;line-height:1.5;color:#ece3cb;margin-bottom:12px}
.kpi{position:absolute;top:228px;width:372px;height:247px;border-radius:20px;background:rgba(30,26,20,.82);border-top:7px solid var(--c)}
.kpi h4{position:absolute;right:26px;top:26px;font-size:26px;font-weight:700;color:#fff}
.kpi .n{position:absolute;right:26px;top:70px;font-size:66px;font-weight:800;color:var(--c);line-height:1.2}
.kpi .bar{position:absolute;left:26px;right:26px;top:176px;height:6px;border-radius:3px;background:#5a5143;overflow:hidden}
.kpi .bar u{display:block;height:100%;background:var(--c);float:right}
.kpi small{position:absolute;right:26px;top:204px;font-size:17px;color:#d9cfb6}
.unit{position:absolute;width:635px;height:250px;border-radius:20px;background:rgba(30,26,20,.82)}
.unit h4{position:absolute;right:26px;top:18px;font-size:25px;font-weight:700;color:#fff;direction:rtl}
.unit .meta{position:absolute;right:26px;top:66px;font-size:16px;color:#e5dcc4}
.unit .meta b{font-weight:800;color:#fff}
.unit .cells{position:absolute;right:26px;left:26px;top:110px;display:flex;flex-direction:row;direction:rtl}
.unit .cell{flex:1;text-align:center}
.unit .cell b{display:block;font-size:36px;font-weight:800;color:#d8b86a;line-height:1.2}
.unit .cell span{display:block;font-size:14px;color:#d9cfb6;line-height:1.25;margin-top:6px}
.unit .closed{position:absolute;right:26px;bottom:14px;font-size:14px;color:#d9cfb6}
.rows{position:absolute;left:28px;right:28px;list-style:none}
.rows li{display:flex;align-items:center;height:42px;border-bottom:1px solid #4a4030}
.rows li b{width:90px;font-size:28px;font-weight:800;color:#d8b86a;text-align:center}
.rows li span{font-size:18px;font-weight:700;color:#fff;flex:1}
.rows li i{font-style:normal;font-size:15px;color:#d9cfb6;width:150px;text-align:left}
.sub{position:absolute;right:28px;top:22px;font-size:25px;font-weight:700;color:#fff}
.oulist{position:absolute;right:34px;left:34px;top:66px;display:flex;flex-direction:column;gap:6px}
.ou h5{font-size:21px;font-weight:700;color:#d8b86a;margin-bottom:6px}
.ou p{font-size:15.5px;line-height:1.55;color:#e5dcc4}
.act{position:absolute;left:28px;right:28px;top:68px;list-style:none}
.act li{display:flex;align-items:center;min-height:44px;padding:6px 28px;border-radius:4px}
.act li:nth-child(odd){background:rgba(255,255,255,.10)}
.act li b{width:300px;font-size:17px;font-weight:700;color:#d8b86a}
.act li span{flex:1;font-size:17px;color:#f3ead6}
`;

function page(css, inner, n, of, dateStr, title, label) {
  const bg = dataUri("farmer_card_bg.jpg", "image/jpeg");
  const logo = dataUri("rcu_logo.png", "image/png");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css(bg, logo)}</style></head><body><div class="stage">
 <div class="logo"></div><div class="org">${esc(dateStr.org)}</div><div class="title">${esc(title)}</div>
 ${inner}
 <div class="foot"><span>المصدر: منصة مركز الزراعة • البيانات حتى ${dateStr.slash}</span><span>صفحة ${n} من ${of}</span></div>
</div></body></html>`;
}

function page1(d, dp) {
  const showNew = d.units.some((u) => u.stages.newIn > 0);
  const stageKeys = fr.STAGES.filter((s) => s.key !== "newIn" || showNew);
  const unitPos = [
    { l: 1254, t: 510 }, // IPM
    { l: 588, t: 510 }, // الثروة الحيوانية
    { l: 1254, t: 785 }, // الأسواق
    { l: 588, t: 785 }, // الإرشاد
  ];
  const unitCard = (u, i) => `<div class="unit" style="left:${unitPos[i].l}px;top:${unitPos[i].t}px">
  <h4>${esc(u.name)}</h4>
  <div class="meta"><b>${u.open}</b> مفتوح من ${u.total} &nbsp;|&nbsp; بلا حركة: ${u.stalled} &nbsp;|&nbsp; الأقدم: ${u.oldest} يومًا</div>
  <div class="cells">${stageKeys.map((s) => `<div class="cell"><b>${u.stages[s.key]}</b><span>${esc(s.label).replace("بانتظار تحويل لمقدم الخدمة", "بانتظار تحويل<br>لمقدم الخدمة")}</span></div>`).join("")}</div>
  <div class="closed">مكتملة ومغلقة: ${u.done} &nbsp;|&nbsp; مغلقة دون تنفيذ: ${u.closedNoExec}</div></div>`;
  const prio = fr.buildPriorities(d);
  const doneNote = d.done === 0 ? "لم يُغلق أي طلب مكتمل حتى الآن" : `${d.total ? Math.round((d.done / d.total) * 100) : 0}% من إجمالي الطلبات`;
  return `
 <div class="panel side">
  <h2>ملخص المتابعة</h2><hr>
  <div class="sumbox"><b>${d.stalled}</b><span>طلبًا بلا حركة ${fr.STALLED_DAYS} أيام فأكثر</span></div>
  <h3 style="top:300px;color:#d8b86a">مؤشرات الإنجاز</h3>
  <div class="ind" style="top:350px"><b>${d.openPct}%</b><span>من إجمالي الطلبات ما زالت مفتوحة</span></div>
  <div class="ind" style="top:438px"><b>${d.closedNoExec}</b><span>طلبات مرفوضة أو ملغاة</span></div>
  <div class="ind" style="top:526px"><b>${d.done}</b><span>طلبات مكتملة ومغلقة</span></div>
  <h3 style="top:640px;color:#e08f6a;font-size:28px">أولويات التنفيذ</h3>
  <ul class="prio" style="top:700px">${prio.map((p) => `<li>• ${esc(p)}</li>`).join("") || "<li>لا توجد إجراءات معلّقة</li>"}</ul>
 </div>
 <div class="kpi" style="left:1499px;--c:#d6b25e"><h4>إجمالي الطلبات</h4><div class="n">${d.total}</div><div class="bar"><u style="width:100%"></u></div><small>${d.units.length} وحدات تشغيلية</small></div>
 <div class="kpi" style="left:1052px;--c:#e08f6a"><h4>طلبات مفتوحة</h4><div class="n">${d.open}</div><div class="bar"><u style="width:${d.openPct}%"></u></div><small>${d.openPct}% من إجمالي الطلبات</small></div>
 <div class="kpi" style="left:605px;--c:#e0cfae"><h4>مكتملة ومغلقة</h4><div class="n" style="color:#fff">${d.done}</div><div class="bar"><u style="width:${d.total ? Math.round((d.done / d.total) * 100) : 0}%"></u></div><small>${doneNote}</small></div>
 ${d.units.map(unitCard).join("")}`;
}

function page2(d) {
  const ipm = d.units.find((u) => u.key === "ipm");
  const st = ipm.statuses;
  const rows = [
    ["newIn", ipm.stages.newIn, "طلبات جديدة", "ممثل علاقات المزارعين", ipm.stages.newIn > 0],
    ["toAssign", ipm.stages.toAssign, "بانتظار تحويل لمقدم الخدمة", "ممثل الوحدة", true],
    ["fe", st.FieldExecution || 0, "قيد التنفيذ الميداني", "الفهاد", true],
    ["cr", st.CaseReview || 0, "نُفّذ العمل ولم يُغلق الطلب", "الفهاد", true],
    ["comp", ipm.stages.completion, "بانتظار التحقق من الإنجاز", "ممثل الوحدة", true],
    ["mgr", ipm.stages.manager, "بانتظار اعتماد المدير", "مدير الوحدة", true],
    ["done", ipm.done, "مكتملة ومغلقة (تم إشعار المزارع)", "—", ipm.done > 0],
  ].filter((r) => r[4]);
  const others = d.units.filter((u) => u.key !== "ipm");
  const actions = fr.buildActions(d);
  const actRows = actions.length ? actions : [{ role: "—", text: "لا توجد إجراءات معلّقة." }];
  return `
 <div class="panel" style="left:1048px;top:228px;width:841px;height:388px"><div class="sub">${esc(ipm.name)}</div>
  <ul class="rows" style="top:78px">${rows.map((r) => `<li><b>${r[1]}</b><span>${esc(r[2])}</span><i>${esc(r[3])}</i></li>`).join("")}</ul></div>
 <div class="panel" style="left:83px;top:228px;width:930px;height:388px"><div class="sub" style="font-size:24px">حالة الوحدات الأخرى</div>
  <div class="oulist">${others
    .map((u) => `<div class="ou"><h5>${esc(u.name)}</h5><p>${fr.buildOtherUnitLines(u).map(esc).join("<br>")}</p></div>`)
    .join("")}</div></div>
 <div class="panel" style="left:83px;top:645px;width:1806px;height:${Math.min(400, 100 + actRows.length * 44)}px"><div class="sub" style="top:20px">الإجراءات المطلوبة</div>
  <ul class="act" style="top:70px">${actRows.map((a) => `<li><b>${esc(a.role)}</b><span>${esc(a.text)}</span></li>`).join("")}</ul></div>`;
}

function renderHtmlPages(d) {
  const dp = dateParts(d.now);
  const dateStr = { org: `مركز الزراعة • ${dp.day} ${dp.month} ${dp.year}`, slash: dp.slash };
  return [
    page(CSS, page1(d, dp), 1, 2, dateStr, "حالة طلبات خدمات المزارعين"),
    page(CSS, page2(d), 2, 2, dateStr, "تفاصيل الإجراءات المطلوبة"),
  ];
}

async function renderFarmerRequestsFiles(d) {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: true });
  const hardStop = setTimeout(() => browser.close().catch(() => {}), 150 * 1000);
  const tmp = [];
  try {
    const pngs = [];
    for (const html of renderHtmlPages(d)) {
      const page = await browser.newPage();
      await page.setViewport({ width: 2000, height: 1125, deviceScaleFactor: 1.92 });
      await page.setContent(html, { waitUntil: "networkidle2", timeout: 40000 }).catch(async () => {
        await page.setContent(html, { waitUntil: "load" });
      });
      await page.evaluate(async () => {
        const sample = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي٠١٢٣٤٥٦٧٨٩٪+·";
        for (const w of [400, 600, 700, 800]) await document.fonts.load(`${w} 40px Cairo`, sample);
        await document.fonts.ready;
      });
      await new Promise((r) => setTimeout(r, 400));
      pngs.push(Buffer.from(await page.screenshot({ type: "png" })));
      await page.close();
    }
    const stamp = `${process.pid}-${Date.now()}`;
    const imgs = pngs.map((b, i) => {
      const p = path.join(os.tmpdir(), `farmer-requests-${stamp}-${i}.png`);
      fs.writeFileSync(p, b);
      tmp.push(p);
      return p;
    });
    const htmlPath = path.join(os.tmpdir(), `farmer-requests-${stamp}.html`);
    tmp.push(htmlPath);
    fs.writeFileSync(
      htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:1280px 720px;margin:0}html,body{margin:0;padding:0;background:#000}img{display:block;width:1280px;height:720px;page-break-after:always}img:last-child{page-break-after:auto}</style></head><body>${imgs
        .map((p) => `<img src="file:///${p.replace(/\\/g, "/")}">`)
        .join("")}</body></html>`,
      "utf8"
    );
    const pdfPage = await browser.newPage();
    await pdfPage.goto(`file:///${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "load" });
    const pdf = Buffer.from(await pdfPage.pdf({ width: "1280px", height: "720px", printBackground: true, preferCSSPageSize: true }));
    return { pngs, pdf };
  } finally {
    clearTimeout(hardStop);
    tmp.forEach((f) => {
      try {
        fs.unlinkSync(f);
      } catch {
        // مؤقت
      }
    });
    await browser.close();
  }
}

module.exports = { renderHtmlPages, renderFarmerRequestsFiles };
