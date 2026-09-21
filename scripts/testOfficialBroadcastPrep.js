// اختبارات تجهيز Broadcast الرسمي - محلي فقط، مجلد مؤقت، صفر واتساب، صفر تعديل على أي Store تشغيلي.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");
const XLSX = require("xlsx");
const { prepareBroadcast, analyze } = require("../lib/officialBroadcastPrep");

const ROOT = path.join(__dirname, "..");
const OPERATIONAL = [
  "farmer_state.json",
  "farmer_registry.json",
  "sent_history.json",
  "send_fingerprints.json",
  "rate_limit_state.json",
  "send_log.json",
  "audit_log.jsonl",
];
const hashAll = () =>
  OPERATIONAL.map((f) => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "absent";
  }).join("|");
const campaignsBefore = fs.existsSync(path.join(ROOT, "campaigns")) ? fs.readdirSync(path.join(ROOT, "campaigns")).sort().join(",") : "";

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

function xlsxBuffer(rows, header = ["الاسم", "رقم الجوال", "الرسالة"]) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "S");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
const phoneN = (i) => `05${String(10000000 + i).slice(-8)}`; // 05xxxxxxxx صحيح
const farmers = (n, from = 0) => Array.from({ length: n }, (_, i) => [`مزارع ${["أ", "ب", "ج"][i % 3]} ${i + from}`.replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]), phoneN(i + from), "رسالة تجربة"]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bprep-"));
const before = hashAll();

// 1) 3 contacts
{
  const out = tmp();
  const r = prepareBroadcast(xlsxBuffer(farmers(3)), { outDir: out });
  check("3 contacts -> قائمة واحدة", r.lists.length === 1 && r.lists[0].count === 3 && r.lists[0].broadcastId === "Broadcast_001");
  check("Ready = 3", r.preview.ready === 3 && r.preview.total === 3);
}
// 2) 256
{
  const out = tmp();
  const r = prepareBroadcast(xlsxBuffer(farmers(256)), { outDir: out });
  check("256 contacts -> قائمة واحدة ممتلئة", r.lists.length === 1 && r.lists[0].count === 256);
}
// 3) 257 -> 2 lists
{
  const out = tmp();
  const r = prepareBroadcast(xlsxBuffer(farmers(257)), { outDir: out });
  check("257 contacts -> قائمتين (256 + 1)", r.lists.length === 2 && r.lists[0].count === 256 && r.lists[1].count === 1);
  check("أسماء الملفات broadcast_001/002", fs.existsSync(path.join(out, "broadcast_001.xlsx")) && fs.existsSync(path.join(out, "broadcast_002.xlsx")));
  check("ممنوع maxPerList أكبر من 256", (() => { try { prepareBroadcast(xlsxBuffer(farmers(3)), { outDir: out, maxPerList: 300 }); return false; } catch { return true; } })());
}
// 4) duplicates + invalid + missing name + aliases + Arabic
{
  const rows = [
    ["سعيد الحربي", "0501234567", "م1"],
    ["سعيد الحربي (مكرر)", "+966501234567", "م1"], // نفس الرقم بصيغة تانية
    ["خالد", "12345", "م"], // رقم غلط
    ["", "0509999999", "م"], // من غير اسم
    ["Mohammed Ali", "0508888888", "م"], // اسم إنجليزي: بيتحفظ زي ما هو
    ["فهد", "٠٥٠٧٧٧٧٧٧٧", "م"], // أرقام عربية
  ];
  const { ready, preview } = analyze(xlsxBuffer(rows, ["Name", "Mobile", "Message"])); // aliases إنجليزي
  check("aliases إنجليزية اتقرت (Name/Mobile/Message)", preview.total === 6);
  check("Invalid phones = 1", preview.invalidPhones === 1);
  check("Duplicates = 1 (نفس الرقم بصيغتين)", preview.duplicates === 1);
  check("Missing names = 1", preview.missingNames === 1);
  check("Ready = 3", preview.ready === 3 && ready.length === 3);
  check("الاسم العربي محفوظ حرفيًا", ready[0].name === "سعيد الحربي");
  check("الرقم متوحّد للصيغة الدولية 9665...", ready.every((c) => /^9665\d{8}$/.test(c.phone)));
  check("الأرقام العربية اتحوّلت", ready.some((c) => c.phone === "966507777777"));
  check("الاسم الإنجليزي محفوظ ومحسوب غير عربي", ready.some((c) => c.name === "Mohammed Ali") && preview.arabicNames === 2);
}
// 5) Excel/vcf/manifest output
{
  const out = tmp();
  const r = prepareBroadcast(xlsxBuffer(farmers(4)), { outDir: out, sourceCampaignId: "c1789640068672" });
  const wb = XLSX.readFile(path.join(out, "broadcast_001.xlsx"));
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets.Broadcast, { header: 1, raw: false });
  check("الأعمدة Name/Phone/Message/BroadcastId", aoa[0].join(",") === "Name,Phone,Message,BroadcastId");
  check("4 صفوف بيانات + رقم دولي بـ+ كنص", aoa.length === 5 && /^\+9665\d{8}$/.test(aoa[1][1]) && aoa[1][3] === "Broadcast_001");
  const vcf = fs.readFileSync(path.join(out, "broadcast_001.vcf"), "utf8");
  check("vCard: 4 جهات وTEL دولي", (vcf.match(/BEGIN:VCARD/g) || []).length === 4 && /TEL;TYPE=CELL:\+9665\d{8}/.test(vcf));
  const m = JSON.parse(fs.readFileSync(r.manifestPath, "utf8"));
  check("manifest يربط name/phone/message/broadcastId/sourceCampaignId", m.lists[0].contacts[0].broadcastId === "Broadcast_001" && m.sourceCampaignId === "c1789640068672" && m.lists[0].contacts[0].sourceCampaignId === "c1789640068672" && !!m.lists[0].contacts[0].message);
}
// 6) Pilot 3 من قاعدة أكبر
{
  const out = tmp();
  const r = prepareBroadcast(xlsxBuffer(farmers(500)), { outDir: out, pilot: 3 });
  check("Pilot: قائمة واحدة بـ3 فقط رغم 500 صف", r.lists.length === 1 && r.lists[0].count === 3 && r.lists[0].broadcastId === "Broadcast_TEST_001");
  check("Pilot: broadcast_test_001.xlsx موجود ومفيش broadcast_001", fs.existsSync(path.join(out, "broadcast_test_001.xlsx")) && !fs.existsSync(path.join(out, "broadcast_001.xlsx")));
}
// 7) صفر إرسال / صفر تغيير حالة
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "officialBroadcastPrep.js"), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check("الكود مفيهوش sendMessage", !/sendMessage/.test(code));
  check("الكود مفيهوش require لأي Store/Client تشغيلي", !/require\([^)]*(safeFarmerSend|farmerState|farmerRegistry|sendFingerprint|sentTracker|rateLimiter|campaignStore|whatsapp-web|sendLog)/.test(code));
  check("صفر تغيير في Farmer State/Registry/SENT history/Fingerprints/Rate limiter", hashAll() === before);
  const after = fs.existsSync(path.join(ROOT, "campaigns")) ? fs.readdirSync(path.join(ROOT, "campaigns")).sort().join(",") : "";
  check("ملفات الحملات (c1789640068672 وغيرها) ما اتلمستش", after === campaignsBefore);
}

console.log(`\n🎉 كل اختبارات تجهيز Broadcast الرسمي نجحت (${passed} اختبار). صفر رسائل واتساب.`);
