const fs = require("fs");
const path = require("path");
const { normalizeSaudiPhone } = require("./phoneUtil");
const { isArabicName } = require("./arabicNameGuard");
const { statusForReason } = require("./contactReasonMap");
const { readJsonSync, writeJsonAtomicSync } = require("./safeJsonStore");

// سجل مزارع دائم منفصل تمامًا عن Farmer State Machine (lib/farmerState.js) - ده بالتصميم
// (بند 5 من الطلب): farmerState تمثّل "فين وصل المزارع في إجراءات البطاقة" وده مش دورنا هنا،
// إحنا بنمثّل "ماذا حدث في التواصل معاه" (Communication Status) + بياناته الأساسية (الاسم
// العربي الموثوق، تاريخ/سجل التواصل). مفيش نسخة مكررة لـfarmerState هنا - أي عرض لحالة
// المزارع (زي أمر "سجل ...") بيقرا farmerState.getState() مباشرة وقت الطلب، مش يخزّنها هنا،
// عشان مفيش خطر إن نسخة قديمة تتخزّن هنا وتنفصل عن المصدر الحقيقي بمرور الوقت.
const STORE_FILE = path.join(__dirname, "..", "farmer_registry.json");
const BACKUP_FILE = `${STORE_FILE}.bak`;

const COMMUNICATION_STATUSES = [
  "NOT_CONTACTED",
  "MESSAGE_SENT",
  "CARD_READY_NOTIFIED",
  "DOCUMENTS_REQUESTED",
  "REGISTRATION_INVITATION_SENT",
  "DRAFT_REMINDER_SENT",
  "FARMER_REPLIED",
  "HANDED_OFF",
  "CLOSED",
];

const COMMUNICATION_STATUS_AR = {
  NOT_CONTACTED: "لم يتم التواصل",
  MESSAGE_SENT: "تم إرسال رسالة",
  CARD_READY_NOTIFIED: "تم إشعاره بجاهزية البطاقة",
  DOCUMENTS_REQUESTED: "تم طلب المستندات",
  REGISTRATION_INVITATION_SENT: "تم إرسال دعوة التسجيل",
  DRAFT_REMINDER_SENT: "تم إرسال تذكير باستكمال الطلب",
  FARMER_REPLIED: "رد المزارع",
  HANDED_OFF: "تم التحويل لموظف",
  CLOSED: "مغلق",
};

// نفس ترتيب/تسميات lib/farmerState.js بالحرف - للعرض بالعربي بس (المصدر الحقيقي يفضل هناك)
const FARMER_STATE_AR = {
  UNKNOWN: "غير معروف",
  INVITED: "تمت دعوته للتسجيل",
  DRAFT: "طلب غير مكتمل",
  SUBMITTED: "تم تقديم الطلب",
  UNDER_REVIEW: "تحت المراجعة",
  APPROVED: "تمت الموافقة",
  CARD_ISSUED: "تم إصدار البطاقة",
  CARD_COLLECTED: "تم استلام البطاقة",
};

const MESSAGE_SOURCE_AR = {
  SYSTEM_NOTIFICATION: "إشعار النظام",
  CAMPAIGN: "حملة",
  INBOUND_REPLY: "رد وارد من المزارع",
};

const CONTACT_REASON_AR = {
  APPLICATION_RECEIVED: "استلام الطلب",
  APPLICATION_UNDER_REVIEW: "الطلب تحت المراجعة",
  DOCUMENTS_REQUIRED: "استكمال المستندات",
  APPLICATION_APPROVED: "الموافقة على الطلب",
  CARD_READY: "جاهزية البطاقة",
  CARD_ISSUED: "إصدار البطاقة",
  REGISTRATION_INVITATION: "دعوة التسجيل",
  DRAFT_REMINDER: "تذكير باستكمال الطلب",
  GENERAL_NOTICE: "إشعار عام",
  SURVEY: "استبيان",
  EVALUATION: "تقييم",
  CUSTOM_MESSAGE: "رسالة مخصصة",
  MAIN_MENU: "القائمة الرئيسية",
  REGISTRATION_LINK: "رابط التسجيل",
  TICKET_RESPONSE: "رد على تذكرة",
  HUMAN_HANDOFF: "تحويل لموظف",
};

