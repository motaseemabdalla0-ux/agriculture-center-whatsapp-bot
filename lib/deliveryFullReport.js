const ExcelJS = require("exceljs");
const store = require("./deliveryStore");
const { platformNumberFor } = require("./deliveryOutcome");
const { loadDeliveredSnapshot, normPhone } = require("./portalDeliveryCheck");

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

// "يوم" / "يومين" / "3 أيام" ... "11 يومًا" بالمطابقة العربية الصحيحة
function daysAr(n) {
  if (n === 1) return "يوم";
  if (n === 2) return "يومين";
  if (n >= 3 && n <= 10) return `${n} أيام`;
  return `${n} يومًا`;
}

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
        finishedAt: r.status === "DELIVERED" ? r.deliveredAt : r.status === "FAILED_DELIVERY" ? r.failedAt : null,
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
  // سجل التسليم الكامل من المنصة (آخر قراءة لتاب "Delivered") - يشمل البطاقات القديمة حتى اللي
  // ماليهاش طلب توصيل في البوت، ومعاه ربطها بطلب التوصيل (والمنطقة) لو موجود
  const snapshot = loadDeliveredSnapshot();
  const byPhone = new Map(rows.map((r) => [normPhone(r.phone), r]));
  const portalHistory = {
    fetchedAt: snapshot.fetchedAt,
    rows: snapshot.rows.map((r) => {
      const linked = byPhone.get(normPhone(r.phone));
      return { ...r, requestId: linked ? linked.id : "", region: linked ? linked.region : "" };
    }),
  };
  const total = rows.length;
  const done = count(rows, "DELIVERED");
  return { now, rows, regions, portalHistory, total, done, open: count(rows, "NEW"), failed: count(rows, "FAILED_DELIVERY"), late: rows.filter((r) => r.late).length, percent: total ? Math.round((done * 100) / total) : 0 };
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
  let next = 25;
  if (!late.length) {
    ws.getCell("A23").value = "لا توجد طلبات متأخرة ✔️";
  } else {
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
    next = 24 + late.length + 1;
  }
  addDeliveredBlock(ws, next + 1, data);
}

// كرت "البطاقات التي تم توصيلها": كل بطاقة اتسلّمت بالاسم والمنطقة وتاريخ التوصيل، وعمود "سبب
// تعذّر سابق" لو الطلب كان اتسجّل تعذّر قبل كده وبعدين اتسلّم بعد موعد جديد
const DELIVERED_HEADERS = ["رقم الطلب", "الاسم", "الجوال", "المنطقة", "تاريخ التوصيل", "سبب تعذّر سابق (إن وجد)"];
const deliveredRows = (data) =>
  data.rows.filter((r) => r.status === "DELIVERED").sort((a, b) => String(b.finishedAt || "").localeCompare(String(a.finishedAt || "")));
const deliveredValues = (r) => [r.number, r.name, String(r.phone), r.region, r.finished, r.reason || ""];

function addDeliveredBlock(ws, startRow, data) {
  const list = deliveredRows(data);
  ws.getCell(`A${startRow}`).value = `✅ البطاقات التي تم توصيلها (${list.length})`;
  ws.getCell(`A${startRow}`).font = { bold: true, size: 13, color: { argb: `FF${GREEN}` } };
  if (!list.length) {
    ws.getCell(`A${startRow + 1}`).value = "لا توجد بطاقات تم توصيلها بعد.";
    return;
  }
  ws.getRow(startRow + 1).values = DELIVERED_HEADERS;
  headerRow(ws.getRow(startRow + 1));
  list.forEach((r, i) => {
    const row = ws.getRow(startRow + 2 + i);
    row.values = deliveredValues(r);
    row.eachCell({ includeEmpty: true }, (c) => {
      c.alignment = CENTER;
      c.border = BORDER;
    });
  });
}

// سجل التسليم الكامل من المنصة (كل اللي ظاهر في تاب Delivered بغض النظر عن طلبات التوصيل)
function addPortalHistorySheet(wb, data) {
  const history = data.portalHistory || { rows: [], fetchedAt: null };
  const ws = wb.addWorksheet("سجل التسليم (المنصة)", { views: [{ rightToLeft: true, state: "frozen", ySplit: 2 }] });
  const headers = ["رقم النموذج", "الاسم", "الجوال", "رقم الهوية", "مرتبط بطلب توصيل", "المنطقة"];
  [12, 30, 15, 15, 18, 10].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.mergeCells("A1:F1");
  ws.getCell("A1").value = history.fetchedAt
    ? `كل البطاقات "تم التسليم" في المنصة (${history.rows.length}) - آخر قراءة: ${fmtDate(history.fetchedAt)}`
    : "لسه ما اتقرا سجل التسليم من المنصة - بيتحدّث بعد أول فحص لتاب Delivered";
  ws.getCell("A1").font = { bold: true, color: { argb: `FF${GREEN}` } };
  ws.getRow(2).values = headers;
  headerRow(ws.getRow(2));
  history.rows.forEach((r) => {
    const row = ws.addRow([r.formNumber, r.name, String(r.phone || ""), String(r.nationalId || ""), r.requestId || "—", r.region || ""]);
    row.eachCell({ includeEmpty: true }, (c) => {
      c.alignment = CENTER;
      c.border = BORDER;
    });
  });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: headers.length } };
}

