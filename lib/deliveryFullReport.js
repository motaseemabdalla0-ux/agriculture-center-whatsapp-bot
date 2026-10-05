const ExcelJS = require("exceljs");
const store = require("./deliveryStore");
const { platformNumberFor } = require("./deliveryOutcome");

// التقرير الكامل لطلبات التوصيل: ملخص نصي قصير + ملف Excel بالتفاصيل. فصل البناء (build) عن
// التنسيق (format) وعن ملف Excel عشان يتختبر من غير واتساب. الطلبات التجريبية (اسمها فيه
// "تجريبي" أو اتستبعدت بأمر "استبعد طلب توصيل D-n") مابتدخلش في أي رقم
const LATE_AFTER_DAYS = 3;
const STATUS_LABEL = { NEW: "قيد التوصيل", DELIVERED: "تم التوصيل", FAILED_DELIVERY: "تعذّر التوصيل" };
const STATUS_ORDER = { NEW: 0, FAILED_DELIVERY: 1, DELIVERED: 2 };
const STATUS_FILL = { NEW: "FFF2CC", DELIVERED: "C6EFCE", FAILED_DELIVERY: "F8CBAD" };
const GREEN = "1F4E3D";
const TZ = "Asia/Riyadh";

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ }) : "");
const fmtDateTime = (d) =>
  `${d.toLocaleDateString("ar-SA", { timeZone: TZ, weekday: "long", day: "numeric", month: "numeric", year: "numeric" })} - ${d.toLocaleTimeString("ar-SA", { timeZone: TZ, hour: "numeric", minute: "2-digit" })}`;

function isTestRequest(request, excluded) {
  return excluded.includes(request.id) || /تجريبي/.test(request.name || "");
}

function buildFullReport(now = new Date()) {
  const excluded = store.getReportExcluded();
  const rows = store
    .getAllRequests()
    .filter((r) => !isTestRequest(r, excluded))
    .map((r) => {
      const waitDays = r.status === "NEW" ? Math.floor((now - new Date(r.createdAt)) / 86400000) : null;
      return {
        id: r.id,
        number: r.platformRequestNumber || platformNumberFor(r.phone) || r.id,
        name: r.name || "",
        phone: r.phone,
        regionKey: r.regionKey,
        region: (store.REGION_BY_KEY[r.regionKey] || {}).ar || r.regionKey,
        status: r.status,
        preferred: r.preferredDateTime || "",
        created: fmtDate(r.createdAt),
        finished: fmtDate(r.status === "DELIVERED" ? r.deliveredAt : r.status === "FAILED_DELIVERY" ? r.failedAt : null),
        waitDays,
        late: waitDays !== null && waitDays > LATE_AFTER_DAYS,
        reason: r.failureReason || "",
        map: typeof r.latitude === "number" ? `https://maps.google.com/?q=${r.latitude},${r.longitude}` : "",
      };
    });
  const count = (list, st) => list.filter((r) => r.status === st).length;
  const regions = ["NORTH", "CENTER", "SOUTH"].map((key) => store.REGION_BY_KEY[key]).map((reg) => {
    const list = rows.filter((r) => r.regionKey === reg.key);
    return { key: reg.key, ar: reg.ar, total: list.length, done: count(list, "DELIVERED"), open: count(list, "NEW"), failed: count(list, "FAILED_DELIVERY"), late: list.filter((r) => r.late).length };
  });
  const total = rows.length;
  const done = count(rows, "DELIVERED");
  return { now, rows, regions, total, done, open: count(rows, "NEW"), failed: count(rows, "FAILED_DELIVERY"), late: rows.filter((r) => r.late).length, percent: total ? Math.round((done * 100) / total) : 0 };
}

