const fs = require("fs");
const path = require("path");

// GitHub Update = CODE ONLY. القائمة دي هي الوحيدة اللي بتتحدّث من إصدار جديد - أي حاجة تانية
// في المشروع (بيانات تشغيلية، أسرار، جلسة واتساب...) متتلمسش أبدًا بواسطة الـUpdater، حتى لو
// كانت موجودة بنفس الاسم في الـRelease الجديد. ده Allowlist مقصود (مش Denylist) عشان نضمن إن
// أي ملف بيانات جديد نضيفه مستقبلًا يفضل محمي تلقائيًا من غير ما ننسى نضيفه لقائمة استبعاد
const CODE_PATHS = [
  "lib",
  "scripts",
  "updater",
  "campaign-inbox/adapters",
  "campaign-inbox/inboxEngine.js",
  "campaign-inbox/inboxStore.js",
  "campaign-inbox/localServer.js",
  "campaign-inbox/README.md",
  "index.js",
  "broadcast.js",
  "config.js",
  "package.json",
  "package-lock.json",
  "portal_config.example.js",
  ".puppeteerrc.cjs",
  "README.md",
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// بينسخ كل CODE_PATHS من مجلد المصدر (staging أو نسخة احتياطية) لمجلد الهدف - بيتجاهل بصمت
// أي مسار مش موجود أصلًا في المصدر (زي campaign-inbox لو لسه مش موجودة في إصدار قديم)
function syncCodePaths(fromDir, toDir) {
  const copied = [];
  const missing = [];
  CODE_PATHS.forEach((rel) => {
    const src = path.join(fromDir, rel);
    if (!fs.existsSync(src)) {
      missing.push(rel);
      return;
    }
    copyRecursive(src, path.join(toDir, rel));
    copied.push(rel);
  });
  return { copied, missing };
}

// بيعمل نسخة احتياطية من كل ملفات الكود الحالية (قبل التحديث) في مجلد باسم فيه التاريخ
// والإصدار القديم - عشان الـRollback يقدر يرجّعها بسرعة لو التحديث فشل
function backupCurrentCode(projectRoot, backupsDir, label) {
  const backupDir = path.join(backupsDir, `${Date.now()}_${label}`);
  fs.mkdirSync(backupDir, { recursive: true });
  CODE_PATHS.forEach((rel) => {
    const src = path.join(projectRoot, rel);
    if (fs.existsSync(src)) {
      copyRecursive(src, path.join(backupDir, rel));
    }
  });
  return backupDir;
}

module.exports = { CODE_PATHS, syncCodePaths, backupCurrentCode, copyRecursive };
