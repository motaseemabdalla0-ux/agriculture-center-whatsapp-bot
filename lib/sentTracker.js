const fs = require("fs");
const path = require("path");
const { writeJsonAtomicSync } = require("./safeJsonStore");

const STORE_FILE = path.join(__dirname, "..", "sent_history.json");
const BACKUP_FILE = `${STORE_FILE}.bak`;

// تلف السجل ده خطير جدًا: لو اتقرا فاضي بالغلط، البوت هيعتبر كل المزارعين "لسه ما اتبعتلهمش"
// ويبعتلهم كل الرسائل تاني من الأول (إرسال جماعي مكرر). فبدل ما نرجّع {} بصمت على أي خطأ قراءة،
// بنجرب النسخة الاحتياطية الأخيرة الأول، ولو هي كمان تالفة بنسجّل تحذير واضح في اللوج
// (بدل الفشل الصامت) عشان تلاحظ المشكلة قبل ما تسبب إرسال مكرر لكل الأرقام
function load() {
  if (!fs.existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (err) {
    console.log(`⚠️ ملف sent_history.json تالف (${err.message})، بنجرب النسخة الاحتياطية...`);
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
        console.log("✅ استرجعنا النسخة الاحتياطية من sent_history.json.bak بنجاح.");
        return backup;
      } catch {
        // النسخة الاحتياطية كمان تالفة - هنكمل تحت بتحذير واضح
      }
    }
    // Fail Closed: لو الأصلي والنسخة الاحتياطية اتنينهم تالفين، منرجعش {} (fail open) لأن ده
    // كان هيخلي كل الحملات تعتبر كل المزارعين "لسه ما اتبعتلهمش" وتبعتلهم آلاف الرسائل من
        // الأول تاني. بدل كده بنرمي استثناء يوقف الحملة اللي بتحاول تقرا السجل، والخطأ بيوصل
    // بوضوح للمستخدم (عبر try/catch الموجودة أصلًا في نداءات المزامنة) بدل فشل صامت خطير
    const message =
      "🚨 SEND_HISTORY_CORRUPTED: تعذّر استرجاع أي نسخة سليمة من sent_history.json (والنسخة الاحتياطية كمان تالفة). " +
      "تم إيقاف العملية كإجراء أمان لمنع إعادة إرسال جماعي للمزارعين. راجع الملف يدويًا قبل أي محاولة إرسال.";
    console.log(message);
    throw new Error(message);
  }
}

// كتابة ذرّية: بنكتب في ملف مؤقت ونعمل rename بدل الكتابة المباشرة على الملف الأصلي، عشان لو
// العملية اتقفلت فجأة (كهرباء/كراش) في نص الكتابة، الملف الأصلي يفضل سليم زي ما كان بدل ما يتلف
// نص كتابة. وبناخد نسخة احتياطية من النسخة السابقة قبل الاستبدال كخط دفاع تاني
// كتابة ذرّية مع إعادة محاولة تلقائية على EPERM/EACCES/EBUSY (شوف lib/safeJsonStore.js) - نفس
// شكل البيانات والـbackup بالظبط. load() فوق فضل Fail-Closed زي ما هو تمامًا.
function save(state) {
  writeJsonAtomicSync(STORE_FILE, BACKUP_FILE, state);
}

// هل الرقم ده سبق واتبعتله رسالة من نفس النوع (campaignType) قبل كده؟
function hasBeenSent(campaignType, phone) {
  const state = load();
  return Array.isArray(state[campaignType]) && state[campaignType].includes(phone);
}

// يسجّل إن الرقم ده استلم رسالة من النوع ده، عشان منبعتلوش تاني أبدًا لنفس النوع
function markSent(campaignType, phone) {
  const state = load();
  if (!Array.isArray(state[campaignType])) state[campaignType] = [];
  if (!state[campaignType].includes(phone)) {
    state[campaignType].push(phone);
    save(state);
  }
}

// بيرجع عدد الأرقام اللي اتبعتلهم رسالة من نوع معيّن (على مر الوقت، مش بس النهارده)
function getSentCount(campaignType) {
  const state = load();
  return Array.isArray(state[campaignType]) ? state[campaignType].length : 0;
}

// بيرجع كل الأنواع المسجّلة مع عدد كل واحد فيهم
function getAllCounts() {
  const state = load();
  const counts = {};
  Object.keys(state).forEach((campaignType) => {
    counts[campaignType] = Array.isArray(state[campaignType]) ? state[campaignType].length : 0;
  });
  return counts;
}

module.exports = { hasBeenSent, markSent, getSentCount, getAllCounts };
