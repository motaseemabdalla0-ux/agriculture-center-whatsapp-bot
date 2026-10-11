// اختبارات التقرير الكامل لطلبات التوصيل (رسالة + Excel). صفر واتساب حقيقي، وبيرجّع ملف
// البيانات الحقيقي زي ما كان بعد الاختبار
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = ["delivery_state.json", "delivery_state.json.bak", "farmer_state.json", "farmer_state.json.bak", "portal_delivered_snapshot.json"];
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
  state.requests.find((r) => r.id === a.id).failureReason = "لا يرد على الجوال"; // اتسلّم بعد تعذّر سابق
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

  console.log("\n=== 3د) قائمة التجهيز للموظف ===");
  const { formatPrepList } = require("../lib/deliveryFullReport");
  const prep = formatPrepList(data);
  check("3د: فيها المفتوحين بس (سعد ومنى) ببياناتهم", prep.includes("سعد") && prep.includes("منى") && prep.includes("966503333333") && prep.includes("إجمالي البطاقات المطلوب تجهيزها: 2"));
  check("3هـ: مفيش المسلَّم ولا المتعذّر ولا التجريبي", !prep.includes("أحمد") && !prep.includes("خالد") && !prep.includes("تجريبي"));
  check("3و: المتأخر عليه علامة تنبيه", /سعد ⚠️/.test(prep));
  check("3ز: لو مفيش مفتوح -> رسالة واضحة", formatPrepList({ ...data, rows: [] }).includes("لا توجد بطاقات مطلوب تجهيزها"));

  check("3ح: صيغة الأيام بالعربي (منذ 5 أيام)", prep.includes("منذ 5 أيام"));
  const { buildPrepBuffer, prepFileName } = require("../lib/deliveryFullReport");
  const pwb = new ExcelJS.Workbook();
  await pwb.xlsx.load(await buildPrepBuffer(data));
  check("3ط: أوراق التجهيز (كل البطاقات + 3 مناطق)", pwb.worksheets.map((w) => w.name).join("|") === "كل البطاقات|الشمال|الوسط|الجنوب|تم التوصيل|سجل التسليم (المنصة)");
  check("3ي: فيها المفتوحين بس (2 + العنوان) وعمود تم التجهيز فاضي", pwb.getWorksheet("كل البطاقات").rowCount === 3 && pwb.getWorksheet("كل البطاقات").getCell("J1").value === "تم التجهيز");
  check("3ك: ورقة الجنوب فيها منى بس", pwb.getWorksheet("الجنوب").rowCount === 2 && pwb.getWorksheet("الجنوب").getCell("B2").value === "منى");
  check("3ل: اسم ملف التجهيز فيه التاريخ", /^البطاقات المطلوب تجهيزها - \d{4}-\d{2}-\d{2}\.xlsx$/.test(prepFileName()));

  console.log("\n=== 4) ملف Excel ===");
  const buffer = await buildFullReportBuffer(data);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  check("4: الأوراق الخمسة بالترتيب", wb.worksheets.map((w) => w.name).join("|") === "الملخص|كل الطلبات|الشمال|الوسط|الجنوب|تم التوصيل|سجل التسليم (المنصة)");
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

  const dsh = wb.getWorksheet("تم التوصيل");
  check("4م: ورقة تم التوصيل فيها أحمد وسبب التعذّر السابق", dsh.rowCount === 2 && dsh.getCell("B2").value === "أحمد" && dsh.getCell("F2").value === "لا يرد على الجوال");
  let delivRow = 0;
  sum.eachRow((row, n) => { if (String(row.getCell(1).value || "").includes("البطاقات التي تم توصيلها (1)")) delivRow = n; });
  check("4ن: كرت المسلَّمة في الملخص (عدد 1 + أحمد + السبب)", delivRow > 0 && sum.getCell(delivRow + 2, 2).value === "أحمد" && sum.getCell(delivRow + 2, 6).value === "لا يرد على الجوال");
  const pwb2 = new ExcelJS.Workbook();
  await pwb2.xlsx.load(await buildPrepBuffer(data));
  check("4س: ملف التجهيز فيه ورقة تم التوصيل بنفس البيانات", pwb2.getWorksheet("تم التوصيل").getCell("B2").value === "أحمد" && formatPrepList(data).includes("تم توصيل: 1 بطاقة"));

  console.log("\n=== 4ع) سجل التسليم الكامل من المنصة (البيانات القديمة) ===");
  const { saveDeliveredSnapshot } = require("../lib/portalDeliveryCheck");
  saveDeliveredSnapshot([
    { name: "أحمد", phone: "966501111111", nationalId: "1000000001", formNumber: "30001" }, // مرتبط بطلب أحمد
    { name: "قديم بدون طلب", phone: "966599999999", nationalId: "1000000002", formNumber: "29000" }, // مالوش طلب توصيل
  ]);
  const hdata = buildFullReport();
  check("4ع: لقطة المنصة اتحمّلت (2) وأحمد مرتبط بطلبه والقديم لأ", hdata.portalHistory.rows.length === 2 && hdata.portalHistory.rows[0].requestId === a.id && hdata.portalHistory.rows[1].requestId === "");
  const hwb = new ExcelJS.Workbook();
  await hwb.xlsx.load(await buildFullReportBuffer(hdata));
  const hs = hwb.getWorksheet("سجل التسليم (المنصة)");
  check("4ف: ورقة السجل: الاتنين + العنوان + رأس الجدول", hs.rowCount === 4 && hs.getCell("B4").value === "قديم بدون طلب" && hs.getCell("E4").value === "—");
  check("4ق: بدون لقطة -> الورقة موجودة بملاحظة 'لسه ما اتقرا'", (() => { require("fs").unlinkSync(require("../lib/portalDeliveryCheck").SNAPSHOT_FILE); return buildFullReport().portalHistory.rows.length === 0; })());

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
