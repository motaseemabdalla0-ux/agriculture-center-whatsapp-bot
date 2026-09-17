const fs = require("fs");
const path = require("path");
const { localDateStr } = require("./dateUtil");
const { writeJsonAtomicSync } = require("./safeJsonStore");

// سجل دائم (مش بيتمسح) لكل رسالة اتبعتت أو فشلت، عشان نقدر نسأل البوت لاحقًا "ايه اللي اتبعت النهارده"
// (ملفات اللوج التانية زي card-pickup-log.txt بتتمسح وتتكتب من جديد كل مرة، فمش تقدر تجمع تاريخ كامل)
const LOG_FILE = path.join(__dirname, "..", "send_log.json");
const BACKUP_FILE = `${LOG_FILE}.bak`;
const MAX_ENTRIES = 5000;

function load() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.log(`⚠️ ملف send_log.json تالف (${err.message})، بنجرب النسخة الاحتياطية...`);
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
        if (Array.isArray(backup)) {
          console.log("✅ استرجعنا النسخة الاحتياطية من send_log.json.bak بنجاح.");
          return backup;
        }
      } catch {
        // النسخة الاحتياطية كمان تالفة - هنكمل تحت بسجل فاضي
      }
    }
    console.log("🚨 تعذّر استرجاع أي نسخة سليمة من send_log.json - بنبدأ بسجل فاضي.");
    return [];
  }
}

// كتابة ذرّية مع إعادة محاولة تلقائية على EPERM/EACCES/EBUSY (شوف lib/safeJsonStore.js) - الملف
// ده بالذات بيتكتب كامل من جديد مع كل رسالة (حملة كبيرة = آلاف عمليات الكتابة على ملف كبير)،
// فهو من أكتر الملفات عرضة لتصادم EPERM أثناء حملة طويلة
function save(entries) {
  writeJsonAtomicSync(LOG_FILE, BACKUP_FILE, entries);
}

// بيسجّل نتيجة إرسال رسالة واحدة. status: "sent" | "not_on_whatsapp" | "invalid_phone" | "skipped_duplicate" | "failed"
function logSend(label, name, phone, status) {
  const entries = load();
  entries.push({
    date: localDateStr(),
    time: new Date().toLocaleTimeString("ar-SA"),
    label,
    name: name || "",
    phone: phone || "",
    status,
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  save(entries);
}

// بيرجع ملخص كل الرسائل اللي اتبعتت في تاريخ معيّن (افتراضيًا النهارده)، متجمّعة حسب نوع الرسالة
function getDaySummary(dateStr) {
  const targetDate = dateStr || localDateStr();
  const entries = load().filter((e) => e.date === targetDate);

  const groups = {};
  entries.forEach((e) => {
    if (!groups[e.label]) groups[e.label] = { sent: [], failed: [] };
    if (e.status === "sent") groups[e.label].sent.push(e);
    else groups[e.label].failed.push(e);
  });

  return { date: targetDate, total: entries.length, groups };
}

// بيرجع كل المزارعين اللي اتبعتلهم رسالة من نوع معيّن (label) بنجاح - من كل الوقت (لغاية آخر
// MAX_ENTRIES سجل محفوظين)، مش بس النهارده زي getDaySummary
function getAllByLabel(label) {
  return load().filter((e) => e.label === label && e.status === "sent");
}

// بيرجع كل أنواع الرسائل (labels) الموجودة في السجل فعليًا مع عدد كل نوع - عشان تعرف تكتب
// الاسم الصح لما تستخدم "اسماء <نوع الرسالة>"
function getLabelCounts() {
  const entries = load();
  const counts = {};
  entries.forEach((e) => {
    if (e.status !== "sent") return;
    counts[e.label] = (counts[e.label] || 0) + 1;
  });
  return counts;
}

// بيرجع كل الأرقام المختلفة (بدون تكرار) اللي اتبعتلهم أي نوع رسالة بنجاح، من كل الوقت، مع
// كل الأنواع اللي استلمها كل رقم - عشان أمر "كل الارقام" يقدر يوريها مجمّعة مش نوع نوع لوحده
function getAllRecipients() {
  const entries = load().filter((e) => e.status === "sent");
  const byPhone = new Map();
  entries.forEach((e) => {
    if (!e.phone) return;
    if (!byPhone.has(e.phone)) byPhone.set(e.phone, { phone: e.phone, name: e.name || "", labels: new Set() });
    const row = byPhone.get(e.phone);
    if (e.name) row.name = e.name; // آخر اسم معروف للرقم ده
    row.labels.add(e.label);
  });
  return Array.from(byPhone.values()).map((r) => ({ ...r, labels: Array.from(r.labels) }));
}

// آخر رسالة اتسجّلت (أي حالة) - قراءة فقط، للأمر الإداري "حالة البوت"
function getLastEntry() {
  const entries = load();
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

module.exports = { logSend, getDaySummary, getAllByLabel, getLabelCounts, getAllRecipients, getLastEntry };
