const fs = require("fs");
const path = require("path");
const { parseFarmerRows, farmerRowsToCsvText } = require("./fileIngest");
const { DRIVE_ROOT } = require("./driveRoot");
const REGISTRATION_DIR = path.join(DRIVE_ROOT, "تسجيل");
const PICKUP_DIR = path.join(DRIVE_ROOT, "استلام");
const DOCUMENTS_DIR = path.join(DRIVE_ROOT, "طلب مستندات");
const INVITATION_DIR = path.join(DRIVE_ROOT, "دعوة للتسجيل");
const PROCESSED_DIR = path.join(DRIVE_ROOT, "تمت المعالجة");
// ملف بيتحط في "قيد الإرسال" فور ما البوت يبدأ يعالجه (عشان مايتقراش تاني من ملف تاني وقته)،
// وبعدين ينقل لـ"تمت المعالجة" لو الإرسال نجح، أو "فشل الإرسال" لو فشل - بدل الوضع القديم اللي
// كان بينقل الملف لـ"تمت المعالجة" فورًا بعد كتابة الـCSV وقبل أي محاولة إرسال فعلية، فلو الإرسال
// فشل (مثلًا فيه عملية تانية شغالة) كان الملف بيتحط في الأرشيف وكأنه اتبعت، من غير أي أثر لإعادة المحاولة
const PROCESSING_DIR = path.join(DRIVE_ROOT, "قيد الإرسال");
const FAILED_DIR = path.join(DRIVE_ROOT, "فشل الإرسال");

const SUPPORTED_EXTENSIONS = [".xlsx", ".xls", ".csv"];

const WATCHED_FOLDERS = [
  [REGISTRATION_DIR, "registration", true, path.join(__dirname, "..", "registration_status.csv")],
  [PICKUP_DIR, "pickup", false, path.join(__dirname, "..", "card_pickup.csv")],
  [DOCUMENTS_DIR, "documents", false, path.join(__dirname, "..", "documents_request.csv")],
  [INVITATION_DIR, "invitation", false, path.join(__dirname, "..", "registration_invitation.csv")],
];

let loggedDriveWarning = false;

function ensureFolders() {
  [
    DRIVE_ROOT,
    REGISTRATION_DIR,
    PICKUP_DIR,
    DOCUMENTS_DIR,
    INVITATION_DIR,
    PROCESSED_DIR,
    PROCESSING_DIR,
    FAILED_DIR,
  ].forEach((dir) => {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      // Google Drive (وضع "Files on Demand") أحيانًا بيرجّع ENOENT وهمي لمجلد موجود فعليًا
      // لو مش متزامن بالكامل في اللحظة دي - بنتجاهل الخطأ ده بدل ما نخليه يتكرر ويغرق اللوج
      if (!loggedDriveWarning) {
        loggedDriveWarning = true;
        console.log(
          `⚠️ تعذّر التأكد من مجلد "${dir}" (${err.code || err.message}) - غالبًا مزامنة Google Drive لسه شغالة. هيتجاهل الخطأ ده بصمت من دلوقتي.`
        );
      }
    }
  });
}

function listIncomingFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => SUPPORTED_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .filter((name) => !name.startsWith("~$")); // ملفات مؤقتة بيعملها إكسل وهو فاتح
}

function moveTo(filePath, targetDir) {
  const base = path.basename(filePath);
  const stamped = `${Date.now()}_${base}`;
  const targetPath = path.join(targetDir, stamped);
  fs.renameSync(filePath, targetPath);
  return targetPath;
}

// بيفحص المجلدات الأربعة ويعالج أول ملف جديد يلاقيه (لو موجود). الملف بينقل لـ"قيد الإرسال"
// فورًا (مش "تمت المعالجة") عشان منعرضوش تاني، وبيرجع processingPath عشان الاستدعاء بعد كده
// (في index.js) ينده finalizeIncomingFile عليه بعد ما يتأكد نجح الإرسال ولا فشل.
// بيرجع {type, count, fileName, processingPath} لو عالج ملف، أو null لو مفيش جديد
function processNextIncomingFile() {
  ensureFolders();

  for (const [dir, type, needsRequestNumber, targetCsv] of WATCHED_FOLDERS) {
    const files = listIncomingFiles(dir);
    if (files.length === 0) continue;

    const filePath = path.join(dir, files[0]);
    const buffer = fs.readFileSync(filePath);
    const rows = parseFarmerRows(buffer, needsRequestNumber);
    const processingPath = moveTo(filePath, PROCESSING_DIR);

    if (rows.length === 0) {
      // مفيش بيانات صحيحة أصلًا - منقلوش لمجلد "فشل" (ده مش فشل إرسال)، بس نأرشفه على طول
      moveTo(processingPath, PROCESSED_DIR);
      return { type, count: 0, fileName: files[0] };
    }

    fs.writeFileSync(targetCsv, farmerRowsToCsvText(rows, needsRequestNumber), "utf8");
    return { type, count: rows.length, fileName: files[0], processingPath };
  }

  return null;
}

// بيتنده بعد محاولة الإرسال: لو نجحت (started=true) بينقل الملف من "قيد الإرسال" لـ"تمت المعالجة"،
// ولو فشلت (زي وجود عملية إرسال تانية شغالة) بينقله لـ"فشل الإرسال" عشان تقدر تعيد محاولته يدويًا
// (بنقله تاني لمجلد المصدر) بدل ما يضيع في الأرشيف وكأنه اتبعت فعلًا
function finalizeIncomingFile(processingPath, success) {
  if (!processingPath || !fs.existsSync(processingPath)) return;
  moveTo(processingPath, success ? PROCESSED_DIR : FAILED_DIR);
}

module.exports = {
  processNextIncomingFile,
  finalizeIncomingFile,
  ensureFolders,
  DRIVE_ROOT,
  REGISTRATION_DIR,
  PICKUP_DIR,
  DOCUMENTS_DIR,
  INVITATION_DIR,
};