function defaultEntry(phone) {
  return {
    phone,
    nameArabic: null,
    nameSource: null,
    campaignId: null,
    campaignPurpose: null,
    campaignLabel: null,
    communicationStatus: "NOT_CONTACTED",
    lastContactReason: null,
    lastMessageSource: null,
    lastContactAt: null,
    totalMessages: 0,
    communicationHistory: [],
  };
}

// نفس نمط sentTracker/ticketStore (مش Fail-Closed زي farmerState/sentTracker) - لأن أسوأ
// سيناريو هنا لو الملف اتلف هو منمنعش رسالة بسبب عدم إيجاد اسم عربي موثوق كنا عارفينه قبل
// كده (اتجاه آمن/متحفّظ، مش خطر إرسال غلط زي حالة farmerState). لو الأصلي تالف بنجرب النسخة
// الاحتياطية، ولو الاتنين تالفين بنبدأ بسجل فاضي (وده مش خطير هنا لأن الاسم العربي لسه
// هيتفحص عادي من أي مصدر تاني موثوق وقت الاستخدام)
function load() {
  if (!fs.existsSync(STORE_FILE) && !fs.existsSync(BACKUP_FILE) && !fs.existsSync(`${STORE_FILE}.tmp`)) {
    return {};
  }
  return readJsonSync(STORE_FILE, BACKUP_FILE, () => {
    console.log("🚨 تعذّر استرجاع نسخة سليمة من farmer_registry.json - بنبدأ بسجل فاضي.");
    return {};
  });
}

// كتابة ذرّية مع إعادة محاولة تلقائية على EPERM/EACCES/EBUSY (شوف lib/safeJsonStore.js)
function save(all) {
  writeJsonAtomicSync(STORE_FILE, BACKUP_FILE, all);
}

function getEntry(phone) {
  const key = normalizeSaudiPhone(phone);
  const all = load();
  return all[key] ? { ...all[key] } : defaultEntry(key);
}

// أولوية الاسم العربي الموثوق: 1) اسم عربي محفوظ بالفعل في السجل (ثابت - مش بيتغيّر لاسم
// عربي تاني لاحق حتى لو مصدر جديد، عشان الاستقرار ومنع أي تذبذب) 2) اسم عربي جديد من المصدر
// الحالي (Portal/System/Campaign File) لو مفيش اسم محفوظ أصلًا. ممنوع نهائيًا حفظ أو استخدام
// اسم غير عربي - لو الاسم الجديد مش عربي وما فيش اسم محفوظ، بيرجع null (يعني "غير موثوق")
function resolveTrustedArabicName(phone, candidateName) {
  const key = normalizeSaudiPhone(phone);
  const all = load();
  const existing = all[key];
  if (existing && existing.nameArabic) return existing.nameArabic;

  if (isArabicName(candidateName)) {
    const entry = existing || defaultEntry(key);
    entry.nameArabic = String(candidateName).trim();
    all[key] = entry;
    save(all);
    return entry.nameArabic;
  }
  return null;
}

// Backfill بدون أي إرسال - بيتنادى وقت قبول/رفع صفوف الحملة (مش بعد الإرسال). بيحفظ الاسم
// العربي فورًا بمجرد وجود صف صالح، عشان "سجل ..." يقدر يلاقي المزارع حتى لو الإرسال لسه ما حصلش.
// لا يزوّد totalMessages ولا يغيّر communicationStatus أبدًا (ده بس لما يحصل SENT حقيقي في
// recordSuccessfulContact) ولا يستبدل اسمًا عربيًا موثوقًا محفوظ بالفعل، ولا يحفظ اسم غير عربي
function backfillFromCampaignRow({ phone, nameArabic, campaignId, campaignPurpose, campaignLabel }) {
  const key = normalizeSaudiPhone(phone);
  if (!key) return null;
  const all = load();
  const entry = all[key] || defaultEntry(key);

  if (!entry.nameArabic && isArabicName(nameArabic)) {
    entry.nameArabic = String(nameArabic).trim();
    entry.nameSource = "CAMPAIGN";
  }

  entry.campaignId = campaignId || entry.campaignId || null;
  entry.campaignPurpose = campaignPurpose || entry.campaignPurpose || null;
  entry.campaignLabel = campaignLabel || entry.campaignLabel || null;

  all[key] = entry;
  save(all);
  return { ...entry };
}

