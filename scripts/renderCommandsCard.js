// يرسم بطاقة "أوامر تقارير الإدارة" كصورة PNG لإرسالها للإدارة
const puppeteer = require("puppeteer");
const path = require("path");

const OUT = process.argv[2] || path.join(__dirname, "..", "..", "اوامر تقارير الادارة.png");

const ROWS = [
  ["١", "بطاقة المزارع", "أرقام المنصة الحيّة: المراجعة، انتظار الطباعة، المطبوعة، المسلّمة", "تقرير بطاقة المزارع", "صورة + PDF"],
  ["٢", "بطاقة المزارع مع الكشف", "نفس التقرير مع إضافة أرقام الكشف الذي لم يُرفع على المنصة", "تقرير بطاقة المزارع مع الكشف", "صورة + PDF"],
  ["٣", "تقرير التوصيل", "كل طلبات التوصيل وحالاتها: مفتوحة، مسلّمة، متعذّرة", "تقرير التوصيل", "رسالة + Excel"],
  ["٤", "تجهيز البطاقات", "البطاقات المطلوب تجهيزها لفرق التسليم حسب المنطقة", "تجهيز البطاقات", "رسالة + Excel"],
  ["٥", "طلبات المزارعين", "حالة طلبات الخدمات: المفتوحة، المتعثرة، وحسب الوحدة، مع الإجراءات المطلوبة", "تقرير طلبات المزارعين", "PDF"],
];

const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}
body{width:2000px;height:1125px;font-family:'Cairo',sans-serif;background:linear-gradient(135deg,#0b2e22,#124a37 60%,#0b2e22);color:#fff;padding:40px 90px;position:relative;overflow:hidden}
.top{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:22px}
h1{font-size:68px;font-weight:800}
.sub{font-size:30px;color:#9fd8bf;margin-top:6px}
.badge{font-size:26px;color:#d6b25e;border:2px solid #d6b25e;padding:8px 26px;border-radius:40px}
.row{display:flex;align-items:center;gap:34px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:26px;padding:12px 38px;margin-bottom:14px}
.num{width:68px;height:68px;border-radius:50%;background:#d6b25e;color:#0b2e22;font-size:44px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:none}
.info{flex:1}
.name{font-size:36px;font-weight:700}
.desc{font-size:24px;color:#b9d8ca;margin-top:4px}
.cmd{background:#fff;color:#0b2e22;font-size:34px;font-weight:800;padding:10px 34px;border-radius:18px;white-space:nowrap}
.out{font-size:24px;color:#d6b25e;width:190px;text-align:center}
.foot{position:absolute;bottom:30px;right:90px;left:90px;display:flex;justify-content:space-between;font-size:24px;color:#9fd8bf}
</style></head><body>
<div class="top"><div><h1>أوامر تقارير الإدارة</h1><div class="sub">اكتب الأمر كما هو في محادثة البوت، وتُحدَّث الأرقام من المنصة قبل كل إرسال</div></div><div class="badge">مركز الزراعة</div></div>
${ROWS.map((r) => `<div class="row"><div class="num">${r[0]}</div><div class="info"><div class="name">${r[1]}</div><div class="desc">${r[2]}</div></div><div class="out">${r[4]}</div><div class="cmd">${r[3]}</div></div>`).join("")}
<div class="foot"><span>الأوامر متاحة لأرقام الإدارة المسجّلة فقط</span><span>تقرير التوصيل وقائمة التجهيز يصلان تلقائيًا الساعة ١٠ صباحًا</span></div>
</body></html>`;

(async () => {
  const b = await puppeteer.launch({ headless: "new" });
  const p = await b.newPage();
  await p.setViewport({ width: 2000, height: 1125, deviceScaleFactor: 1.5 });
  await p.setContent(html, { waitUntil: "networkidle0" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: OUT });
  await b.close();
  console.log(OUT);
})();
