const ExcelJS = require("exceljs");
const { normalizeSaudiPhone } = require("./phoneUtil");
const { ISSUE_LABEL } = require("./cardNoticeVerify");

// تقرير "إشعارات إصدار البطاقات": كل بطاقة جاهزة في المنصة (Printed + Pending Delivery) ومعاها: هل وصلها إشعار
// "جاهزة للاستلام"؟ ولو لأ فالسبب بالتحديد. دوال نقية (بتاخد صفوف المنصة وسجل الإرسال كمُدخل) عشان تتختبر بسهولة.
// ctx: { hasBeenSent(phone), lastDecision(phone) -> {decision, reason}|null, sentDate(phone) -> "YYYY-MM-DD"|"" }
const TZ = "Asia/Riyadh";
const GREEN = "1F4E3D";
const REASON_QUEUE = "في طابور الإرسال (الإرسال بدفعات صغيرة لحماية رقم واتساب)";

function classify(row, ctx, phoneCount) {
  const phone = row.phone ? normalizeSaudiPhone(row.phone) : "";
  const base = { name: row.name || "", phone, nationalId: row.nationalId || "", formNumber: row.formNumber || "", sentAt: "", code: "", reason: "", sent: false, note: "" };
  if (phone && phoneCount.get(phone) > 1) base.note = `نفس الجوال مرتبط بـ${phoneCount.get(phone)} بطاقات، والإشعار يُرسل مرة واحدة لكل رقم`;
  if (!phone) return { ...base, code: "NO_PHONE", reason: ISSUE_LABEL.NO_PHONE };
  if (!/^9665\d{8}$/.test(phone)) return { ...base, code: "INVALID_PHONE", reason: ISSUE_LABEL.INVALID_PHONE };
  if (ctx.hasBeenSent(phone)) return { ...base, sent: true, code: "SENT", sentAt: ctx.sentDate(phone) || "" };
  // بطاقة صدرت قبل تاريخ بدء الإرسال الآلي (7 سبتمبر 2026): البوت ما بيبعتلها إشعار أصلًا
  if (ctx.beforeStart && ctx.beforeStart(row)) return { ...base, code: "BEFORE_START", reason: "بطاقة قديمة (قبل 7 سبتمبر 2026) خارج نطاق الإرسال التلقائي" };
  const d = ctx.lastDecision(phone);
  if (!d) return { ...base, code: "NOT_ATTEMPTED", reason: "لا يوجد أي أثر للإرسال لهذا الرقم (لا إرسال ولا منع) - غالبًا لم يأتِ دوره بعد في الدفعات" };
  if (d.decision === "SENT") return { ...base, sent: true, code: "SENT" };
  if (d.decision === "RATE_LIMITED") return { ...base, code: "NOT_ATTEMPTED", reason: REASON_QUEUE };
  if (d.decision === "FAILED") {
    const notOnWa = /not_on_whatsapp/i.test(d.reason || "");
    return { ...base, code: notOnWa ? "NOT_ON_WHATSAPP" : "FAILED", reason: ISSUE_LABEL[notOnWa ? "NOT_ON_WHATSAPP" : "FAILED"] + (!notOnWa && d.reason ? ` (${d.reason})` : "") };
  }
  const code = ISSUE_LABEL[d.decision] ? d.decision : "FAILED";
  return { ...base, code, reason: ISSUE_LABEL[code] || d.decision };
}

function buildCardNoticeReport(rows, ctx, now = new Date()) {
  const phoneCount = new Map();
  rows.forEach((r) => {
    const p = r.phone ? normalizeSaudiPhone(r.phone) : "";
    if (p) phoneCount.set(p, (phoneCount.get(p) || 0) + 1);
  });
  const items = [];
  const seen = new Set();
  rows.forEach((row) => {
    const phone = row.phone ? normalizeSaudiPhone(row.phone) : "";
    const key = row.formNumber ? `f:${row.formNumber}` : phone || row.nationalId;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    items.push(classify(row, ctx, phoneCount));
  });
  const sentItems = items.filter((i) => i.sent);
  const notSent = items.filter((i) => !i.sent);
  const reasons = {};
  notSent.forEach((i) => (reasons[i.reason] = (reasons[i.reason] || 0) + 1));
  return { now, total: items.length, sent: sentItems.length, notSent: notSent.length, items, sentItems, notSentItems: notSent, reasons, percent: items.length ? Math.round((sentItems.length * 100) / items.length) : 0 };
}

const fmtDateTime = (d) =>
  `${d.toLocaleDateString("ar-SA", { timeZone: TZ, weekday: "long", day: "numeric", month: "numeric", year: "numeric" })} - ${d.toLocaleTimeString("ar-SA", { timeZone: TZ, hour: "numeric", minute: "2-digit" })}`;
const fmtPhone = (p) => (p.phone ? `+${p.phone}` : "بدون رقم");

