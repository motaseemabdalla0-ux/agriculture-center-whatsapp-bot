// بيحدّد مكان مجلد المزامنة (drive_incoming): لو فيه ملف gdrive_path.txt في جذر المشروع
// بيستخدم المسار المكتوب فيه (زي مسار Google Drive for Desktop الحقيقي على الجهاز)،
// وإلا بيرجع لمجلد محلي عادي جوه المشروع (السلوك الافتراضي القديم)

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const OVERRIDE_FILE = path.join(PROJECT_ROOT, "gdrive_path.txt");

function resolveDriveRoot() {
  if (fs.existsSync(OVERRIDE_FILE)) {
    const configuredPath = fs.readFileSync(OVERRIDE_FILE, "utf8").trim();
    if (configuredPath) return configuredPath;
  }
  return path.join(PROJECT_ROOT, "drive_incoming");
}

module.exports = { DRIVE_ROOT: resolveDriveRoot() };
