const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

// رمز QR لربط واتساب كصفحة HTML/SVG (بتتحدّث تلقائيًا كل 5 ثواني وهو بيتغيّر) بدل QR الطرفية اللي بيتقصّ
// وبيصعب مسحه على جهاز بشاشة صغيرة. بتتكتب في مجلد البوت كـwhatsapp_qr.html (افتحها بأي متصفح).
// من غير أي مكتبة جديدة: بنستخدم نفس مولّد QR الموجود أصلًا في qrcode-terminal.
const QR_HTML_FILE = path.join(__dirname, "..", "whatsapp_qr.html");

function qrSvg(text, scale = 8, quiet = 4) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + quiet * 2) * scale;
  let rects = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) rects += `<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

function writeQrHtml(text, file = QR_HTML_FILE) {
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>ربط واتساب</title><style>body{font-family:Tahoma,Arial,sans-serif;background:#f4f1ea;margin:0;padding:24px;text-align:center;color:#222}
svg{max-width:90vmin;height:auto;background:#fff;padding:12px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15)}p{font-size:20px;margin:10px}small{color:#777}</style></head>
<body><p><b>امسح الرمز من واتساب: الأجهزة المرتبطة ← ربط جهاز</b></p>${qrSvg(text)}<p><small>تتحدّث الصفحة تلقائيًا كل 5 ثواني - آخر تحديث: ${new Date().toLocaleTimeString("ar-SA")}</small></p></body></html>`;
  fs.writeFileSync(file, html, "utf8");
  return file;
}

module.exports = { qrSvg, writeQrHtml, QR_HTML_FILE };
