const path = require("path");
const { execFileSync } = require("child_process");
const { runSafetyGate } = require("./safetyGate");

const PROJECT_ROOT = path.join(__dirname, "..");

function git(args) {
  return execFileSync("git", args, { cwd: PROJECT_ROOT, stdio: "pipe", timeout: 30000, windowsHide: true }).toString().trim();
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

// بيسحب التحديث فعليًا (git pull مباشر - المستودع على السيرفر عبارة عن clone حقيقي، فمفيش
// داعي لتحميل/فك ضغط zip منفصل زي نظام GitHub Releases الأقدم في cli.js). بعد السحب، بيشغّل
// نفس بوابة الأمان (صياغة + كل اختبارات طبقة الأمان) لكن *في مكان المشروع الحقيقي نفسه* - آمن
// لأن كل ملف اختبار في المشروع ده بيحفظ ويرجّع بيانات التشغيل الحقيقية زي ما هي بعد التشغيل
// (مبدأ ثابت في كل سكريبتات scripts/test*.js). لو فشل أي فحص، بيرجع فورًا لآخر Commit سليم
// (المستودع نضيف دايمًا - صفر تعديلات محلية غير متتبعة على السيرفر) ومفيش إعادة تشغيل تحصل خالص
async function pullAndVerify() {
  const before = checkForUpdate();
  if (!before.updateAvailable) return { updated: false };

  git(["pull", "origin", "main"]);
  const gate = runSafetyGate(PROJECT_ROOT);

  if (!gate.ok) {
    revertToKnownGoodCommit(before.localHash);
    return { updated: false, aborted: true, gate, fromHash: before.localHash, attemptedHash: before.remoteHash };
  }

  return { updated: true, fromHash: before.localHash, toHash: before.remoteHash, gate };
}

module.exports = { checkForUpdate, pullAndVerify };
