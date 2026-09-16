const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { DRIVE_ROOT } = require("./driveRoot");

const PROJECT_ROOT = path.join(__dirname, "..");
const UPDATE_DIR = path.join(DRIVE_ROOT, "تحديث الكود");
const BACKUP_DIR = path.join(DRIVE_ROOT, "نسخ احتياطية قبل التحديث");
const PROCESSED_DIR = path.join(DRIVE_ROOT, "تمت المعالجة");

// أي ملف بالاسم ده يتحط في مجلد التحديث، البوت بيدور عليه في الأماكن دي بالترتيب
const SEARCH_DIRS = [
  PROJECT_ROOT,
  path.join(PROJECT_ROOT, "lib"),
  path.join(PROJECT_ROOT, "scripts"),
];

let loggedDriveWarning = false;

function ensureFolders() {
  [UPDATE_DIR, BACKUP_DIR, PROCESSED_DIR].forEach((dir) => {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      // Google Drive (وضع "Files on Demand") أحيانًا بيرجّع ENOENT وهمي لمجلد موجود فعليًا
      // لو مش متزامن بالكامل في اللحظة دي - بنتجاهل الخطأ ده بدل ما نخليه يتكرر ويغرق
      // اللوج كل ثانيتين (الفحص الدوري بيتنده كل 2 ثانية). بنسجّل تحذير واحد بس أول مرة.
      if (!loggedDriveWarning) {
        loggedDriveWarning = true;
        console.log(
          `⚠️ تعذّر التأكد من مجلد "${dir}" (${err.code || err.message}) - غالبًا مزامنة Google Drive لسه شغالة. هيتجاهل الخطأ ده بصمت من دلوقتي.`
        );
      }
    }
  });
}

function findTargetPath(fileName) {
  for (const dir of SEARCH_DIRS) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// بيتأكد إن الملف الجديد سليم من ناحية صياغة JavaScript قبل ما نستبدله بالقديم - لو فيه خطأ
// صياغة (مثلًا نسخة ناقصة أو اتقطعت أثناء النسخ)، القديم كان بيتستبدل عمياني والبوت يقع
// عند إعادة التشغيل، من غير أي رجوع تلقائي. دلوقتي بنرفض التحديث التالف من الأصل
function isValidJs(filePath) {
  try {
    // مهلة 10 ثواني + إخفاء نافذة الكونسول - بعد كل مشاكل التعليق اللي واجهناها، مينفعش نسيب
    // فحص الصياغة نفسه من غير مهلة، ولا نخلي نافذة تظهر على جهاز شغال بدون واجهة تفاعل
    execFileSync(process.execPath, ["--check", filePath], {
      stdio: "pipe",
      timeout: 10000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function listUpdateFiles() {
  if (!fs.existsSync(UPDATE_DIR)) return [];
  return fs
    .readdirSync(UPDATE_DIR)
    .filter((name) => name.endsWith(".js"))
    .filter((name) => !name.startsWith("~$"));
}

// بيفحص مجلد "تحديث الكود"، ولو لقى ملفات جديدة بيطبّقها كلها
// بيرجع true لو طبّق تحديث واحد على الأقل (يبقى محتاج إعادة تشغيل)
function applyPendingUpdates() {
  // مفتاح إيقاف طارئ لميزة "تحديث الكود عن طريق درايف": حط ALLOW_DRIVE_CODE_UPDATES=0 في
  // متغيرات البيئة لو حبيت توقف الميزة دي مؤقتًا (مثلًا لو حصل قلق أمني بخصوص وصول لمجلد الدرايف)
  if (process.env.ALLOW_DRIVE_CODE_UPDATES === "0") {
    return { updated: false, applied: [], skipped: [] };
  }
  ensureFolders();
  const files = listUpdateFiles();
  if (files.length === 0) return { updated: false, applied: [], skipped: [] };

  const applied = [];
  const skipped = [];

  for (const fileName of files) {
    const sourcePath = path.join(UPDATE_DIR, fileName);
    const targetPath = findTargetPath(fileName);

    if (!targetPath) {
      skipped.push(`${fileName} (مش لاقي ملف بنفس الاسم ده في المشروع)`);
      // نشيله عشان مانحاولش نعالجه تاني، ونحطه في المعالج عشان محدش يضيع
      fs.renameSync(sourcePath, path.join(PROCESSED_DIR, `unmatched_${Date.now()}_${fileName}`));
      continue;
    }

    if (!isValidJs(sourcePath)) {
      skipped.push(`${fileName} (فيه خطأ صياغة JavaScript - اتجاهل من غير ما يتطبق، القديم فضل شغال)`);
      fs.renameSync(sourcePath, path.join(PROCESSED_DIR, `invalid_${Date.now()}_${fileName}`));
      continue;
    }

    // نسخة احتياطية من القديم قبل ما نستبدله
    const backupName = `${Date.now()}_${fileName}`;
    fs.copyFileSync(targetPath, path.join(BACKUP_DIR, backupName));

    fs.copyFileSync(sourcePath, targetPath);
    fs.renameSync(sourcePath, path.join(PROCESSED_DIR, `${Date.now()}_${fileName}`));

    applied.push(`${fileName} -> ${path.relative(PROJECT_ROOT, targetPath)}`);
  }

  return { updated: applied.length > 0, applied, skipped };
}

module.exports = { applyPendingUpdates, ensureFolders, UPDATE_DIR, BACKUP_DIR };