function formatFullReportMessage(data) {
  const lines = ["📦 تقرير توصيل البطاقات", `🗓 ${fmtDateTime(data.now)}`, "━━━━━━━━━━━━━━━━━━", ""];
  if (data.total === 0) {
    lines.push("لا توجد طلبات توصيل مسجّلة حاليًا.");
    return lines.join("\n");
  }
  lines.push(
    "📊 الملخص",
    `• إجمالي طلبات التوصيل: ${data.total}`,
    `• ✅ تم التوصيل: ${data.done}`,
    `• ⏳ قيد التوصيل: ${data.open}`,
    `• ❌ تعذّر التوصيل: ${data.failed}`,
    `• نسبة الإنجاز: ${data.percent}%`,
    "",
    "━━━━━━━━━━━━━━━━━━",
    "📍 حسب المنطقة",
    ...data.regions.map((r) => `• ${r.ar}: ✅ ${r.done} | ⏳ ${r.open} | ❌ ${r.failed}`)
  );
  if (data.late > 0) lines.push("", "━━━━━━━━━━━━━━━━━━", `⚠️ تنبيه: ${data.late} طلبات مفتوحة منذ أكثر من ${LATE_AFTER_DAYS} أيام`);
  lines.push("", "━━━━━━━━━━━━━━━━━━", "📎 التفاصيل في ملف Excel المرفق. لإعادة إرساله اكتب: تفاصيل المستفيدين");
  return lines.join("\n");
}

const COLUMNS = [
  ["رقم الطلب", "number", 12], ["الاسم", "name", 28], ["الجوال", "phone", 15], ["المنطقة", "region", 10], ["الحالة", "statusLabel", 14],
  ["الموعد المفضّل", "preferred", 22], ["تاريخ الطلب", "created", 13], ["تاريخ التوصيل/التعذّر", "finished", 18], ["أيام الانتظار", "waitDays", 12], ["سبب التعذّر", "reason", 24], ["الموقع", "map", 34],
];
const thin = { style: "thin", color: { argb: "FFD0D0D0" } };
const BORDER = { left: thin, right: thin, top: thin, bottom: thin };
const CENTER = { horizontal: "center", vertical: "middle" };
const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb: `FF${argb.replace(/^FF/, "")}` } });

function headerRow(row, color = GREEN) {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = solid(color);
    c.alignment = CENTER;
    c.border = BORDER;
  });
}

function addRequestsSheet(wb, name, list) {
  const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map(([header, key, width]) => ({ header, key, width }));
  headerRow(ws.getRow(1));
  [...list]
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.region.localeCompare(b.region, "ar"))
    .forEach((r) => {
      const row = ws.addRow({ ...r, statusLabel: STATUS_LABEL[r.status] || r.status, waitDays: r.waitDays === null ? "" : r.waitDays, phone: String(r.phone) });
      row.eachCell((c) => {
        c.alignment = CENTER;
        c.border = BORDER;
      });
      row.getCell(5).fill = solid(STATUS_FILL[r.status] || "FFFFFF");
      if (r.late) row.eachCell((c) => { c.font = { bold: true, color: { argb: "FFC00000" } }; });
    });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  return ws;
}