// بيتنادى بعد نجاح إرسال فعلي بس (SENT) - مش لأي محاولة فاشلة/ممنوعة/مكررة (دي بتتسجّل في
// Audit Log بس، مش في السجل الدائم، زي ما طُلب صراحةً)
function recordSuccessfulContact({ phone, messageSource, contactReason, nameArabic }) {
  const key = normalizeSaudiPhone(phone);
  const all = load();
  const entry = all[key] || defaultEntry(key);

  if (nameArabic && !entry.nameArabic && isArabicName(nameArabic)) {
    entry.nameArabic = String(nameArabic).trim();
    entry.nameSource = entry.nameSource || "CAMPAIGN";
  }

  const now = new Date().toISOString();
  entry.communicationStatus = statusForReason(contactReason);
  entry.lastContactReason = contactReason || null;
  entry.lastMessageSource = messageSource || null;
  entry.lastContactAt = now;
  entry.totalMessages = (entry.totalMessages || 0) + 1;
  entry.communicationHistory = entry.communicationHistory || [];
  entry.communicationHistory.push({ date: now, source: messageSource || null, reason: contactReason || null, status: "SENT" });

  all[key] = entry;
  save(all);
  return { ...entry };
}

// رسالة واردة فعلية من المزارع - بتحدّث Communication Status بس، وIMPORTANT: مبتلمسش
// Farmer State إطلاقًا (بند 16 - منفصلين تمامًا)
function recordReply(phone, contactReason) {
  const key = normalizeSaudiPhone(phone);
  const all = load();
  const entry = all[key] || defaultEntry(key);
  entry.communicationStatus = "FARMER_REPLIED";
  entry.lastContactReason = contactReason || entry.lastContactReason;
  entry.lastMessageSource = "INBOUND_REPLY";
  entry.lastContactAt = new Date().toISOString();
  all[key] = entry;
  save(all);
  return { ...entry };
}

function recordHandoff(phone) {
  const key = normalizeSaudiPhone(phone);
  const all = load();
  const entry = all[key] || defaultEntry(key);
  entry.communicationStatus = "HANDED_OFF";
  entry.lastMessageSource = "INBOUND_REPLY";
  entry.lastContactReason = "HUMAN_HANDOFF";
  entry.lastContactAt = new Date().toISOString();
  all[key] = entry;
  save(all);
  return { ...entry };
}

function closeContact(phone) {
  const key = normalizeSaudiPhone(phone);
  const all = load();
  const entry = all[key] || defaultEntry(key);
  entry.communicationStatus = "CLOSED";
  all[key] = entry;
  save(all);
  return { ...entry };
}

function searchByPhone(phone) {
  const key = normalizeSaudiPhone(phone);
  const all = load();
  return all[key] ? { phone: key, ...all[key] } : null;
}

// بحث بسيط بالاسم العربي (substring، بدون تمييز حالة - أصلًا عربي فمفيش upper/lower)
function searchByName(fragment) {
  const all = load();
  const needle = String(fragment || "").trim();
  if (!needle) return [];
  return Object.entries(all)
    .filter(([, entry]) => entry.nameArabic && entry.nameArabic.includes(needle))
    .map(([phone, entry]) => ({ phone, ...entry }));
}

module.exports = {
  COMMUNICATION_STATUSES,
  COMMUNICATION_STATUS_AR,
  FARMER_STATE_AR,
  MESSAGE_SOURCE_AR,
  CONTACT_REASON_AR,
  getEntry,
  resolveTrustedArabicName,
  backfillFromCampaignRow,
  recordSuccessfulContact,
  recordReply,
  recordHandoff,
  closeContact,
  searchByPhone,
  searchByName,
  STORE_FILE,
};
