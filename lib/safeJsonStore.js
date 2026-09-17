const fs = require("fs");

// طبقة تخزين JSON مركزية وآمنة لكل ملفات البيانات الدائمة في المشروع (send_fingerprints،
// farmer_registry، farmer_state، sent_history، campaigns/*، rate_limit_state، tickets،
// handoff_state، send_log...). بتحل مشكلة حقيقية حصلت فعليًا في الإنتاج: أثناء حملة حقيقية على
// 3,866 مزارع، حصل EPERM/EBUSY متكرر على fs.renameSync (على الأغلب بسبب برنامج حماية/فهرسة/
// مزامنة على ويندوز بيمسك الملف لحظيًا) - وده سبب سقوط الحملة كلها.
//
// الحل:
//   1) Retry + Backoff على كل عملية rename (EPERM/EACCES/EBUSY غالبًا مؤقتة على ويندوز).
//   2) قفل داخل نفس العملية (In-Process Mutex) لكل مسار ملف - يمنع نداءين متزامنين (async)
//      يحاولوا يكتبوا في نفس الملف في نفس اللحظة.
//   3) Backup تلقائي قبل كل استبدال - نفس السلوك القديم في كل الملفات، من غير تغيير.
//   4) Crash Recovery: لو الملف الأصلي مفقود/تالف لكن فيه .tmp صالح من عملية سابقة اتقطعت
//      قبل الـrename، بيسترجع منه تلقائيًا بدل ما يعتبر البيانات ضاعت.
//
// شكل البيانات نفسه ما اتغيّرش خالص - الدالتين دول بس بديل أكتر أمانًا لـ
// fs.writeFileSync(tmp) + fs.renameSync(tmp, file) اللي كان مكرر في كل ملفات lib/*Store.js.

const RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [50, 150, 400, 800, 1500]; // إجمالي أقصى انتظار ~3 ثواني قبل الاستسلام

// قفل بسيط لكل مسار - قائمة انتظار من الـPromises. Node عملية واحدة (Single Process)، فالقفل
// ده كافي تمامًا لمنع تداخل نداءات async مختلفة على نفس الملف (لو حصل مستقبلًا).
const locks = new Map();
async function withFileLock(filePath, fn) {
  const previous = locks.get(filePath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => (release = resolve));
  locks.set(filePath, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(filePath) === current) locks.delete(filePath);
  }
}

// ENOENT اتضاف كمان (بالإضافة لـEPERM/EACCES/EBUSY المطلوبين صراحةً) بعد ملاحظة حالة حقيقية على
// نفس السيرفر أثناء اختبار الإصلاح: rename بيرمي ENOENT عابر لو ملف .tmp اختفى للحظة (على
// الأغلب مسح/فحص لحظي من برنامج حماية) رغم إننا كتبناه فعلًا - نفس طبيعة العرض (تدخل مؤقت من
// نظام التشغيل/الحماية على ويندوز)، فمنطقي يتعامل بنفس منطق الـRetry
function isRetryableFsError(err) {
  return !!err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "EBUSY" || err.code === "ENOENT");
}

// نسخة sync من إعادة المحاولة - كل ملفات المشروع الحالية بتستخدم save() متزامن، فده بيحافظ على
// نفس شكل الاستخدام في كل مكان (منغيّرش mضاء الاستدعاء لعشرات النداءات المنتشرة في المشروع)
function renameWithRetrySync(tmpPath, targetPath) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableFsError(err) || attempt === RETRY_ATTEMPTS) throw err;
      console.log(
        `⚠️ ${err.code} أثناء rename (محاولة ${attempt}/${RETRY_ATTEMPTS}) - إعادة محاولة بعد ${RETRY_DELAYS_MS[attempt - 1] || 1500}ms...`
      );
      // Sleep متزامن حقيقي (Atomics.wait) - مش busy-wait بيستهلك المعالج. بيوقف الـEvent Loop
      // أثناء الانتظار (زي أي كود sync)، بس ده مقبول هنا لأنه بيحصل نادرًا (EPERM/EBUSY فعلي فقط)
      // ولفترة قصيرة (< 3 ثواني تراكميًا كحد أقصى) - أضمن بكتير من فقد بيانات حملة كاملة
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAYS_MS[attempt - 1] || 1500);
    }
  }
  throw lastErr;
}

// كتابة JSON ذرّية وآمنة: tmp -> backup من القديم -> rename (بإعادة محاولة) -> لو فشل حتى بعد
// كل المحاولات، بيرمي استثناء واضح (Fail Loud) بدل تجاهل الفشل بصمت - المستدعي (safeFarmerSend/
// campaignRunner) هو اللي يقرر يتعامل مع الفشل ده إزاي (زي DELIVERY_UNCERTAIN)
function writeJsonAtomicSync(filePath, backupPath, data) {
  const tmpPath = `${filePath}.tmp`;
  if (backupPath && fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch {
      // فشل النسخة الاحتياطية مش سبب كافي نوقف الحفظ نفسه
    }
  }
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, backupPath ? 2 : 0), "utf8");
  renameWithRetrySync(tmpPath, filePath);
}

// قراءة JSON آمنة: تجرب الأصلي، وإلا الاحتياطي، وإلا استرجاع من .tmp متبقّي من عملية اتقطعت
// (Crash Recovery) قبل ما ترجع للقيمة الافتراضية اللي المستدعي بيحددها (قيمة أو دالة)
function readJsonSync(filePath, backupPath, defaultValue) {
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      // نكمل تحت لباقي مصادر الاسترجاع
    }
  }
  if (backupPath && fs.existsSync(backupPath)) {
    try {
      return JSON.parse(fs.readFileSync(backupPath, "utf8"));
    } catch {
      // نكمل لمحاولة استرجاع الـtmp
    }
  }
  const tmpPath = `${filePath}.tmp`;
  if (fs.existsSync(tmpPath)) {
    try {
      const recovered = JSON.parse(fs.readFileSync(tmpPath, "utf8"));
      console.log(`♻️ استرجاع بيانات من ملف .tmp متبقٍّ (${tmpPath}) بعد انقطاع سابق قبل اكتمال rename.`);
      return recovered;
    } catch {
      // الـtmp كمان تالف/فاضي - نكمل للقيمة الافتراضية
    }
  }
  return typeof defaultValue === "function" ? defaultValue() : defaultValue;
}

// فحص صحة Persistence للأمر الإداري "حالة البوت" - قراءة فقط. HEALTHY يعني مفيش أي ملف .tmp
// يتيم متبقّي لأي من ملفات التخزين المعروفة (لو موجود، معناه آخر rename فشل حتى بعد كل الـRetry)
function checkHealth(knownFiles) {
  const orphanedTmp = knownFiles.filter((f) => fs.existsSync(`${f}.tmp`));
  return { healthy: orphanedTmp.length === 0, orphanedTmp };
}

module.exports = {
  readJsonSync,
  writeJsonAtomicSync,
  withFileLock,
  isRetryableFsError,
  checkHealth,
  RETRY_ATTEMPTS,
};