function addDeliveredSheet(wb, data) {
  const ws = wb.addWorksheet("تم التوصيل", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  ws.columns = DELIVERED_HEADERS.map((header, i) => ({ header, key: `c${i}`, width: [12, 28, 15, 10, 16, 30][i] }));
  headerRow(ws.getRow(1));
  deliveredRows(data).forEach((r) => {
    const row = ws.addRow(deliveredValues(r));
    row.eachCell({ includeEmpty: true }, (c) => {
      c.alignment = CENTER;
      c.border = BORDER;
    });
    row.getCell(1).fill = solid(STATUS_FILL.DELIVERED);
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: DELIVERED_HEADERS.length } };
}

async function buildFullReportBuffer(data) {
  const wb = new ExcelJS.Workbook();
  addSummarySheet(wb, data);
  addRequestsSheet(wb, "كل الطلبات", data.rows);
  data.regions.forEach((reg) => addRequestsSheet(wb, reg.ar, data.rows.filter((r) => r.regionKey === reg.key)));
  addDeliveredSheet(wb, data);
  addPortalHistorySheet(wb, data);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function reportFileName(now = new Date()) {
  return `تفاصيل توصيل البطاقات - ${now.toLocaleDateString("en-CA", { timeZone: TZ })}.xlsx`;
}

// قائمة التجهيز: البطاقات اللي لازم تتجهّز للتسليم (الطلبات المفتوحة "قيد التوصيل") مقسّمة حسب
// المنطقة ببيانات كل مستفيد - اللي بتوصل لموظف التقرير اليومي. الطلبات التجريبية مستبعدة
function formatPrepList(data) {
  const open = data.rows.filter((r) => r.status === "NEW");
  const head = [`📋 البطاقات المطلوب تجهيزها لفرق التسليم (حسب المنطقة)`, `🗓 ${fmtDateTime(data.now)}`, "━━━━━━━━━━━━━━━━━━", ""];
  if (!open.length) return [...head, "لا توجد بطاقات مطلوب تجهيزها حاليًا ✔️"].join("\n");
  const sections = data.regions.map((reg) => {
    const list = open.filter((r) => r.regionKey === reg.key).sort((a, b) => (b.waitDays || 0) - (a.waitDays || 0));
    if (!list.length) return `📍 *${reg.ar}* (0): لا يوجد.`;
    const lines = list.map((r, i) =>
      `${i + 1}. ${r.name || "بدون اسم"}${r.late ? " ⚠️" : ""}
   📱 ${store.formatContact(r.phone)} | طلب ${r.number}
   🕒 ${r.preferred || "غير محدَّد"}${r.waitDays ? ` | منذ ${daysAr(r.waitDays)}` : ""}`
    );
    return `📍 *${reg.ar}* (${list.length}):
${lines.join("\n")}`;
  });
  const delivered = data.rows.filter((r) => r.status === "DELIVERED").length;
  const footer = [`إجمالي البطاقات المطلوب تجهيزها: ${open.length}`];
  if (delivered) footer.push(`✅ تم توصيل: ${delivered} بطاقة (التفاصيل في ورقة "تم التوصيل" بملف Excel)`);
  return [...head, sections.join("\n\n"), "", "━━━━━━━━━━━━━━━━━━", ...footer].join("\n");
}

// ملف Excel لقائمة التجهيز: ورقة "كل البطاقات" + ورقة لكل منطقة، فيها عمود فاضي "تم التجهيز" للموظف
const PREP_COLUMNS = [
  ["#", "idx", 6], ["الاسم", "name", 28], ["الجوال", "phone", 15], ["رقم الطلب", "number", 12], ["المنطقة", "region", 10],
  ["الموعد المفضّل", "preferred", 22], ["تاريخ الطلب", "created", 13], ["أيام الانتظار", "waitDays", 12], ["الموقع", "map", 34], ["تم التجهيز", "prepared", 12],
];

async function buildPrepBuffer(data) {
  const wb = new ExcelJS.Workbook();
  const open = data.rows.filter((r) => r.status === "NEW").sort((a, b) => (b.waitDays || 0) - (a.waitDays || 0));
  const addSheet = (name, list) => {
    const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.columns = PREP_COLUMNS.map(([header, key, width]) => ({ header, key, width }));
    headerRow(ws.getRow(1));
    list.forEach((r, i) => {
      const row = ws.addRow({ ...r, idx: i + 1, phone: String(r.phone), waitDays: r.waitDays === null ? "" : r.waitDays, prepared: "" });
      row.eachCell({ includeEmpty: true }, (c) => {
        c.alignment = CENTER;
        c.border = BORDER;
      });
      if (r.late) row.eachCell((c) => { c.font = { bold: true, color: { argb: "FFC00000" } }; });
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: PREP_COLUMNS.length } };
  };
  addSheet("كل البطاقات", open);
  data.regions.forEach((reg) => addSheet(reg.ar, open.filter((r) => r.regionKey === reg.key)));
  addDeliveredSheet(wb, data); // نفس كرت البطاقات اللي تم توصيلها (+ سبب التعذّر السابق) في ملف التجهيز
  addPortalHistorySheet(wb, data);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function prepFileName(now = new Date()) {
  return `البطاقات المطلوب تجهيزها - ${now.toLocaleDateString("en-CA", { timeZone: TZ })}.xlsx`;
}

module.exports = { buildFullReport, formatFullReportMessage, formatPrepList, buildFullReportBuffer, reportFileName, buildPrepBuffer, prepFileName, LATE_AFTER_DAYS };
