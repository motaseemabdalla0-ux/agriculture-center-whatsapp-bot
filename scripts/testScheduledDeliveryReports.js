// فحص كشف "البطاقات اللي تم توصيلها" + مخزن المستقبلين المجدولين (من غير واتساب ومن غير لمس ملفات التشغيل)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const r = require("../lib/deliveryFullReport");

const now = new Date("2026-10-21T08:00:00Z");
const row = (i, status, region, key) => ({ id: `D-${i}`, number: 1000 + i, name: `مزارع ${i}`, phone: `96650000000${i}`, regionKey: key, region, status, finished: "20/10/2026", finishedAt: `2026-10-20T0${i}:00:00Z`, reason: "" });
const data = {
  now,
  rows: [row(1, "DELIVERED", "الشمال", "NORTH"), row(2, "DELIVERED", "الجنوب", "SOUTH"), row(3, "NEW", "الوسط", "CENTER")],
  regions: [{ key: "NORTH", ar: "الشمال", done: 1 }, { key: "CENTER", ar: "الوسط", done: 0 }, { key: "SOUTH", ar: "الجنوب", done: 1 }],
  portalHistory: { fetchedAt: now.toISOString(), rows: [{ formNumber: "A1", name: "س", phone: "966500000001", nationalId: "1", requestId: "D-1", region: "الشمال" }] },
  total: 3, done: 2, open: 1, failed: 0, late: 0, percent: 67,
};
const msg = r.formatDeliveredReport(data);
assert.ok(/تم توصيلها عبر طلبات التوصيل: 2/.test(msg), "عدد الموصَّلة");
assert.ok(/الشمال: 1/.test(msg) && /الجنوب: 1/.test(msg), "حسب المنطقة");
assert.ok(/مزارع 1/.test(msg) && /مزارع 2/.test(msg) && !/مزارع 3/.test(msg), "فيه الموصَّل فقط");
(async () => {
  const buf = await r.buildDeliveredBuffer(data);
  assert.ok(buf.length > 2000, "ملف Excel اتبنى");
  const tmp = path.join(os.tmpdir(), "delivered-test.xlsx");
  fs.writeFileSync(tmp, buf);
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(tmp);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ["تم التوصيل", "سجل التسليم (المنصة)"]);
  assert.strictEqual(wb.getWorksheet("تم التوصيل").rowCount, 3); // العنوان + بطاقتين
  fs.unlinkSync(tmp);
  assert.ok(/كشف البطاقات التي تم توصيلها - 2026-10-21/.test(r.deliveredFileName(now)));

  // مخزن المستقبلين (على ملف مؤقت: بنحفظ ونسترجع ملف التشغيل الحقيقي)
  const store = require("../lib/deliveryStore");
  const real = path.join(__dirname, "..", "delivery_state.json");
  const realBak = `${real}.bak`;
  const backup = fs.existsSync(real) ? fs.readFileSync(real) : null;
  const backupBak = fs.existsSync(realBak) ? fs.readFileSync(realBak) : null;
  // نبدأ من حالة نضيفة (الملف الاحتياطي .bak بيتكوّن تلقائيًا من الكتابة الذرّية وكان بيلوّث التشغيل التالي)
  [real, realBak].forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  try {
    assert.strictEqual(store.addScheduleRecipient("966501797538"), true);
    assert.strictEqual(store.addScheduleRecipient("966501797538"), false);
    assert.deepStrictEqual(store.getScheduleRecipients().includes("966501797538"), true);
    assert.strictEqual(store.wasScheduleSent("2026-10-21:am:966501797538"), false);
    store.markScheduleSent("2026-10-21:am:966501797538");
    assert.strictEqual(store.wasScheduleSent("2026-10-21:am:966501797538"), true);
    assert.strictEqual(store.wasScheduleSent("2026-10-21:pm:966501797538"), false);
    assert.strictEqual(store.removeScheduleRecipient("966501797538"), true);
  } finally {
    [[real, backup], [realBak, backupBak]].forEach(([f, b]) => {
      if (b === null) { if (fs.existsSync(f)) fs.unlinkSync(f); } else fs.writeFileSync(f, b);
    });
  }
  console.log("✅ كل الفحوصات نجحت");
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
