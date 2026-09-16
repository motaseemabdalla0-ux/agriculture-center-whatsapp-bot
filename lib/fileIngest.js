const XLSX = require("xlsx");
const { csvField, parseCsv } = require("./csvUtil");

// بيحوّل الأرقام العربية والفارسية لأرقام إنجليزية
function toWesternDigits(str) {
  return String(str)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function readWorkbookRows(workbook) {
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
  });
}

// بيتأكد هل الملف Excel حقيقي (binary) من أول بايتات معروفة، أو نص عادي (CSV) - الملفات
// الحديثة (.xlsx) عبارة عن أرشيف zip وبتبدأ بتوقيع "PK"، والقديمة (.xls) بتوقيع OLE مختلف.
// أي حاجة تانية بنعتبرها نص CSV عادي.
function isBinaryExcelBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return true; // "PK" -> xlsx (zip)
  if (buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf) return true; // OLE -> xls قديم
  return false;
}

// بيرجع مصفوفة صفوف خام (كل صف = مصفوفة خلايا كنص) من buffer ملف Excel أو CSV.
// ملفات CSV بنقراها بنفسنا (csvUtil.parseCsv) بدل ما نسيب XLSX.read يخمّن ترميزها من الـbuffer
// مباشرة - لأن التخمين ده كان بيرجع نص عربي متلخبط (mojibake) بدل UTF-8 الصحيح، ومع ذلك
// بيعتبره "فيه بيانات" فمكانش بيوصل للـfallback الصحيح خالص. أما ملفات Excel الحقيقية (binary)
// فبتتقرأ زي ما هي عن طريق XLSX لأن الترميز جواها متحدّد أصلًا في تنسيق الملف نفسه.
function readRawRows(buffer) {
  let rawRows;
  if (isBinaryExcelBuffer(buffer)) {
    rawRows = readWorkbookRows(XLSX.read(buffer, { type: "buffer" }));
  } else {
    let text = buffer.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // إزالة BOM لو موجود
    rawRows = parseCsv(text);
  }

  return rawRows
    .map((row) => row.map((cell) => toWesternDigits(String(cell ?? "").trim())))
    .filter((row) => row.some((cell) => cell !== ""));
}

// النسخة القديمة (متوافقة مع الاستخدام السابق): بترجع صفوف فيها رقم جوال صحيح في العمود التاني بس
// (بتفترض ترتيب أعمدة ثابت: اسم، جوال[، رقم طلب])
function parseSpreadsheetBuffer(buffer) {
  return readRawRows(buffer).filter((row) => {
    const phoneDigits = (row[1] || "").replace(/[^\d]/g, "");
    return phoneDigits.length >= 8;
  });
}

// بيحوّل الصفوف لصيغة CSV (بالفاصلة) عشان تتكتب في الملف بنفس شكل الملفات العادية
function rowsToCsvText(rows, columnsCount) {
  const lines = rows.map((row) => {
    const cells = [];
    for (let i = 0; i < columnsCount; i++) {
      cells.push((row[i] || "").replace(/,/g, " "));
    }
    return cells.join(",");
  });
  return lines.join("\n") + "\n";
}

// أسماء الأعمدة المعروفة (عربي/إنجليزي) - أول تطابق في القائمة هو الأولوية
const NAME_HEADERS = [
  "farmer name ar",
  "اسم المزارع",
  "الاسم الكامل",
  "الاسم",
  "اسم",
  "farmer name",
  "name ar",
  "full name",
  "name",
];
const PHONE_HEADERS = [
  "phone number",
  "رقم الجوال",
  "رقم الهاتف",
  "رقم جوال",
  "الجوال",
  "phone",
  "mobile",
  "جوال",
  "هاتف",
];
const REQUEST_HEADERS = [
  "id",
  "رقم الطلب",
  "request number",
  "request id",
  "request",
  "card id",
  "رقم الطلب",
];

const MESSAGE_HEADERS = ["message", "الرسالة", "رسالة", "رساله", "نص الرسالة", "نص الرساله", "text"];

