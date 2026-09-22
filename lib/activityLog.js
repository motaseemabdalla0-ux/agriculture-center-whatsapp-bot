const fs = require("fs");
const path = require("path");
const { localDateStr } = require("./dateUtil");

const ACTIVITY_LOG = path.join(__dirname, "..", "activity_log.csv");
const COMPLAINTS_LOG = path.join(__dirname, "..", "complaints.csv");
const KNOWN_SENDERS_FILE = path.join(__dirname, "..", "known_senders.json");

function todayStr(date = new Date()) {
  return localDateStr(date); // YYYY-MM-DD بالتوقيت المحلي
}

// الصيغة القديمة كانت مصفوفة أرقام بس (من غير أسماء) - بنحوّلها لو لقيناها لصيغة كائن
// {chatId: {name, firstSeen}} عشان نقدر نعرض اسم كل مزارع كلّم البوت من نفسه، مش بس رقمه
function loadKnownSenders() {
  if (!fs.existsSync(KNOWN_SENDERS_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(KNOWN_SENDERS_FILE, "utf8"));
    if (Array.isArray(data)) {
      const migrated = {};
      data.forEach((chatId) => {
        migrated[chatId] = { name: "", firstSeen: "" };
      });
      return migrated;
    }
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveKnownSenders(known) {
  fs.writeFileSync(KNOWN_SENDERS_FILE, JSON.stringify(known), "utf8");
}

// بيرجع كل المزارعين اللي كلّموا البوت من نفسهم (مش نتيجة حملة إرسال)، مع أسمائهم لو معروفة
function getKnownSenders() {
  const known = loadKnownSenders();
  return Object.entries(known).map(([chatId, info]) => ({
    chatId,
    name: (info && info.name) || "",
    firstSeen: (info && info.firstSeen) || "",
  }));
}

// بيسجل حدث واحد (نوع الحدث + رقم المرسل) بتاريخ ووقت الحدوث
function logEvent(type, phone) {
  const line = `${new Date().toISOString()},${type},${phone || ""}\n`;
  fs.appendFileSync(ACTIVITY_LOG, line, "utf8");
}

// بيسجل وصول رسالة من مزارع، وبيحدد هل ده أول تواصل منه على الإطلاق ولا لا. name (اختياري):
// اسم واتساب الظاهر للمزارع (contact.pushname) - بنحفظه عشان أوامر زي "كل الارقام" تقدر تعرضه
// حتى للمزارعين اللي كلّموا البوت من نفسهم (مش بس اللي جالهم رسالة حملة ليها اسم من ملف CSV)
function logIncomingMessage(phone, name) {
  logEvent("message_in", phone);

  const known = loadKnownSenders();
  const isNew = !known[phone];
  if (isNew) {
    known[phone] = { name: name || "", firstSeen: new Date().toISOString() };
    saveKnownSenders(known);
    logEvent("new_conversation", phone);
  } else if (name && !known[phone].name) {
    known[phone].name = name;
    saveKnownSenders(known);
  }
}

// بيسجل هل الرسالة اتردّ عليها ولا لأ
function logReplyOutcome(phone, wasReplied) {
  logEvent(wasReplied ? "replied" : "not_replied", phone);
}

// بيسجل شكوى/اقتراح كامل عشان محدش يضيع
function logComplaint(phone, text) {
  const safeText = (text || "").replace(/\r?\n/g, " | ").replace(/,/g, "؛");
  const line = `${new Date().toISOString()},${phone || ""},${safeText}\n`;
  if (!fs.existsSync(COMPLAINTS_LOG)) {
    fs.writeFileSync(COMPLAINTS_LOG, "التاريخ_والوقت,رقم_الجوال,النص\n", "utf8");
  }
  fs.appendFileSync(COMPLAINTS_LOG, line, "utf8");
}

// بيرجع ملخص نشاط يوم معين (افتراضيًا النهاردة)
function getDailySummary(date = new Date()) {
  const day = todayStr(date);
  const summary = {
    date: day,
    newConversations: 0,
    contactedFarmers: new Set(),
    repliedCount: 0,
    notRepliedCount: 0,
    choice1: 0,
    choice2: 0,
    choice3: 0,
    invalidChoice: 0,
    complaints: 0,
  };

  if (!fs.existsSync(ACTIVITY_LOG)) return summary;

  const lines = fs.readFileSync(ACTIVITY_LOG, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const [timestamp, type, phone] = line.split(",");
    if (!timestamp || !timestamp.startsWith(day)) continue;

    if (phone && type !== "new_conversation") summary.contactedFarmers.add(phone);

    if (type === "new_conversation") summary.newConversations++;
    else if (type === "replied") summary.repliedCount++;
    else if (type === "not_replied") summary.notRepliedCount++;
    else if (type === "choice_1") summary.choice1++;
    else if (type === "choice_2") summary.choice2++;
    else if (type === "choice_3") summary.choice3++;
    else if (type === "invalid_choice") summary.invalidChoice++;
    else if (type === "complaint_submitted") summary.complaints++;
  }

  return summary;
}

function formatDailySummary(summary) {
  return `📊 تقرير نشاط البوت - ${summary.date}

🆕 عدد المحادثات الجديدة من المزارعين: ${summary.newConversations}
👥 عدد المزارعين الذين تم التواصل معهم: ${summary.contactedFarmers.size}
✅ عدد المحادثات التي تم الرد عليها: ${summary.repliedCount}
❌ عدد المحادثات التي لم يتم الرد عليها: ${summary.notRepliedCount}

الخيارات الأكثر استخدامًا:
1️⃣ التسجيل في بطاقة المزرعة: ${summary.choice1}
2️⃣ التواصل مع موظف علاقات المزارعين: ${summary.choice2}
3️⃣ الاقتراحات والشكاوى: ${summary.choice3}

📝 شكاوى/اقتراحات مُرسلة فعليًا: ${summary.complaints}
⚠️ اختيارات غير صحيحة: ${summary.invalidChoice}`;
}

// بيرجع كل رقم آخر حالة رد ليه فعليًا "not_replied" (يعني فشل إرسال الرد ليه، ومفيش رد لاحق
// نجح بعدها) - قراءة فقط لملف activity_log.csv، للتذكير الإداري بالمعلّقات. بياخد آخر حدث
// "replied"/"not_replied" لكل رقم بس (مش كل الأحداث القديمة اللي اتصلحت بعدين برد ناجح)
function getPendingReplyFailures() {
  if (!fs.existsSync(ACTIVITY_LOG)) return [];
  const lastByPhone = new Map();
  const lines = fs.readFileSync(ACTIVITY_LOG, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const [timestamp, type, phone] = line.split(",");
    if (!phone || (type !== "replied" && type !== "not_replied")) continue;
    lastByPhone.set(phone, { phone, type, timestamp });
  }
  return Array.from(lastByPhone.values()).filter((e) => e.type === "not_replied");
}

module.exports = {
  logEvent,
  logIncomingMessage,
  logReplyOutcome,
  logComplaint,
  getDailySummary,
  formatDailySummary,
  getKnownSenders,
  getPendingReplyFailures,
  todayStr,
};
