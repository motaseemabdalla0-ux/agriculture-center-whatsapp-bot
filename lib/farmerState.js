const fs = require("fs");
const path = require("path");
const { normalizeSaudiPhone } = require("./phoneUtil");
const auditLog = require("./auditLog");

// حالة مركزية ودائمة لكل مزارع، مستنتجة من البوابة (مصدر الحقيقة الأساسي) وقت كل مزامنة.
// البوابة نفسها مالهاش حقل "حالة موحّدة" فبنستنتجها من القسم اللي ظهر فيه المزارع - وبس من
// البيانات اللي فعلًا نقدر نثبتها، مش تخمين (شوف جدول الـMapping في lib/portalSync.js)
const STORE_FILE = path.join(__dirname, "..", "farmer_state.json");
const BACKUP_FILE = `${STORE_FILE}.bak`;

// الترتيب من الأضعف للأقوى - أي حالة بترقيم أعلى محسوبة "أكتر تقدّمًا". المنع من الرجوع للخلف
// بيتحقق بمقارنة الأرقام دي، مش بمقارنة نصية
const STATE_ORDER = [
  "UNKNOWN",
  "INVITED",
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "CARD_ISSUED",
  "CARD_COLLECTED",
];

function rank(state) {
  const idx = STATE_ORDER.indexOf(state);
  return idx === -1 ? 0 : idx;
}

function load() {
  if (!fs.existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (err) {
    console.log(`⚠️ ملف farmer_state.json تالف (${err.message})، بنجرب النسخة الاحتياطية...`);
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
        console.log("✅ استرجعنا النسخة الاحتياطية من farmer_state.json.bak بنجاح.");
        return backup;
      } catch {
        // النسخة الاحتياطية كمان تالفة - هنكمل تحت بفشل مقفول (Fail-Closed)
      }
    }
    // Fail-Closed: لو الأصلي والنسخة الاحتياطية اتنينهم تالفين، منرجعش {} (fail open) لأن ده كان
    // هيخلي كل المزارعين يتعتبروا UNKNOWN فورًا، وده ممكن يسمح بإرسال رسائل غلط تمامًا لمزارعين
    // حالتهم الحقيقية متقدمة (زي بطاقة مُستلمة) لو كانت القاعدة بتسمح بالإرسال عند UNKNOWN. بدل
    // كده بنرمي استثناء واضح يوقف أي حملة/فحص بيعتمد على Farmer State، والخطأ بيوصل بوضوح بدل
    // فشل صامت خطير
    const message =
      "🚨 FARMER_STATE_UNAVAILABLE: تعذّر استرجاع أي نسخة سليمة من farmer_state.json (والنسخة الاحتياطية كمان تالفة). " +
      "تم إيقاف أي عملية بتعتمد على حالة المزارع كإجراء أمان لمنع إرسال رسائل غلط. راجع الملف يدويًا قبل أي محاولة إرسال.";
    console.log(message);
    throw new Error(message);
  }
}

