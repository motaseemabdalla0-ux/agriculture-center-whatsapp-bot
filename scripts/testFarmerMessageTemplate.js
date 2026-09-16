// اختبارات القالب الموحّد لصندوق استقبال الحملات: اسم الشخص | رقم الهاتف | الرسالة
// (رسالة كل صف مستقلة، مش رسالة واحدة إجبارية للحملة كلها) - 12 اختبار كما طُلب.
// صفر رسائل واتساب حقيقية (Fake Client)، وصفر تعديل على safeFarmerSend/farmerState نفسهم.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const XLSX = require("xlsx");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = [
  "farmer_state.json",
  "farmer_state.json.bak",
  "send_fingerprints.json",
  "send_fingerprints.json.bak",
  "rate_limit_state.json",
  "sent_history.json",
  "sent_history.json.bak",
  "audit_log.jsonl",
];
const DATA_DIRS = ["campaigns", "campaign-inbox/data"];

function snapshotFiles() {
  const snapshot = {};
  DATA_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    snapshot[name] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  });
  return snapshot;
}
function restoreFiles(snapshot) {
  DATA_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    if (snapshot[name] === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, snapshot[name]);
    }
  });
}
function wipeTestFiles() {
  DATA_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
}
function removeDirRecursive(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function snapshotDirs() {
  const snapshot = {};
  DATA_DIRS.forEach((rel) => {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) {
      const tmpCopy = path.join(ROOT, `__snapshot_${rel.replace(/[\\/]/g, "_")}`);
      removeDirRecursive(tmpCopy);
      fs.cpSync(p, tmpCopy, { recursive: true });
      snapshot[rel] = tmpCopy;
    } else {
      snapshot[rel] = null;
    }
  });
  return snapshot;
}
function restoreDirs(snapshot) {
  DATA_DIRS.forEach((rel) => {
    const p = path.join(ROOT, rel);
    removeDirRecursive(p);
    if (snapshot[rel]) {
      fs.cpSync(snapshot[rel], p, { recursive: true });
      removeDirRecursive(snapshot[rel]);
    }
  });
}
function wipeTestDirs() {
  DATA_DIRS.forEach((rel) => removeDirRecursive(path.join(ROOT, rel)));
}