function addSummarySheet(wb, data) {
  const ws = wb.addWorksheet("الملخص", { views: [{ rightToLeft: true, showGridLines: false }] });
  for (let i = 1; i <= 8; i++) ws.getColumn(i).width = 17;

  ws.mergeCells("A1:H1");
  ws.getCell("A1").value = "📦 تقرير توصيل البطاقات";
  ws.getCell("A1").font = { bold: true, size: 18, color: { argb: "FFFFFFFF" } };
  ws.getCell("A1").fill = solid(GREEN);
  ws.getCell("A1").alignment = CENTER;
  ws.getRow(1).height = 34;
  ws.mergeCells("A2:H2");
  ws.getCell("A2").value = `${fmtDateTime(data.now)}   |   مركز الزراعة - الهيئة الملكية لمحافظة العلا`;
  ws.getCell("A2").alignment = CENTER;
  ws.getCell("A2").font = { color: { argb: "FF666666" } };

  [["إجمالي الطلبات", data.total, "EDEDED"], ["✅ تم التوصيل", data.done, STATUS_FILL.DELIVERED], ["⏳ قيد التوصيل", data.open, STATUS_FILL.NEW], ["❌ تعذّر التوصيل", data.failed, STATUS_FILL.FAILED_DELIVERY]].forEach(([label, value, color], i) => {
    const c0 = 1 + i * 2;
    ws.mergeCells(4, c0, 4, c0 + 1);
    ws.mergeCells(5, c0, 6, c0 + 1);
    ws.getCell(4, c0).value = label;
    ws.getCell(4, c0).font = { bold: true, size: 11 };
    ws.getCell(5, c0).value = value;
    ws.getCell(5, c0).font = { bold: true, size: 26, color: { argb: `FF${GREEN}` } };
    for (const r of [4, 5, 6]) {
      for (const c of [c0, c0 + 1]) {
        ws.getCell(r, c).fill = solid(color);
        ws.getCell(r, c).alignment = CENTER;
        ws.getCell(r, c).border = BORDER;
      }
    }
  });
  ws.getRow(4).height = 22;

  ws.getCell("A11").value = "📍 حسب المنطقة";
  ws.getCell("A11").font = { bold: true, size: 13, color: { argb: `FF${GREEN}` } };
  const pct = (d, t) => (t ? d / t : 0);
  ws.getRow(12).values = ["المنطقة", "الإجمالي", "✅ تم", "⏳ قيد التوصيل", "❌ تعذّر", "نسبة الإنجاز", "متأخرة"];
  headerRow(ws.getRow(12));
  data.regions.forEach((r, i) => {
    ws.getRow(13 + i).values = [r.ar, r.total, r.done, r.open, r.failed, pct(r.done, r.total), r.late];
  });
  ws.getRow(16).values = ["الإجمالي", data.total, data.done, data.open, data.failed, pct(data.done, data.total), data.late];
  for (let r = 13; r <= 16; r++) {
    ws.getRow(r).eachCell((c, col) => {
      c.alignment = CENTER;
      c.border = BORDER;
      if (col === 6) c.numFmt = "0%";
      if (r === 16) {
        c.font = { bold: true };
        c.fill = solid("EDEDED");
      }
    });
    if (r < 16) ws.getCell(r, 1).font = { bold: true };
  }

  // شريط الإنجاز: 5 خلايا ملوّنة (كل خلية 20%) + النسبة بالأرقام - مفيش صيغ ولا Data Bar عشان
  // المعاينات اللي مش Excel بتعرضهم فاضيين
  ws.mergeCells("A19:B19");
  ws.getCell("A19").value = "نسبة الإنجاز";
  ws.getCell("A19").font = { bold: true, size: 12 };
  ws.getCell("A19").alignment = { horizontal: "right", vertical: "middle" };
  ws.getRow(19).height = 26;
  const frac = pct(data.done, data.total);
  ["C", "D", "E", "F", "G"].forEach((col, i) => {
    const lo = i * 0.2;
    ws.getCell(`${col}19`).fill = solid(frac >= lo + 0.2 - 1e-9 ? GREEN : frac > lo ? "7FB09C" : "E4E4E4");
    const white = { style: "medium", color: { argb: "FFFFFFFF" } };
    ws.getCell(`${col}19`).border = { left: white, right: white };
  });
  ws.getCell("H19").value = frac;
  ws.getCell("H19").numFmt = "0%";
  ws.getCell("H19").font = { bold: true, size: 14, color: { argb: `FF${GREEN}` } };
  ws.getCell("H19").alignment = CENTER;

  const late = data.rows.filter((r) => r.late).sort((a, b) => b.waitDays - a.waitDays);
  ws.getCell("A22").value = `⚠️ الطلبات المتأخرة (${late.length}) - قيد التوصيل أكثر من ${LATE_AFTER_DAYS} أيام`;
  ws.getCell("A22").font = { bold: true, size: 13, color: { argb: "FFC00000" } };
  if (!late.length) {
    ws.getCell("A23").value = "لا توجد طلبات متأخرة ✔️";
    return;
  }
  ws.getRow(23).values = ["رقم الطلب", "الاسم", "الجوال", "المنطقة", "أيام الانتظار"];
  headerRow(ws.getRow(23), "C00000");
  late.forEach((r, i) => {
    const row = ws.getRow(24 + i);
    row.values = [r.number, r.name, String(r.phone), r.region, r.waitDays];
    row.eachCell((c) => {
      c.alignment = CENTER;
      c.border = BORDER;
    });
  });
}

async function buildFullReportBuffer(data) {
  const wb = new ExcelJS.Workbook();
  addSummarySheet(wb, data);
  addRequestsSheet(wb, "كل الطلبات", data.rows);
  data.regions.forEach((reg) => addRequestsSheet(wb, reg.ar, data.rows.filter((r) => r.regionKey === reg.key)));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function reportFileName(now = new Date()) {
  return `تفاصيل توصيل البطاقات - ${now.toLocaleDateString("en-CA", { timeZone: TZ })}.xlsx`;
}

module.exports = { buildFullReport, formatFullReportMessage, buildFullReportBuffer, reportFileName, LATE_AFTER_DAYS };
