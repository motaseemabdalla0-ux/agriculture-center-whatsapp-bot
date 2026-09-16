const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// بيشغّل npm install جوّه staging بس لو package.json أو package-lock.json اتغيّروا فعليًا عن
// النسخة الحالية - عشان منستهلكش وقت في npm install (بطيء بسبب puppeteer) في كل تجربة تحديث
// من غير داعي. اختبارات طبقة الأمان (safeFarmerSend/farmerState...) مش محتاجة node_modules
// أصلًا (بتعتمد على lib/ ومكتبات Node المدمجة بس) - فتخطي الخطوة دي وقت الاختبار (update:test)
// آمن تمامًا؛ بنشغّلها فعليًا بس وقت التطبيق الحقيقي (update:apply) قبل إعادة تشغيل البوت
function packageFilesChanged(projectRoot, stagingDir) {
  const files = ["package.json", "package-lock.json"];
  return files.some((f) => {
    const a = path.join(projectRoot, f);
    const b = path.join(stagingDir, f);
    if (!fs.existsSync(a) || !fs.existsSync(b)) return true;
    return fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8");
  });
}

function installIfNeeded(projectRoot, stagingDir) {
  if (!packageFilesChanged(projectRoot, stagingDir)) {
    return { ranInstall: false, reason: "package.json/package-lock.json لم يتغيّرا" };
  }
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: stagingDir,
    stdio: "pipe",
    timeout: 10 * 60 * 1000,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  return { ranInstall: true };
}

module.exports = { installIfNeeded, packageFilesChanged };
