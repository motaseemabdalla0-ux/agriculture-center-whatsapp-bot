// اختبارات التقرير الكامل لطلبات التوصيل (رسالة + Excel). صفر واتساب حقيقي، وبيرجّع ملف
// البيانات الحقيقي زي ما كان بعد الاختبار
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = ["delivery_state.json", "delivery_state.json.bak", "farmer_state.json", "farmer_state.json.bak"];
const snapshot = () => Object.fromEntries(DATA_FILES.map((n) => [n, fs.existsSync(path.join(ROOT, n)) ? fs.readFileSync(path.join(ROOT, n)) : null]));
const wipe = () => DATA_FILES.forEach((n) => fs.existsSync(path.join(ROOT, n)) && fs.unlinkSync(path.join(ROOT, n)));
const restore = (s) => DATA_FILES.forEach((n) => {
  const p = path.join(ROOT, n);
  if (s[n] === null) { if (fs.existsSync(p)) fs.unlinkSync(p); } else fs.writeFileSync(p, s[n]);
});

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

const snap = snapshot();
wipe();

async function run() {
  const ExcelJS = require("exceljs");
  const store = require("../lib/deliveryStore");
  const { buildFullReport, formatFullReportMessage, buildFullReportBuffer, reportFileName } = require("../lib/deliveryFullReport");

  console.log("\n=== 1) تقرير فاضي ===");
  let data = buildFullReport();
  check("1: الإجمالي صفر والرسالة بتوضّح إن مفيش طلبات", data.total === 0 && formatFullReportMessage(data).includes("لا توجد طلبات"));

  console.log("\n=== 2) طلبات متنوعة (تجريبي + 3 مناطق + حالات مختلفة) ===");
  const mk = (name, regionKey, phone) => store.createRequest({ phone, name, regionKey, preferredDateTime: "الأحد 10 ص", latitude: 26.6, longitude: 37.9 });
  mk("مزارع تجريبي", "NORTH", "966500000001"); // D-1: مستبعد بالاسم
  const a = mk("أحمد", "NORTH", "966501111111"); // D-2
  const b = mk("خالد", "NORTH", "966502222222"); // D-3
  const c = mk("سعد", "CENTER", "966503333333"); // D-4
  const d = mk("منى", "SOUTH", "966504444444"); // D-5
  const e = mk("ليلى", "SOUTH", "966505555555"); // D-6: هتتستبعد بالأمر
  store.markDelivered(a.id);
  store.markFailed(b.id, "لا يرد على الجوال");
  // طلب قديم (5 أيام) = متأخر
  const state = JSON.parse(fs.readFileSync(store.STORE_FILE, "utf8"));
  state.requests.find((r) => r.id === c.id).createdAt = new Date(Date.now() - 5 * 86400000).toISOString();
  fs.writeFileSync(store.STORE_FILE, JSON.stringify(state));
  check("2: excludeFromReports بيرجّع true أول مرة و false بعد كده", store.excludeFromReports(e.id) === true && store.excludeFromReports(e.id) === false);

  data = buildFullReport();
  check("2ب: الإجمالي 4 (استبعاد التجريبي بالاسم والمستبعد بالأمر)", data.total === 4);
  check("2ج: تم 1 / قيد 2 / تعذّر 1 ونسبة 25%", data.done === 1 && data.open === 2 && data.failed === 1 && data.percent === 25);
  check("2د: المتأخر طلب سعد بس (5 أيام)", data.late === 1 && data.rows.find((r) => r.late).name === "سعد");
  const north = data.regions.find((r) => r.key === "NORTH");
  check("2هـ: الشمال تم 1 تعذّر 1 قيد 0", north.done === 1 && north.failed === 1 && north.open === 0);

  console.log("\n=== 3) الرسالة القصيرة ===");
  const text = formatFullReportMessage(data);
  check("3: فيها الملخص والمناطق", text.includes("إجمالي طلبات التوصيل: 4") && text.includes("نسبة الإنجاز: 25%") && text.includes("الشمال: ✅ 1 | ⏳ 0 | ❌ 1"));
  check("3ب: تنبيه المتأخر ظاهر", text.includes("⚠️ تنبيه: 1 طلبات مفتوحة منذ أكثر من 3 أيام"));
  check("3ج: مفيش أسماء مزارعين في الرسالة", !text.includes("أحمد") && !text.includes("خالد"));

  console.log("\n=== 4) ملف Excel ===");
  const buffer = await buildFullReportBuffer(data);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  check("4: الأوراق الخمسة بالترتيب", wb.worksheets.map((w) => w.name).join("|") === "الملخص|كل الطلبات|الشمال|الوسط|الجنوب");
  const sum = wb.getWorksheet("الملخص");
  check("4ب: بطاقات الأرقام (4 / 1 / 2 / 1)", sum.getCell("A5").value === 4 && sum.getCell("C5").value === 1 && sum.getCell("E5").value === 2 && sum.getCell("G5").value === 1);
  check("4ج: صف إجمالي المناطق قيم ثابتة مش صيغ", sum.getCell("B16").value === 4 && typeof sum.getCell("B16").value === "number");
  check("4د: نسبة الإنجاز 25%", Math.abs(sum.getCell("H19").value - 0.25) < 1e-9);
  check("4هـ: قائمة المتأخرين فيها سعد", sum.getCell("A22").value.includes("(1)") && sum.getCell("B24").value === "سعد");
  const all = wb.getWorksheet("كل الطلبات");
  check("4و: كل الطلبات 4 صفوف + العنوان", all.rowCount === 5);
  check("4ز: الترتيب قيد التوصيل أولًا وتم آخرًا", all.getCell("E2").value === "قيد التوصيل" && all.getCell("E5").value === "تم التوصيل");
  check("4ح: سبب التعذّر ظاهر", all.getCell("J4").value === "لا يرد على الجوال" || all.getCell("J3").value === "لا يرد على الجوال");
  check("4ط: ورقة الجنوب فيها طلب واحد (منى)", wb.getWorksheet("الجنوب").rowCount === 2);
  check("4ي: اسم الملف فيه التاريخ", /^تفاصيل توصيل البطاقات - \d{4}-\d{2}-\d{2}\.xlsx$/.test(reportFileName()));

  console.log("\n=== 5) رقم الطلب من المنصة ===");
  const state2 = JSON.parse(fs.readFileSync(store.STORE_FILE, "utf8"));
  state2.requests.find((r) => r.id === d.id).platformRequestNumber = "30412";
  fs.writeFileSync(store.STORE_FILE, JSON.stringify(state2));
  data = buildFullReport();
  check("5: رقم المنصة بيظهر بدل D-n، والباقي D-n", data.rows.find((r) => r.id === d.id).number === "30412" && data.rows.find((r) => r.id === b.id).number === b.id);

  console.log(`\n🎉 كل اختبارات التقرير الكامل نجحت (${passed} اختبار). صفر رسائل واتساب حقيقية.`);
}

run()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => { restore(snap); console.log("♻️ تم استرجاع ملفات البيانات الحقيقية."); });