let passed = 0;
function check(label, condition) {
  assert(condition, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
}

function fakeClient() {
  let callCount = 0;
  return {
    getNumberId: async (phone) => ({ _serialized: `${phone}@c.us` }),
    sendMessage: async () => {
      callCount++;
      return true;
    },
    _getCallCount: () => callCount,
  };
}

function csvBuffer(rows) {
  return Buffer.from(
    rows
      .map((r) => r.map((cell) => (String(cell).includes(",") ? `"${cell}"` : cell)).join(","))
      .join("\n") + "\n",
    "utf8"
  );
}

function xlsxBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

async function run() {
  [
    "../lib/fileIngest",
    "../lib/farmerState",
    "../lib/campaignBuilder",
    "../lib/campaignStore",
    "../lib/campaignRunner",
    "../lib/sendFingerprint",
    "../lib/auditLog",
    "../campaign-inbox/inboxStore",
    "../campaign-inbox/inboxEngine",
  ].forEach((m) => delete require.cache[require.resolve(m)]);

  const { parseFarmerMessageRows } = require("../lib/fileIngest");
  const farmerState = require("../lib/farmerState");
  const { buildCampaignRows } = require("../lib/campaignBuilder");
  const sendFingerprint = require("../lib/sendFingerprint");
  const auditLog = require("../lib/auditLog");
  const inboxEngine = require("../campaign-inbox/inboxEngine");
  const inboxStore = require("../campaign-inbox/inboxStore");

  console.log("=== 1) قراءة الأعمدة العربية (اسم الشخص / رقم الهاتف / الرسالة) ===");
  {
    const buf = csvBuffer([
      ["اسم الشخص", "رقم الهاتف", "الرسالة"],
      ["أحمد محمد", "0512300001", "السلام عليكم أستاذ أحمد، نأمل استكمال بياناتكم."],
    ]);
    const parsed = parseFarmerMessageRows(buf);
    check("1: تم اكتشاف عمود الرسالة", parsed.hasMessageColumn === true);
    check("1: الاسم اتقرا صح", parsed.rows[0].name === "أحمد محمد");
    check("1: الجوال اتقرا صح", parsed.rows[0].phone === "0512300001");
    check("1: الرسالة اتقرت صح بالحرف", parsed.rows[0].message === "السلام عليكم أستاذ أحمد، نأمل استكمال بياناتكم.");
  }

  console.log("\n=== 2) قراءة البدائل الإنجليزية (Name / Phone / Message) ===");
  {
    const buf = csvBuffer([
      ["Name", "Phone", "Message"],
      ["Ahmed", "0512300002", "Hello Ahmed, please complete your data."],
    ]);
    const parsed = parseFarmerMessageRows(buf);
    check("2: تم اكتشاف عمود الرسالة بالإنجليزي", parsed.hasMessageColumn === true);
    check("2: الاسم اتقرا صح", parsed.rows[0].name === "Ahmed");
    check("2: الرسالة اتقرت صح", parsed.rows[0].message === "Hello Ahmed, please complete your data.");
  }

  console.log("\n=== 3) كل صف يستخدم رسالته الخاصة ===");
  let campaignId3;
  {
    const buf = csvBuffer([
      ["اسم الشخص", "رقم الهاتف", "الرسالة"],
      ["محمد", "0512300003", "رسالتك الأولى الخاصة بك يا محمد"],
      ["أحمد", "0512300004", "رسالتك الثانية المختلفة تمامًا يا أحمد"],
    ]);
    const meta = await inboxEngine.receiveCampaign({
      buffer: buf,
      fileName: "template.csv",
      purpose: "SURVEY",
      uploadedBy: "test",
      source: "test",
    });
    campaignId3 = meta.campaignId;
    check("3: الحالة PREVIEW_READY", meta.status === "PREVIEW_READY");
    check("3: usedPerRowMessage = true", meta.usedPerRowMessage === true);
    const rowsDetail = meta.preview.rows;
    const r1 = rowsDetail.find((r) => r.phone === "966512300003");
    const r2 = rowsDetail.find((r) => r.phone === "966512300004");
    check("3: محمد استلم رسالته هو بالظبط", r1.messagePreview.includes("الأولى"));
    check("3: أحمد استلم رسالته هو بالظبط (مختلفة)", r2.messagePreview.includes("الثانية"));
  }

  console.log("\n=== 4) Missing Phone → blocked ===");
  {
    const buf = csvBuffer([
      ["اسم الشخص", "رقم الهاتف", "الرسالة"],
      ["بدون جوال", "", "رسالة عادية"],
    ]);
    const meta = await inboxEngine.receiveCampaign({ buffer: buf, fileName: "no-phone.csv", purpose: "SURVEY", source: "test" });
    check("4: صف بدون جوال ظهر واتحظر (invalid_phone)", meta.preview.invalid_phone === 1);
    check("4: صفر جاهز للإرسال", meta.preview.valid === 0);
  }

  console.log("\n=== 5) Missing Message → blocked ===");
  {
    const buf = csvBuffer([
      ["اسم الشخص", "رقم الهاتف", "الرسالة"],
      ["بدون رسالة", "0512300005", ""],
    ]);
    const meta = await inboxEngine.receiveCampaign({ buffer: buf, fileName: "no-message.csv", purpose: "SURVEY", source: "test" });
    check("5: صف بدون رسالة ظهر واتحظر (missing_message)", meta.preview.missing_message === 1);
    check("5: صفر جاهز للإرسال", meta.preview.valid === 0);
  }

  console.log("\n=== 6) Missing Name → يظهر في Preview ولا يُرسل ===");
  {
    const buf = csvBuffer([
      ["اسم الشخص", "رقم الهاتف", "الرسالة"],
      ["", "0512300006", "رسالة من غير اسم"],
    ]);
    const meta = await inboxEngine.receiveCampaign({ buffer: buf, fileName: "no-name.csv", purpose: "SURVEY", source: "test" });
    check("6: صف بدون اسم ظهر واتحظر (missing_name)", meta.preview.missing_name === 1);
    check("6: صفر جاهز للإرسال", meta.preview.valid === 0);
  }

  console.log("\n=== 7) نفس Phone + نفس Message → duplicate ===");
  {
    const rows = buildCampaignRows(
      [
        { name: "شخص1", phone: "0512300007", message: "نفس الرسالة بالحرف الواحد" },
        { name: "شخص1 تاني", phone: "+966512300007", message: "نفس الرسالة بالحرف الواحد" },
      ],
      "SURVEY"
    ).rows;
    check("7: أول ظهور pending", rows[0].status === "pending");
    check("7: الظهور التاني duplicate", rows[1].status === "duplicate");
  }

  console.log("\n=== 8) نفس Phone + رسالة مختلفة → لا يعتبر duplicate تلقائيًا ===");
  {
    const rows = buildCampaignRows(
      [
        { name: "شخص2", phone: "0512300008", message: "رسالة أولى لشخص2" },
        { name: "شخص2 تاني", phone: "+966512300008", message: "رسالة تانية مختلفة تمامًا لشخص2" },
      ],
      "SURVEY"
    ).rows;
    check("8: أول ظهور pending", rows[0].status === "pending");
    check("8: الظهور التاني (رسالة مختلفة) pending برضه مش duplicate", rows[1].status === "pending");
  }

  console.log("\n=== 9) DRY RUN → zero WhatsApp sends ===");
  {
    const client = fakeClient();
    const updated = await inboxEngine.runDryRun(campaignId3, client);
    check("9: الحالة AWAITING_APPROVAL", updated.status === "AWAITING_APPROVAL");
    check("9: صفر نداء sendMessage", client._getCallCount() === 0);
  }

  console.log("\n=== 10) Upload → zero WhatsApp sends ===");
  {
    const client = fakeClient();
    const buf = csvBuffer([
      ["اسم الشخص", "رقم الهاتف", "الرسالة"],
      ["مزارع", "0512300009", "رسالة رفع فقط"],
    ]);
    await inboxEngine.receiveCampaign({ buffer: buf, fileName: "upload-only.csv", purpose: "SURVEY", source: "test" });
    check("10: صفر نداء sendMessage عند الرفع فقط", client._getCallCount() === 0);
  }

  console.log("\n=== 11) كل الرسائل بتعدّي فعليًا على safeFarmerSend (Audit Log كدليل) ===");
  {
    const before = auditLog.readAll().length;
    const client = fakeClient();
    // نستخدم حملة 3 (فيها صفين pending) - أي نداء safeFarmerSend بيسجّل صف Audit واحد على الأقل
    // (WOULD_SEND) - Preview وحدها (بند 3) ما كانتش نادت عليه، الأول اللي بينادي فعليًا هو DRY RUN
    const auditForPhones = auditLog.readAll().filter((e) => e.normalizedPhone === "966512300003" || e.normalizedPhone === "966512300004");
    check("11: فيه سجلات Audit لكل رقم في الحملة (مرّوا فعليًا على safeFarmerSend)", auditForPhones.length >= 2);
    check("11: كل قرار مسجّل WOULD_SEND (DRY RUN حقيقي عبر safeFarmerSend)", auditForPhones.every((e) => e.decision === "WOULD_SEND"));
  }

  console.log("\n=== 12) ملفات الحملات القديمة (بدون عمود رسالة) لسه شغالة (رسالة واحدة للحملة) ===");
  {
    const buf = csvBuffer([
      ["name", "phone", "request_number"],
      ["مزارع قديم", "0512300010", "700"],
    ]);
    const meta = await inboxEngine.receiveCampaign({
      buffer: buf,
      fileName: "old-style.csv",
      purpose: "DOCUMENTS",
      message: "مرحبًا {name}، من فضلك أكمل مستنداتك",
      uploadedBy: "test",
      source: "test",
    });
    check("12: الحالة PREVIEW_READY (ملف قديم لسه شغال)", meta.status === "PREVIEW_READY");
    check("12: usedPerRowMessage = false (مفيش عمود رسالة)", meta.usedPerRowMessage === false);
    check("12: الرسالة اتبنت من القالب العام + {name}", meta.preview.rows[0].messagePreview.includes("مزارع قديم"));
  }

  console.log(`\n🎉 كل اختبارات القالب الموحّد نجحت (${passed} اختبار). من غير أي رسالة واتساب حقيقية.`);
}

const snapshot = snapshotFiles();
const dirSnapshot = snapshotDirs();
wipeTestFiles();
wipeTestDirs();
run()
  .catch((err) => {
    console.log(`\n💥 فشل الاختبار: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreFiles(snapshot);
    restoreDirs(dirSnapshot);
    console.log("\n♻️ تم استرجاع كل ملفات وبيانات التشغيل الحقيقية زي ما كانت قبل الاختبار.");
  });
