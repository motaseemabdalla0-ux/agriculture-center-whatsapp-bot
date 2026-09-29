const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { runSafetyGate } = require("./safetyGate");

const PROJECT_ROOT = path.join(__dirname, "..");
const PACKAGE_FILES = ["package.json", "package-lock.json"];

// GIT_TERMINAL_PROMPT=0 و GCM_INTERACTIVE=never: لو صلاحية الوصول لـGitHub انتهت أو اتلغت،
// git بيحاول يفتح بروبمت تفاعلي (يوزرنيم/باسورد) بيعلّق للأبد من غير أي خطأ ولا timeout عادي
// يقدر يمسكه - المتغيرين دول بيمنعوا أي بروبمت تفاعلي، فبدل ما يعلّق، الأمر بيفشل فورًا برسالة
// خطأ واضحة نقدر نمسكها في try/catch عادي
function git(args) {
  return execFileSync("git", args, {
    cwd: PROJECT_ROOT,
    stdio: "pipe",
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  })
    .toString()
    .trim();
}

// بيتأكد هل فيه تحديث جديد على GitHub (origin/main) عن الكود المحلي الحالي - صفر تغيير في أي
// ملف لو مفيش تحديث (git fetch بس بيحدّث مرجع origin/main المحلي، مش الكود الفعلي)
function checkForUpdate() {
  git(["fetch", "origin", "main"]);
  const local = git(["rev-parse", "HEAD"]);
  const remote = git(["rev-parse", "origin/main"]);
  return { updateAvailable: local !== remote, localHash: local, remoteHash: remote };
}

function revertToKnownGoodCommit(commitHash) {
  git(["reset", "--" + "hard", commitHash]);
}

function readPackageFiles() {
  return PACKAGE_FILES.map((f) => {
    const p = path.join(PROJECT_ROOT, f);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  });
}

// npm install فعليًا في مكان المشروع - بس لو package.json أو package-lock.json اتغيّروا فعلًا
// (مقارنة محتوى قبل/بعد الـpull)، عشان منستهلكش وقت طويل (npm install بطيء بسبب puppeteer) في
// كل تحديث كود عادي من غير تغيير اعتماديات
function installIfPackageChanged(before) {
  const after = readPackageFiles();
  const changed = before.some((content, i) => content !== after[i]);
  if (!changed) return { ranInstall: false };
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: PROJECT_ROOT,
    stdio: "pipe",
    timeout: 10 * 60 * 1000,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  return { ranInstall: true };
}

// بيسحب التحديث فعليًا (git pull --ff-only مباشر - المستودع على السيرفر عبارة عن clone حقيقي،
// فمفيش داعي لتحميل/فك ضغط zip منفصل زي نظام GitHub Releases الأقدم في cli.js). --ff-only يمنع
// أي merge commit تلقائي لو حصل تعارض غريب - في الحالة دي الأمر بيفشل بس، مفيش أي تغيير يحصل.
// بعد السحب: npm install لو الاعتماديات اتغيّرت، وبعدين نفس بوابة الأمان (صياغة + كل اختبارات
// طبقة الأمان) لكن *في مكان المشروع الحقيقي نفسه* - آمن لأن كل ملف اختبار في المشروع ده بيحفظ
// ويرجّع بيانات التشغيل الحقيقية زي ما هي بعد التشغيل (مبدأ ثابت في كل سكريبتات scripts/test*.js).
// لو فشل أي فحص، بيرجع فورًا لآخر Commit سليم (المستودع نضيف دايمًا - صفر تعديلات محلية غير
// متتبعة على السيرفر) ومفيش إعادة تشغيل تحصل خالص - البوت فاضل شغّال بالكود القديم
async function pullAndVerify() {
  const before = checkForUpdate();
  if (!before.updateAvailable) return { updated: false };

  const beforePackageFiles = readPackageFiles();
  git(["pull", "--ff-only", "origin", "main"]);

  let install = { ranInstall: false };
  try {
    install = installIfPackageChanged(beforePackageFiles);
  } catch (err) {
    revertToKnownGoodCommit(before.localHash);
    return { updated: false, aborted: true, stage: "npm_install", error: err.message, fromHash: before.localHash, attemptedHash: before.remoteHash };
  }

  const gate = runSafetyGate(PROJECT_ROOT);
  if (!gate.ok) {
    revertToKnownGoodCommit(before.localHash);
    // لو الاعتماديات كانت اتغيّرت واتنصّبت، والتحديث ده رُفض، نرجّع node_modules لحالتها الأصلية
    // كمان (المطابقة لـpackage.json القديم اللي رجعنا له بالـreset)
    if (install.ranInstall) {
      try {
        installIfPackageChanged(readPackageFiles());
      } catch {
        // فشل إعادة تثبيت الاعتماديات القديمة مش المفروض يمنع الـrollback نفسه من الاكتمال -
        // البوت هيفضل شغّال بكود قديم سليم حتى لو node_modules مش مظبوطة 100%، وده أأمن بكتير
        // من الاستمرار على كود جديد فشل في الاختبارات
      }
    }
    return { updated: false, aborted: true, stage: gate.stage, gate, fromHash: before.localHash, attemptedHash: before.remoteHash };
  }

  return { updated: true, fromHash: before.localHash, toHash: before.remoteHash, ranInstall: install.ranInstall, gate };
}

module.exports = { checkForUpdate, pullAndVerify };
