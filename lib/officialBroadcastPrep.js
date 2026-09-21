const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { parseFarmerMessageRows } = require("./fileIngest");
const { normalizeSaudiPhone, isValidSaudiPhone } = require("./phoneUtil");
const { isArabicName } = require("./arabicNameGuard");

// WhatsApp Official Broadcast Preparation - تجهيز ملفات فقط، صفر إرسال.
// الوحدة دي عمدًا مش بتعمل require لـsafeFarmerSend/farmerState/farmerRegistry/sendFingerprint/
// sentTracker/rateLimiter ولا لأي WhatsApp client - مفيش أي طريق كود منها لإرسال أو تغيير حالة.
//
// متطلبات واتساب الرسمية (مراجعة Help Center، سبتمبر 2026): قائمة Broadcast في WhatsApp Business
// حدها 256 جهة اتصال، والمستلمين بيتختاروا من جهات الاتصال المحفوظة في دفتر عناوين التليفون،
// والرسالة بتوصل بس لمن حفظ رقم الأعمال عنده. مفيش استيراد Excel/CSV موثّق داخل التطبيق نفسه.
// عشان كده ملف الـExcel هنا "ورقة عمل" للمراجعة، وبنطلّع كمان ملف vCard (.vcf - معيار قياسي RFC 6350/2426
// مش صيغة واتساب) لاستيراد الأسماء لدفتر عناوين التليفون يدويًا، ومن هناك بتتختار في القائمة.
const MAX_PER_LIST = 256;

function pad(n) {
  return String(n).padStart(3, "0");
}

function vcardEscape(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function toVcard(contacts) {
  return (
    contacts
      .map(
        (c) =>
          `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${vcardEscape(c.name)}\r\nN:${vcardEscape(c.name)};;;;\r\nTEL;TYPE=CELL:+${c.phone}\r\nEND:VCARD`
      )
      .join("\r\n") + "\r\n"
  );
}

function writeListXlsx(filePath, broadcastId, contacts) {
  const aoa = [["Name", "Phone", "Message", "BroadcastId"]];
  contacts.forEach((c) => aoa.push([c.name, `+${c.phone}`, c.message, broadcastId]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Broadcast");
  XLSX.writeFile(wb, filePath);
}

// بيحلل الملف ويطبّع ويتحقق ويرجّع {rows, preview} - من غير أي كتابة على القرص
function analyze(buffer) {
  const { rows: rawRows } = parseFarmerMessageRows(buffer);
  const preview = { total: rawRows.length, valid: 0, invalidPhones: 0, duplicates: 0, missingNames: 0, missingMessages: 0, arabicNames: 0, ready: 0 };
  const seen = new Set();
  const ready = [];

  rawRows.forEach((r) => {
    const name = (r.name || "").trim();
    const phone = normalizeSaudiPhone(r.phone);
    if (!isValidSaudiPhone(phone)) {
      preview.invalidPhones++;
      return;
    }
    preview.valid++;
    if (!name) {
      preview.missingNames++;
      return;
    }
    if (seen.has(phone)) {
      preview.duplicates++;
      return;
    }
    seen.add(phone);
    if (!r.message) preview.missingMessages++;
    if (isArabicName(name)) preview.arabicNames++;
    ready.push({ name, phone, message: r.message || "" });
  });

  preview.ready = ready.length;
  return { ready, preview };
}

// options: { outDir, sourceCampaignId, maxPerList = 256, pilot = 0, now }
// pilot > 0: ملف واحد فقط broadcast_test_001 بأول N جهة اتصال (مش تقسيم كامل القاعدة)
function prepareBroadcast(buffer, options = {}) {
  const { outDir, sourceCampaignId = null, maxPerList = MAX_PER_LIST, pilot = 0, now = new Date() } = options;
  if (!outDir) throw new Error("outDir مطلوب");
  if (maxPerList > MAX_PER_LIST) throw new Error(`الحد الأقصى الرسمي لقائمة Broadcast هو ${MAX_PER_LIST}`);

  const { ready, preview } = analyze(buffer);
  fs.mkdirSync(outDir, { recursive: true });
  const preparedAt = now.toISOString();

  const groups = pilot > 0 ? [ready.slice(0, pilot)] : [];
  if (pilot <= 0) for (let i = 0; i < ready.length; i += maxPerList) groups.push(ready.slice(i, i + maxPerList));

  const lists = groups.map((contacts, i) => {
    const broadcastId = pilot > 0 ? "Broadcast_TEST_001" : `Broadcast_${pad(i + 1)}`;
    const base = pilot > 0 ? "broadcast_test_001" : `broadcast_${pad(i + 1)}`;
    const xlsxPath = path.join(outDir, `${base}.xlsx`);
    const vcfPath = path.join(outDir, `${base}.vcf`);
    writeListXlsx(xlsxPath, broadcastId, contacts);
    fs.writeFileSync(vcfPath, toVcard(contacts), "utf8");
    return { broadcastId, count: contacts.length, xlsxPath, vcfPath, contacts };
  });

  // النسخة الداخلية: بتربط name/phone/message/broadcastId/sourceCampaignId - مصدر الحقيقة عندنا،
  // مش Farmer Registry (مفيش أي كتابة على أي Store تشغيلي)
  const manifest = {
    preparedAt,
    sourceCampaignId,
    pilot: pilot > 0,
    preview,
    lists: lists.map((l) => ({
      broadcastId: l.broadcastId,
      count: l.count,
      contacts: l.contacts.map((c) => ({ ...c, broadcastId: l.broadcastId, sourceCampaignId })),
    })),
  };
  const manifestPath = path.join(outDir, pilot > 0 ? "manifest_test.json" : "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return { preview, lists: lists.map(({ contacts, ...rest }) => rest), manifestPath };
}

module.exports = { prepareBroadcast, analyze, MAX_PER_LIST };