function formatCardNoticeMessage(r, listLimit = 25) {
  const lines = ["📬 تقرير إشعارات إصدار البطاقات", `🗓 ${fmtDateTime(r.now)}`, "━━━━━━━━━━━━━━━━━━", ""];
  lines.push(`🪪 البطاقات الجاهزة في المنصة (مطبوعة / بانتظار التسليم): ${r.total}`, `✅ وصلهم إشعار الإصدار: ${r.sent} (${r.percent}%)`, `❌ لم يصلهم: ${r.notSent}`);
  if (r.notSent) {
    lines.push("", "📌 أسباب عدم الإرسال");
    Object.entries(r.reasons)
      .sort((a, b) => b[1] - a[1])
      .forEach(([reason, n]) => lines.push(`• ${reason}: ${n}`));
    lines.push("", "━━━━━━━━━━━━━━━━━━", `🧾 من لم يصلهم الإشعار (أول ${Math.min(listLimit, r.notSent)}):`);
    r.notSentItems.slice(0, listLimit).forEach((p, i) => {
      lines.push(`${i + 1}. ${p.name || "بدون اسم"} - ${fmtPhone(p)}${p.formNumber ? ` (طلب ${p.formNumber})` : ""}`, `   السبب: ${p.reason}`);
    });
    if (r.notSent > listLimit) lines.push(`...و${r.notSent - listLimit} آخرين في ملف Excel.`);
  } else if (r.total) {
    lines.push("", "✔️ كل البطاقات الجاهزة وصلها إشعار الإصدار.");
  }
  lines.push("", "━━━━━━━━━━━━━━━━━━", "📎 التفاصيل الكاملة (كل بطاقة وسببها) في ملف Excel المرفق.");
  return lines.join("\n");
}

const thin = { style: "thin", color: { argb: "FFD0D0D0" } };
const BORDER = { left: thin, right: thin, top: thin, bottom: thin };
const CENTER = { horizontal: "center", vertical: "middle" };
const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb: `FF${argb}` } });
const headerRow = (row) =>
  row.eachCell({ includeEmpty: true }, (c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = solid(GREEN);
    c.alignment = CENTER;
    c.border = BORDER;
  });

const COLUMNS = [
  ["#", 6], ["الاسم", 30], ["الجوال", 16], ["رقم الهوية", 15], ["رقم الطلب", 12], ["الحالة", 14], ["تاريخ الإرسال", 14], ["سبب عدم الإرسال", 52], ["ملاحظة", 42],
];

function addListSheet(wb, name, list) {
  const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map(([header, width]) => ({ header, width }));
  headerRow(ws.getRow(1));
  list.forEach((p, i) => {
    const row = ws.addRow([i + 1, p.name, p.phone ? String(p.phone) : "", String(p.nationalId || ""), p.formNumber, p.sent ? "تم الإرسال" : "لم يُرسل", p.sentAt || "", p.reason, p.note]);
    row.eachCell({ includeEmpty: true }, (c) => {
      c.alignment = CENTER;
      c.border = BORDER;
    });
    row.getCell(6).fill = solid(p.sent ? "C6EFCE" : "F8CBAD");
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
}

async function buildCardNoticeBuffer(r) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("الملخص", { views: [{ rightToLeft: true }] });
  ws.columns = [{ width: 46 }, { width: 14 }];
  ws.mergeCells("A1:B1");
  ws.getCell("A1").value = "تقرير إشعارات إصدار البطاقات";
  ws.getCell("A1").font = { bold: true, size: 16, color: { argb: `FF${GREEN}` } };
  ws.getCell("A2").value = fmtDateTime(r.now);
  const rows = [
    ["البطاقات الجاهزة في المنصة", r.total],
    ["وصلهم إشعار الإصدار", r.sent],
    ["لم يصلهم الإشعار", r.notSent],
    ["نسبة الإرسال", `${r.percent}%`],
  ];
  rows.forEach((v, i) => {
    const row = ws.getRow(4 + i);
    row.values = v;
    row.eachCell((c) => { c.border = BORDER; c.alignment = CENTER; });
    row.getCell(1).font = { bold: true };
  });
  ws.getCell(`A${9}`).value = "أسباب عدم الإرسال";
  ws.getCell(`A${9}`).font = { bold: true, color: { argb: `FF${GREEN}` } };
  Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).forEach(([reason, n], i) => {
    const row = ws.getRow(10 + i);
    row.values = [reason, n];
    row.eachCell((c) => { c.border = BORDER; c.alignment = CENTER; });
  });
  addListSheet(wb, "لم يُرسل (مع السبب)", r.notSentItems);
  addListSheet(wb, "تم الإرسال", r.sentItems);
  addListSheet(wb, "كل البطاقات", [...r.notSentItems, ...r.sentItems]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cardNoticeFileName(now = new Date()) {
  return `تقرير إشعارات إصدار البطاقات - ${now.toLocaleDateString("en-CA", { timeZone: TZ })}.xlsx`;
}

// إعادة إرسال إشعار الإصدار للمتأخرين: بس الحالات اللي إعادة المحاولة معاها منطقية وآمنة. بنستبعد بوضوح:
//  رقم ناقص/غلط، غير مسجّل على واتساب، حالة تمنع/طلب أحدث (قرار مقصود)، بطاقة قديمة قبل تاريخ البدء،
//  وDELIVERY_UNCERTAIN (ممكن اتبعت فعلًا - إعادة الإرسال تكرره). والاسم لازم عربي (من بيانات الطلب نفسه).
const RETRYABLE = new Set(["NOT_ATTEMPTED", "FAILED"]);
function selectResendCandidates(report, { cap = 40, isArabic = () => true } = {}) {
  const retryable = report.notSentItems.filter((i) => RETRYABLE.has(i.code));
  const arabic = retryable.filter((i) => isArabic(i.name));
  const nonArabic = retryable.filter((i) => !isArabic(i.name));
  const toSend = arabic.slice(0, cap);
  const excluded = {};
  report.notSentItems.filter((i) => !RETRYABLE.has(i.code)).forEach((i) => (excluded[i.reason] = (excluded[i.reason] || 0) + 1));
  return { toSend, deferred: Math.max(0, arabic.length - cap), nonArabic, excluded };
}

module.exports = { selectResendCandidates, buildCardNoticeReport, formatCardNoticeMessage, buildCardNoticeBuffer, cardNoticeFileName, classify };