function findColumnIndex(headerRow, candidates) {
  const normalized = headerRow.map((h) => String(h).trim().toLowerCase());
  for (const cand of candidates) {
    const idx = normalized.indexOf(cand.toLowerCase());
    if (idx !== -1) return idx;
  }
  for (const cand of candidates) {
    const idx = normalized.findIndex((h) => h.includes(cand.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

// بيحلل ملف بيانات مزارعين بذكاء: لو أول صف "عناوين أعمدة" بيتعرف عليها بالاسم
// (عربي أو إنجليزي، بأي ترتيب)، وإلا بيرجع لافتراض ترتيب ثابت (اسم، جوال[، رقم طلب])
// needsRequestNumber: هل محتاجين عمود "رقم الطلب" ولا لأ (حالة التسجيل محتاجاه، استلام البطاقة لأ)
function parseFarmerRows(buffer, needsRequestNumber) {
  const rawRows = readRawRows(buffer);
  if (rawRows.length === 0) return [];

  const headerRow = rawRows[0];
  const nameIdx = findColumnIndex(headerRow, NAME_HEADERS);
  const phoneIdx = findColumnIndex(headerRow, PHONE_HEADERS);
  const requestIdx = findColumnIndex(headerRow, REQUEST_HEADERS);

  const hasRecognizedHeader = nameIdx !== -1 && phoneIdx !== -1;

  const dataRows = hasRecognizedHeader ? rawRows.slice(1) : rawRows;
  const nIdx = hasRecognizedHeader ? nameIdx : 0;
  const pIdx = hasRecognizedHeader ? phoneIdx : 1;
  const rIdx = hasRecognizedHeader ? requestIdx : 2;

  return dataRows
    .map((row) => ({
      name: (row[nIdx] || "").trim(),
      phone: (row[pIdx] || "").replace(/[^\d]/g, ""),
      request_number:
        needsRequestNumber && rIdx !== -1 ? (row[rIdx] || "").replace(/,/g, "").trim() : "",
    }))
    .filter((r) => r.phone.length >= 8);
}

// بيحلل ملف "رسائل مخصصة" (اسم، رقم جوال، رسالة) - زي parseFarmerRows بس بعمود رسالة إضافي.
// بيرجع رقم الجوال خام (من غير تنظيف أرقام) عشان التطبيع والتحقق يحصلوا في مكان تاني (phoneUtil)
// اللي بيدعم صيغ محلية ودولية مختلفة، مش بس "أول 8 أرقام" زي باقي أنواع الرسائل
function parseCustomMessageRows(buffer) {
  const rawRows = readRawRows(buffer);
  if (rawRows.length === 0) return [];

  const headerRow = rawRows[0];
  const nameIdx = findColumnIndex(headerRow, NAME_HEADERS);
  const phoneIdx = findColumnIndex(headerRow, PHONE_HEADERS);
  const messageIdx = findColumnIndex(headerRow, MESSAGE_HEADERS);

  const hasRecognizedHeader = nameIdx !== -1 && phoneIdx !== -1 && messageIdx !== -1;

  const dataRows = hasRecognizedHeader ? rawRows.slice(1) : rawRows;
  const nIdx = hasRecognizedHeader ? nameIdx : 0;
  const pIdx = hasRecognizedHeader ? phoneIdx : 1;
  const mIdx = hasRecognizedHeader ? messageIdx : 2;

  return dataRows.map((row) => ({
    name: (row[nIdx] || "").trim(),
    phone: (row[pIdx] || "").trim(),
    message: (row[mIdx] || "").trim(),
  }));
}

// القالب الرسمي الموحّد لصندوق استقبال الحملات (campaign-inbox): اسم الشخص | رقم الهاتف | الرسالة.
// بيدعم كل الأسماء البديلة للأعمدة (عربي/إنجليزي) عن طريق نفس findColumnIndex فوق. بيرجع
// hasMessageColumn عشان اللي بينادي يعرف: لو true يبعت رسالة كل صف كما هي (القالب الجديد)،
// لو false يبقى ملف قديم من غير عمود رسالة (لسه مدعوم - محتاج رسالة واحدة على مستوى الحملة كلها)
function parseFarmerMessageRows(buffer) {
  const rawRows = readRawRows(buffer);
  if (rawRows.length === 0) return { rows: [], hasMessageColumn: false };

  const headerRow = rawRows[0];
  const nameIdx = findColumnIndex(headerRow, NAME_HEADERS);
  const phoneIdx = findColumnIndex(headerRow, PHONE_HEADERS);
  const messageIdx = findColumnIndex(headerRow, MESSAGE_HEADERS);
  const requestIdx = findColumnIndex(headerRow, REQUEST_HEADERS);

  const hasRecognizedHeader = nameIdx !== -1 && phoneIdx !== -1;
  const hasMessageColumn = hasRecognizedHeader ? messageIdx !== -1 : true; // من غير عناوين، بنفترض القالب الأساسي (اسم، جوال، رسالة)

  const dataRows = hasRecognizedHeader ? rawRows.slice(1) : rawRows;
  const nIdx = hasRecognizedHeader ? nameIdx : 0;
  const pIdx = hasRecognizedHeader ? phoneIdx : 1;
  const mIdx = hasMessageColumn ? (hasRecognizedHeader ? messageIdx : 2) : -1;
  const rIdx = hasRecognizedHeader ? requestIdx : -1;

  const rows = dataRows
    .map((row) => ({
      name: (row[nIdx] || "").trim(),
      phone: (row[pIdx] || "").trim(),
      message: mIdx !== -1 ? (row[mIdx] || "").trim() : "",
      request_number: rIdx !== -1 ? (row[rIdx] || "").replace(/,/g, "").trim() : "",
    }))
    // الصف الفاضي بالكامل (الاسم والجوال والرسالة كلهم فاضيين) مش خطأ - بيتجاهل بصمت من غير
    // ما يتحسب ضمن أي عداد (لا صالح ولا مستبعد)
    .filter((r) => r.name || r.phone || r.message);

  return { rows, hasMessageColumn };
}

// بيحوّل نتيجة parseFarmerRows لصيغة CSV اللي البوت بيقرأها - بنحط أي حقل فيه فاصلة أو اقتباس
// أو سطر جديد بين علامتي اقتباس (csvField) عشان مايخلطش ترتيب الأعمدة لما يترقرا تاني
function farmerRowsToCsvText(rows, needsRequestNumber) {
  const lines = rows.map((r) =>
    needsRequestNumber
      ? [csvField(r.name), csvField(r.phone), csvField(r.request_number)].join(",")
      : [csvField(r.name), csvField(r.phone)].join(",")
  );
  return lines.join("\n") + "\n";
}

module.exports = {
  parseSpreadsheetBuffer,
  rowsToCsvText,
  parseFarmerRows,
  parseCustomMessageRows,
  parseFarmerMessageRows,
  farmerRowsToCsvText,
  toWesternDigits,
};
