const fs = require("fs");
const path = require("path");
const { farmerRowsToCsvText } = require("./fileIngest");
const sentTracker = require("./sentTracker");
const { localDateStr } = require("./dateUtil");
const farmerState = require("./farmerState");

// بيحدّث Farmer State Machine لكل صف ظهر في قسم معيّن من البوابة - البوابة هي مصدر الحقيقة
// الأساسي، والتحديث تلقائي وقت كل مزامنة. upsertState نفسها بترفض أي تراجع لحالة أقدم
// (منطق "الأعلى بيكسب" بيشتغل صح حتى لو الأقسام اتفحصت في نداءات منفصلة، لأن الترقية بس
// المسموحة - مفيش تراجع ممكن يحصل مهما كان ترتيب النداءات)
function updateStatesFromRows(rows, state, source) {
  rows.forEach((r) => {
    if (r.phone) farmerState.upsertState(r.phone, state, source, r.formNumber);
  });
}

const CONFIG_PATH = path.join(__dirname, "..", "portal_config.js");
const DAILY_COUNT_FILE = path.join(__dirname, "..", "portal_daily_count.json");
const DAILY_LIMIT = 10; // أقصى عدد مزارعين تُبعت لهم رسائل "الدرافت" في اليوم الواحد بس
// (البطاقات الجاهزة وحالة الطلب من غير حد أقصى - بيتبعتوا لكل الموجودين كل مرة مزامنة)

// تاريخ بداية إرسال رسائل الرفيو/الطباعة (بطلب من الإدارة: نبدأ من صباح الغد،
// أما الدرافت فيتبعت لكل الموجودين حاليًا من غير فلترة تاريخ - شوف syncDraftForms تحت)
const PORTAL_START_DATE = new Date(2026, 8, 7); // 7 سبتمبر 2026 (الشهر بيتعدّ من صفر، فـ8 = سبتمبر)

function isConfigured() {
  return fs.existsSync(CONFIG_PATH);
}

// هل وصلنا لتاريخ بداية إرسال رسائل الرفيو/الطباعة؟ (الدرافت مش بتحترم الشرط ده)
function isPastStartDate() {
  return new Date() >= PORTAL_START_DATE;
}

function todayStr() {
  return localDateStr();
}

function loadDailyCount() {
  if (!fs.existsSync(DAILY_COUNT_FILE)) return { date: todayStr(), count: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(DAILY_COUNT_FILE, "utf8"));
    if (data.date !== todayStr()) return { date: todayStr(), count: 0 }; // يوم جديد = عداد جديد
    return data;
  } catch {
    return { date: todayStr(), count: 0 };
  }
}

function saveDailyCount(data) {
  fs.writeFileSync(DAILY_COUNT_FILE, JSON.stringify(data), "utf8");
}

// كام مزارع لسه فاضل ليهم مكان في حصة اليوم (من أصل 10)
function getRemainingQuota() {
  const data = loadDailyCount();
  return Math.max(0, DAILY_LIMIT - data.count);
}

function addToTodayCount(n) {
  if (n <= 0) return;
  const data = loadDailyCount();
  data.count += n;
  saveDailyCount(data);
}

// ترتيب الأولوية: بطاقات جاهزة (الأهم) > مراجعة/طلبات جديدة > درافت (الأقل أهمية)
// مزارع ظاهر في قسم أعلى في الأولوية لازم يتستبعد تمامًا من أي قسم أقل، حتى لو حصة اليوم خلصت قبل ما نوصله
// المطابقة بتتم على رقم الجوال أو رقم الهوية الوطنية (أيهما توفر) عشان نضمن إن نفس المزارع
// معندوش بطاقة جاهزة، أو طلبه أصلًا موجود في قسم البطاقات أو الرفيو، منبعتلوش رسالة درافت غلط

// بيتأكد هل الصف ده يطابق أي حد في مجموعة الاستبعاد، سواء برقم الجوال أو رقم الهوية
function isExcluded(row, excludeSet) {
  if (row.phone && excludeSet.has(`phone:${row.phone}`)) return true;
  if (row.nationalId && excludeSet.has(`id:${row.nationalId}`)) return true;
  return false;
}

// بياخد أول ثلاث كلمات بس من اسم المزارع (اسم ثلاثي) بدل الاسم الكامل الرباعي/الخماسي
function firstTwoWords(name) {
  return (name || "").trim().split(/\s+/).slice(0, 3).join(" ");
}

// بيبني مجموعة مفاتيح استبعاد (جوال + هوية) من قائمة صفوف
function buildKeySet(rows) {
  const set = new Set();
  rows.forEach((r) => {
    if (r.phone) set.add(`phone:${r.phone}`);
    if (r.nationalId) set.add(`id:${r.nationalId}`);
  });
  return set;
}