function save(state) {
  const tmp = `${STORE_FILE}.tmp`;
  if (fs.existsSync(STORE_FILE)) {
    try {
      fs.copyFileSync(STORE_FILE, BACKUP_FILE);
    } catch {
      // فشل النسخة الاحتياطية مش سبب كافي نوقف الحفظ
    }
  }
  fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

function defaultEntry() {
  return {
    state: "UNKNOWN",
    stateSource: null,
    updatedAt: null,
    lastSeenAt: null,
    applicationId: null,
    history: [],
  };
}

// بيرجع حالة مزارع معيّن (برقم جواله، أي صيغة - هيتوحّد تلقائيًا)
function getState(phone) {
  const key = normalizeSaudiPhone(phone);
  const all = load();
  return all[key] ? { ...all[key] } : defaultEntry();
}

function getAllStates() {
  return load();
}

// applicationId "أحدث" معناه رقمه أكبر (أرقام الطلبات في البوابة متتابعة تصاعديًا حسب كل
// الأمثلة اللي شفناها). لو مش قادرين نقارن رقميًا (نص غير رقمي)، بنسيب القديم زي ما هو
// (متحفّظين - مش نستبدل بحاجة مش متأكدين إنها أحدث فعلًا)
function isNewerApplication(candidateId, storedId) {
  if (!storedId) return true;
  const candidateNum = parseInt(candidateId, 10);
  const storedNum = parseInt(storedId, 10);
  if (Number.isFinite(candidateNum) && Number.isFinite(storedNum)) return candidateNum >= storedNum;
  return false;
}

// بيحدّث حالة مزارع واحد لو الحالة الجديدة "أقوى" من الحالة الحالية بس (منع الرجوع للخلف).
// بيحدّث lastSeenAt دايمًا بغض النظر، عشان "اختفاء المزارع من قسم في مزامنة لاحقة" ميتفسّرش
// كرجوع لحالة أقدم - هو لسه في نفس حالته، بس مش ظاهر في المزامنة دي بس.
// applicationId (اختياري): رقم الطلب/الفورم المرتبط - بيتحدّث لو أحدث من المخزّن حتى لو
// الحالة نفسها ما ترقّتش (زي إعادة تقديم درافت جديد لنفس المزارع)
function upsertState(phone, candidateState, source, applicationId) {
  const key = normalizeSaudiPhone(phone);
  const all = load();
  const entry = all[key] || defaultEntry();
  const now = new Date().toISOString();

  entry.lastSeenAt = now;
  if (applicationId && isNewerApplication(applicationId, entry.applicationId)) {
    entry.applicationId = String(applicationId);
  }
  if (rank(candidateState) > rank(entry.state)) {
    entry.history.push({ state: candidateState, source, at: now, previousState: entry.state, applicationId: entry.applicationId });
    entry.state = candidateState;
    entry.stateSource = source;
    entry.updatedAt = now;
  }

  all[key] = entry;
  save(all);
  return { ...entry };
}

// تصحيح/تحديث يدوي صريح - بيتخطى قاعدة "منع الرجوع للخلف" عمدًا (للتصحيحات اليدوية بس، زي
// تعليم بطاقة كمُستلمة). إلزامي: changedBy وreason - مفيش تغيير حالة يدوي من غير توثيق كامل،
// وبيتسجّل في history المزارع نفسه وكمان في الـAudit Log المركزي
function setManualState(phone, state, { changedBy, reason } = {}) {
  if (!changedBy) throw new Error("MANUAL_STATE_CHANGE_REQUIRES_CHANGED_BY");
  if (!reason) throw new Error("MANUAL_STATE_CHANGE_REQUIRES_REASON");

  const key = normalizeSaudiPhone(phone);
  const all = load();
  const entry = all[key] || defaultEntry();
  const now = new Date().toISOString();
  const oldState = entry.state;

  entry.history.push({ state, source: "manual", at: now, previousState: oldState, manual: true, changedBy, reason });
  entry.state = state;
  entry.stateSource = "manual";
  entry.updatedAt = now;
  entry.lastSeenAt = now;
  all[key] = entry;
  save(all);

  auditLog.record({
    normalizedPhone: key,
    decision: "MANUAL_STATE_CHANGE",
    reason: `${oldState} -> ${state}: ${reason}`,
    farmerState: state,
    extra: { oldState, newState: state, changedBy, reason },
  });

  return { ...entry };
}

// بيتأكد هل applicationId معيّن (اللي إشعار ما بيخص طلب بعينه) لسه هو أحدث طلب معروف للمزارع
// ده - لو ظهر طلب أحدث بعده (رقم أكبر)، يبقى الإشعار القديم ده "Stale" ومينفعش يتبعت.
//
// ملحوظة مهمة (راجع lib/portalScraper.js): "applicationId" مش مصدر واحد موحّد في البوابة -
// في الدرافت بييجي من رابط صفحة التفاصيل (requests/<id>) وهو غالبًا Primary Key من قاعدة
// بيانات (دليل معقول - بس مش مؤكد رسميًا من أي توثيق للبوابة إنه تصاعدي بالترتيب). في أقسام
// البطاقات/الرفيو بييجي بس من نص أول خلية في جدول العرض - مفيش دليل كودي إنه نفس مساحة الترقيم
// أو إنه تصاعدي فعلاً. كمان معندناش تاريخ (createdAt/updatedAt) بيوصل مع الإشعار نفسه (ملفات
// الـCSV اللي بتتبعت منها الرسائل بتحتوي على رقم الطلب بس، مش تاريخه) عشان نقارن بالتاريخ بدل
// الرقم. فالمقارنة الرقمية دلوقتي هي "افتراض تسلسلي غير مؤكد رسميًا" - بنفضل نستخدمها (عشان منكسرش
// الحماية الموجودة) بس بنوثّق صريح في كل قرار اعتمد عليها بالـreason "STALE_APPLICATION_UNVERIFIED"
// بدل ما نقدّمها كحقيقة مؤكدة 100%.
function isApplicationStale(phone, applicationId) {
  if (!applicationId) return { stale: false, reason: "candidate_missing" };
  const info = getState(phone);
  if (!info.applicationId) return { stale: false, reason: "no_application_on_record" };
  if (String(info.applicationId) === String(applicationId)) return { stale: false, reason: "same_application" };
  const currentNum = parseInt(info.applicationId, 10);
  const candidateNum = parseInt(applicationId, 10);
  if (!Number.isFinite(currentNum) || !Number.isFinite(candidateNum)) {
    return { stale: false, reason: "not_comparable" }; // مش قادرين نقارن رقميًا - نتحفّظ ونسيبه يعدي
  }
  return {
    stale: candidateNum < currentNum,
    reason: "STALE_APPLICATION_UNVERIFIED", // القرار (حظر أو سماح) اعتمد على الافتراض التسلسلي غير المؤكد فوق
  };
}

// بيطبّق دفعة تحديثات (من مزامنة بوابة واحدة) - لو نفس المزارع ظهر أكتر من مرة في نفس الدفعة
// (مثلًا موجود في Draft وفي البطاقات الجاهزة في نفس اللحظة) بناخد أعلى حالة بس قبل ما نحدّث
function updateFromPortalBatch(entries) {
  const bestPerPhone = new Map();
  entries.forEach(({ phone, state, source, applicationId }) => {
    if (!phone || !state) return;
    const key = normalizeSaudiPhone(phone);
    const current = bestPerPhone.get(key);
    if (!current || rank(state) > rank(current.state)) {
      bestPerPhone.set(key, { phone: key, state, source, applicationId });
    }
  });
  const results = [];
  bestPerPhone.forEach(({ phone, state, source, applicationId }) => {
    results.push(upsertState(phone, state, source, applicationId));
  });
  return results;
}

module.exports = {
  STATE_ORDER,
  rank,
  getState,
  getAllStates,
  upsertState,
  setManualState,
  isApplicationStale,
  updateFromPortalBatch,
};