// بيجيب البطاقات الجاهزة للتسليم من النظام، يستبعد اللي اتبعتلهم قبل كده،
// يقتصر على أقصى عدد متاح في حصة اليوم، ويحدّث card_pickup.csv
// بيرجع { count, rows } حيث rows = كل صفوف قسم البطاقات (مش بس اللي اتبعتلهم)
// عشان تُستخدم للاستبعاد (بالجوال أو الهوية) في الأقسام الأقل أولوية (الرفيو والدرافت)
async function syncPrintedCards(maxCount) {
  const { fetchPrintedCards, parseUsSlashDate } = require("./portalScraper");
  // بنفتح صفوف أكتر من maxCount عشان بعدهم يتستبعدوا (لو مش قابلين للإرسال) أو يبقوا مستبعدين مسبقًا
  const rows = await fetchPrintedCards(Math.max(maxCount * 3, 15));
  // البطاقة اتطبعت فعليًا (تاب "Printed") = صدرت البطاقة - بتحدّث Farmer State لكل الصفوف اللي
  // فيها جوال، بغض النظر هل هتتبعتلهم رسالة دلوقتي ولا لأ (اتستبعدوا أو الحصة خلصت)
  updateStatesFromRows(rows, "CARD_ISSUED", "portal:cards");

  const sendableRows = rows.filter((r) => r.phone); // لازم رقم جوال عشان نقدر نبعتله واتساب
  // فلترة بتاريخ الإصدار (لو ظاهر في الصف): بس من تاريخ البداية فما فوق. لو مفيش تاريخ ظاهر
  // في صفحة الإصدار (العمود ده مش مؤكد وجوده هناك)، بنسيب الصف من غير فلترة تاريخ - الحماية
  // الأساسية إننا أصلًا مش هنشتغل قبل PORTAL_START_DATE (شوف isPastStartDate في index.js)
  const dateFilteredRows = sendableRows.filter((r) => {
    const parsed = parseUsSlashDate(r.submittedDate);
    if (!parsed) return true; // مفيش تاريخ نقدر نفلتر بيه - نسيبه يعدي
    return parsed >= PORTAL_START_DATE;
  });
  const newRows = dateFilteredRows
    .filter((r) => !sentTracker.hasBeenSent("card_pickup", r.phone))
    .slice(0, maxCount);

  const csvRows = newRows.map((r) => ({ name: firstTwoWords(r.name), phone: r.phone, request_number: "" }));
  fs.writeFileSync(
    path.join(__dirname, "..", "card_pickup.csv"),
    farmerRowsToCsvText(csvRows, false),
    "utf8"
  );
  return { count: csvRows.length, rows };
}

// بيجيب الطلبات الجديدة (في انتظار الطباعة) من النظام، يستبعد اللي اتبعتلهم قبل كده
// وكمان يستبعد أي مزارع أصلًا ظاهر في قسم البطاقات (بالجوال أو الهوية)،
// يقتصر على أقصى عدد متاح في حصة اليوم، ويحدّث registration_status.csv
async function syncPendingPrintingRequests(maxCount, excludeSet = new Set()) {
  const { fetchPendingPrintingRequests, parseUsSlashDate } = require("./portalScraper");
  const rows = await fetchPendingPrintingRequests(Math.max(maxCount * 3, 15));
  // القسم ده تحديدًا (Pending Printing جوّه مراجعة التسجيل) معناه الطلب اتقبل فعلًا وبينتظر
  // الطباعة بس - يعني "APPROVED" أدق حالة نقدر نستنتجها من البيانات المتاحة فعليًا هنا
  updateStatesFromRows(rows, "APPROVED", "portal:review");

  const sendableRows = rows.filter((r) => r.phone);
  // فلترة بتاريخ عمود "Submitted" (مؤكد وجوده في صفحة الرفيو): بس الطلبات من تاريخ البداية فما فوق
  const dateFilteredRows = sendableRows.filter((r) => {
    const parsed = parseUsSlashDate(r.submittedDate);
    return parsed && parsed >= PORTAL_START_DATE;
  });
  const newRows = dateFilteredRows
    .filter((r) => !isExcluded(r, excludeSet))
    .filter((r) => !sentTracker.hasBeenSent("registration_status", r.phone))
    .slice(0, maxCount);

  const csvRows = newRows.map((r) => ({ name: firstTwoWords(r.name), phone: r.phone, request_number: r.formNumber }));
  fs.writeFileSync(
    path.join(__dirname, "..", "registration_status.csv"),
    farmerRowsToCsvText(csvRows, true),
    "utf8"
  );
  return { count: csvRows.length, rows };
}

// بيجيب الطلبات "درافت" (لسه ما اتقدّمتش) من النظام، يستبعد اللي اتبعتلهم قبل كده
// وكمان يستبعد أي مزارع أصلًا ظاهر في قسم البطاقات أو قسم الرفيو (بالجوال أو الهوية)،
// يقتصر على أقصى عدد متاح في حصة اليوم، ويحدّث draft_forms.csv
async function syncDraftForms(maxCount, excludeSet = new Set()) {
  const { fetchDraftForms } = require("./portalScraper");
  // بنمرر شرط القبول (مش مستبعد، وملوش رسالة درافت قبل كده) جوّه الاستخراج نفسه، عشان الماسح
  // يفضل يتصفح الصفحات لحد ما يلاقي فعلًا "maxCount" مرشّح مؤهّل - مش يوقف بعد أول دفعة ثابتة
  // من الصفوف حتى لو كلهم طلعوا مستبعدين (ده كان بيرجّع صفر رغم وجود مئات الصفوف المؤهلة بعدهم)
  const filterFn = (r) =>
    !!r.phone && !isExcluded(r, excludeSet) && !sentTracker.hasBeenSent("draft_reminder", r.phone);
  const newRows = await fetchDraftForms(maxCount, filterFn);
  // كل صف درافت شفناه معناه المزارع بدأ إجراء بس لسه ما قدّمش - بتحدّث Farmer State لـDRAFT
  updateStatesFromRows(newRows, "DRAFT", "portal:draft");

  const csvRows = newRows.map((r) => ({ name: firstTwoWords(r.name), phone: r.phone, request_number: r.formNumber }));
  fs.writeFileSync(
    path.join(__dirname, "..", "draft_forms.csv"),
    farmerRowsToCsvText(csvRows, true),
    "utf8"
  );
  return { count: csvRows.length };
}

module.exports = {
  isConfigured,
  syncPrintedCards,
  syncPendingPrintingRequests,
  syncDraftForms,
  buildKeySet,
  getRemainingQuota,
  addToTodayCount,
  isPastStartDate,
  PORTAL_START_DATE,
  DAILY_LIMIT,
};
