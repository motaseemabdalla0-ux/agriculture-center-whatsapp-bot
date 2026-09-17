console.log(`🚀 [بدء] السكريبت بدأ التنفيذ - ${new Date().toISOString()} - Node ${process.version}`);

const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cfg = require("./config");
const { runBroadcast } = require("./lib/broadcastRunner");
const { runPersonalizedBroadcast, fillTemplate } = require("./lib/personalizedRunner");
const { parseFarmerRows, parseCustomMessageRows, farmerRowsToCsvText } = require("./lib/fileIngest");
const campaignStore = require("./lib/campaignStore");
const { sendCampaignRows, formatSummaryText } = require("./lib/campaignRunner");
const { buildCampaignRows, summarizeCampaignRows } = require("./lib/campaignBuilder");
const {
  logEvent,
  logIncomingMessage,
  logReplyOutcome,
  logComplaint,
  getDailySummary,
  formatDailySummary,
  getKnownSenders,
  todayStr,
} = require("./lib/activityLog");
const adminStore = require("./lib/adminStore");
const staffStore = require("./lib/staffStore");
const textStore = require("./lib/textStore");
const editorStore = require("./lib/editorStore");
const driveWatcher = require("./lib/driveWatcher");
const portalSync = require("./lib/portalSync");
const codeUpdateWatcher = require("./lib/codeUpdateWatcher");
const sendLog = require("./lib/sendLog");
const sentTracker = require("./lib/sentTracker");
const { parseCsv, csvField } = require("./lib/csvUtil");
const farmerState = require("./lib/farmerState");
const ticketStore = require("./lib/ticketStore");
const sessionStore = require("./lib/sessionStore");
const rateLimiter = require("./lib/rateLimiter");
const { normalizeSaudiPhone } = require("./lib/phoneUtil");
const { version: BOT_VERSION } = require("./package.json");

// أرقام "المحررين" المسموح لهم يستخدموا كل أوامر التحكم من رقمهم هم مباشرة (مش لازم يكونوا رسائلي)
function getEditorChatIds() {
  return editorStore.getEditors().map((n) => `${n}@c.us`);
}

// بيرجع النص النشط حاليًا (المُعدَّل عبر واتساب لو موجود، وإلا الافتراضي من config.js)
function getCfgText(key) {
  return textStore.getText(cfg, key);
}

function getStaffChatIds() {
  return staffStore.getStaff().map((n) => `${n}@c.us`);
}

// أي استدعاء ممكن يعلّق للأبد (زي msg.getContact()/client.getContactById() مع معرّفات @lid -
// مشكلة معروفة في whatsapp-web.js إن الاستعلام ده أحيانًا مبيرجعش رد خالص، من غير أي خطأ ولا
// حدث unhandledRejection). ده كان بيسبب "صمت تام" - مفيش رد، مفيش لوج، مفيش حتى تحذيرنا
// التشخيصي - لأن الكود كله بعد الـawait ده كان بيفضل واقف من غير ما ينفذ خالص. بنلف أي استدعاء
// من النوع ده بمهلة (timeout) عشان لو علّق، نرجّع خطأ واضح بدل ما نستنى للأبد بصمت.
function boundedCall(label, operation, ms = 8000) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} استنى أكتر من ${ms}ms من غير رد`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// فحص احتياطي: بعض أرقام واتساب بتوصل رسايلها بصيغة معرّف مختلفة (@lid بدل @c.us) - نفس المشكلة
// اللي واجهناها قبل كده مع محادثة "رسائلي" - فلو الرقم مش متطابق بالصيغة العادية، بنجرب نجيب
// رقم الهاتف الحقيقي من جهة الاتصال (msg.getContact) ونقارنه بالأرقام المسجّلة كأرقام خام
async function matchesPhoneList(msg, phoneList) {
  if (phoneList.length === 0) return false;
  const chatId = msg.from;
  console.log(`🔎 [تحقق هوية] بدء فحص "${chatId}" مقابل قائمة (${phoneList.length} رقم)...`);
  // كل عنصر في القايمة ممكن يكون رقم خام (966...) فبنضيفله "@c.us"، أو معرّف كامل جاهز
  // (فيه "@" بالفعل - زي "...@lid") بنقارنه زي ما هو من غير أي تعديل
  if (phoneList.some((n) => (n.includes("@") ? chatId === n : chatId === `${n}@c.us`))) {
    console.log(`✅ [تحقق هوية] "${chatId}" اتطابق مباشرة.`);
    return true;
  }
  if (!chatId.endsWith("@lid")) {
    console.log(`ℹ️ [تحقق هوية] "${chatId}" مش @lid ومطابقش مباشرة - مش من القائمة.`);
    return false;
  }
  // لو الصيغة @lid ومفيش تطابق مباشر، بنجرب نجيب رقم الهاتف الحقيقي من جهة الاتصال - ده مش
  // مضمون يشتغل دايمًا لأن معرّف @lid في واتساب أحيانًا مالوش تعيين معروف لرقم هاتف حقيقي
  // (السبب اللي خلانا نضيف دعم تسجيل المعرّف الكامل @lid مباشرة كبديل موثوق أكتر)
  try {
    const contact = await boundedCall("sender-contact", () => msg.getContact());
    const rawNumber =
      (contact && contact.number) ||
      ((contact && contact.id && contact.id._serialized) || "").replace(/@.*/, "");
    const matched = !!rawNumber && phoneList.includes(rawNumber);
    console.log(`${matched ? "✅" : "ℹ️"} [تحقق هوية] رقم @lid "${chatId}" -> "${rawNumber || "؟"}" (${matched ? "متطابق" : "مش متطابق"})`);
    return matched;
  } catch (err) {
    console.log(`⚠️ [تحقق هوية] تعذّر التحقق من رقم المرسل (صيغة @lid): ${err.message}`);
    return false;
  }
}

// بيتأكد إن الرسالة فعليًا محادثة "رسائلي" (البوت بيبعتها لنفسه)، مش أي رسالة صادرة لمستلم
// تاني معرّفه بالصدفة بصيغة @lid
async function isTrueSelfChat(msg) {
  if (msg.to === msg.from) return true;
  if (!msg.to || !msg.to.endsWith("@lid")) return false;
  try {
    const contact = await boundedCall("self-contact", () => client.getContactById(msg.to));
    return !!(contact && contact.isMe);
  } catch (err) {
    console.log(`⚠️ [رسائلي] تعذّر التحقق من هوية المستلم: ${err.message}`);
    return false;
  }
}

// واتساب بقى بيفصل أحيانًا نفس الشخص لمعرّفين مختلفين: معرّف @lid بتوصل بيه رسايله الواردة،
// ومعرّف @c.us عادي بنستخدمه إحنا لما نبعتله رسالة (حملة زي "استلام البطاقة"). التطبيق نفسه
// بيوري الاتنين كمحادثة واحدة مدموجة بصريًا، بس كودنا كان بيتعامل مع الرسالة الواردة بصيغة @lid
// كأنها من شخص جديد تمامًا (جلسة جديدة تبدأ من الصفر وترد بالقائمة الرئيسية)، حتى لو المزارع
// ده استلم فعلاً رسالة حملة على رقمه شوية قبل كده - فكان بيظهر وكأن البوت بعت "رسالة ترحيب"
// زيادة من غير داعي. هنا بنحاول نرجّع رقم الهاتف الحقيقي ونستخدمه كمعرّف موحّد للجلسة والسجلات
async function resolveCanonicalChatId(msg) {
  const chatId = msg.from;
  if (!chatId.endsWith("@lid")) return chatId;
  try {
    const contact = await boundedCall("resolve-canonical-id", () => msg.getContact());
    const rawNumber =
      (contact && contact.number) ||
      ((contact && contact.id && contact.id._serialized) || "").replace(/@.*/, "");
    if (rawNumber && /^\d{8,15}$/.test(rawNumber)) return `${rawNumber}@c.us`;
  } catch (err) {
    console.log(`⚠️ [توحيد الهوية] تعذّر ترجمة معرّف @lid لرقم حقيقي: ${err.message}`);
  }
  return chatId;
}

async function isEditorMessage(msg) {
  return matchesPhoneList(msg, editorStore.getEditors());
}

async function isAdminMessage(msg) {
  const staticAdmins = cfg.ADMIN_NUMBERS || [];
  const dynamicAdmins = adminStore.getAdmins();
  const allAdmins = [...new Set([...staticAdmins, ...dynamicAdmins])];
  return matchesPhoneList(msg, allAdmins);
}

// بيبعت تنبيه فوري لكل موظفي الخدمة لما مزارع يختار "التواصل مع موظف"
async function notifyStaff(farmerChatId, withinHours) {
  const staffChatIds = getStaffChatIds();
  if (staffChatIds.length === 0) return;

  const farmerNumber = farmerChatId.replace("@c.us", "");
  const timeNow = new Date().toLocaleString("ar-SA");
  const statusLine = withinHours ? "" : "\n⏰ الرسالة وصلت برة أوقات الدوام.";
  const text = `🔔 مزارع جديد محتاج مساعدة\n\n📱 الرقم: ${farmerNumber}\n🕒 الوقت: ${timeNow}${statusLine}`;

  for (const chatId of staffChatIds) {
    try {
      await client.sendMessage(chatId, text);
    } catch (err) {
      console.log(`⚠️ فشل تنبيه الموظف ${chatId}: ${err.message}`);
    }
  }
}

// أرقام المديرين المسموح لهم يطلبوا التقرير ويستقبلوه (ثابتين من config.js + مضافين ديناميكيًا عبر واتساب)
function getAdminChatIds() {
  const staticAdmins = cfg.ADMIN_NUMBERS || [];
  const dynamicAdmins = adminStore.getAdmins();
  const merged = [...new Set([...staticAdmins, ...dynamicAdmins])];
  // عناصر فيها "@" بالفعل (زي معرّف @lid كامل) بتتسيب زي ما هي، والأرقام العادية بتاخد "@c.us"
  return merged.map((n) => (n.includes("@") ? n : `${n}@c.us`));
}

const REPORT_HOUR = 20; // الساعة اللي بيتبعت فيها التقرير اليومي تلقائيًا (بتوقيت الجهاز)
let lastReportSentDate = null;

const TRIGGER_FILE = path.join(__dirname, "SEND_NOW.txt");
const REGISTRATION_TRIGGER_FILE = path.join(__dirname, "SEND_REGISTRATION_STATUS.txt");
const CARD_PICKUP_TRIGGER_FILE = path.join(__dirname, "SEND_CARD_PICKUP.txt");
const DOCUMENTS_TRIGGER_FILE = path.join(__dirname, "SEND_DOCUMENTS_REQUEST.txt");
const INVITATION_TRIGGER_FILE = path.join(__dirname, "SEND_REGISTRATION_INVITATION.txt");
const DRAFT_TRIGGER_FILE = path.join(__dirname, "SEND_DRAFT_FORMS.txt");
const CUSTOM_MESSAGE_TRIGGER_FILE = path.join(__dirname, "SEND_CUSTOM_MESSAGE.txt");
let broadcastInProgress = false;

// حالة كل محادثة محفوظة في الذاكرة (تتصفر عند إعادة تشغيل البوت)
// STATE: 'MENU' | 'AWAITING_COMPLAINT' | 'HANDED_OFF'
const sessions = new Map();

// معرّفات آخر الرسائل اللي البوت رد عليها، عشان منردش على نفس الرسالة مرتين
const recentlyProcessedMessageIds = new Set();

// بيأجّل الرد على المزارع لحد ما يهدى إرسال الرسائل منه لفترة قصيرة (DEBOUNCE_MS)
// ده بيحل مشكلة إن البوت لما يرجع أونلاين بعد انقطاع، واتساب بيبعتله كل الرسائل اللي
// اتجمعت وقت الانقطاع دفعة واحدة، وكان بيرد على كل واحدة فيهم لوحدها بدل ما يرد مرة واحدة بس
const farmerMessageDebounce = new Map();
const FARMER_DEBOUNCE_MS = 4000;

// بيحوّل الأرقام العربية (٠١٢٣٤٥٦٧٨٩) والفارسية (۰۱۲۳۴۵۶۷۸۹) لأرقام إنجليزية
// عشان المزارع يقدر يبعت "١" أو "1" ويشتغلوا بنفس الشكل بالظبط
function toWesternDigits(str) {
  return str
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    // HANDED_OFF محفوظة بشكل دائم (مش بس في الذاكرة) - لو البوت اتقفل وإتشغل تاني وسط
    // محادثة متحوّلة لموظف، الجلسة الجديدة لازم تبدأ HANDED_OFF برضه مش MENU من الصفر
    const initialState = sessionStore.isHandedOff(chatId) ? "HANDED_OFF" : "MENU";
    sessions.set(chatId, { state: initialState });
  }
  return sessions.get(chatId);
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    // فلاجات بتقلل احتمال تعليق Chrome وقت الفتح، خصوصًا على جهاز رامه شبه ممتلئة باستمرار
    // (لاحظنا الجهاز شغال على 90%+ رام معظم الوقت بسبب عمليات Chrome عالقة من تشغيلات قديمة)
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
});

// حماية: بعض تحديثات واتساب ويب بتكسر مكتبة whatsapp-web.js مؤقتًا
// (مشكلة معروفة وموثقة في المكتبة نفسها، مش في كودنا) وبتسبب كراش كامل للبوت.
// السطرين دول بيمنعوا أي خطأ غير متوقع من إيقاف العملية بالكامل.
process.on("unhandledRejection", (err) => {
  console.log(`⚠️ خطأ غير متوقع (تم تجاهله عشان البوت يفضل شغال): ${err.message}`);
});
process.on("uncaughtException", (err) => {
  console.log(`⚠️ خطأ غير متوقع (تم تجاهله عشان البوت يفضل شغال): ${err.message}`);
});

// نسخة آمنة من الرد بترجع false لو فشلت بدل ما توقف البوت كله
async function safeReply(msg, text) {
  try {
    await msg.reply(text);
    return true;
  } catch (err) {
    console.log(`⚠️ فشل إرسال رد (مشكلة معروفة في مكتبة whatsapp-web.js حاليًا): ${err.message}`);
    return false;
  }
}

client.on("qr", (qr) => {
  console.log("امسح رمز QR ده بواتساب (الأجهزة المرتبطة > ربط جهاز):");
  qrcode.generate(qr, { small: true });
});

// لو حصل انقطاع في الاتصال (نت اتقطع، الكهربا رجعت، جلسة واتساب اتلغت...)
// أضمن حاجة إن البوت يقفل نفسه، وPM2 هيرجّعه يشتغل تلقائيًا من الصفر بعد ثواني
client.on("disconnected", (reason) => {
  console.log(`⚠️ انقطع الاتصال بواتساب (${reason}). البوت هيتقفل عشان PM2 يرجّعه يشتغل تلقائيًا...`);
  process.exit(1);
});

// أحداث تشخيصية إضافية - عشان لو مرحلة التشغيل الأولى (فتح Chrome/تحميل واتساب ويب) علّقت أو
// فشلت، يبقى عندنا أثر واضح في اللوج بدل الصمت التام (اللي كان بيحصل قبل كده من غير أي سبب واضح)
client.on("loading_screen", (percent, message) => {
  console.log(`⏳ [تحميل واتساب ويب] ${percent}% - ${message}`);
});
client.on("auth_failure", (msg) => {
  console.log(`🚨 [فشل تسجيل الدخول] ${msg}`);
});

// حماية: لو "ready" ما وصلتش خلال المهلة دي من بدء التشغيل، يبقى فيه تعليق حقيقي
// (زي مشكلة تشغيل Chrome) - نقفل العملية بنفسنا عشان PM2 يرجّعها من الصفر، بدل ما تفضل
// واقفة للأبد من غير أي رد أو أثر (وده بالظبط اللي كان بيحصل قبل الإصلاح ده)
const READY_TIMEOUT_MS = 120000;
const readyTimeout = setTimeout(() => {
  console.log(
    `🚨 [مهلة الاتصال] البوت ما اتصلش بواتساب خلال ${READY_TIMEOUT_MS / 1000} ثانية من بدء التشغيل - ` +
      `غالبًا مشكلة في تشغيل Chrome (عمليات عالقة/قلة رام/ملف قفل). هيتقفل عشان PM2 يرجّعه من جديد.`
  );
  process.exit(1);
}, READY_TIMEOUT_MS);
client.on("ready", () => clearTimeout(readyTimeout));

// Heartbeat بسيط لنظام تحديث GitHub (updater/healthCheck.js) - بيكتب وقت + إصدار كل فترة قصيرة
// طول ما البوت شغّال ومتصل، عشان أي تحديث كود لاحق يقدر يتأكد إن البوت "صحي" فعليًا بعد إعادة
// التشغيل بدل ما يفترض كده بس لمجرد إن العملية بدأت. ملف بيانات تشغيلي بحت - مالوش أي علاقة
// بمنطق الأمان أو حالة المزارعين، ومحمي من التحديثات زي باقي ملفات البيانات
const HEARTBEAT_FILE = path.join(__dirname, "bot_heartbeat.json");
function writeHeartbeat() {
  try {
    fs.writeFileSync(
      HEARTBEAT_FILE,
      JSON.stringify({ pid: process.pid, version: BOT_VERSION, updatedAt: new Date().toISOString() }),
      "utf8"
    );
  } catch {
    // فشل كتابة الـHeartbeat مش سبب كافي نوقف أي حاجة تانية
  }
}

client.on("ready", () => {
  console.log("✅ البوت شغّال ومتصل بواتساب.");
  writeHeartbeat();
  setInterval(writeHeartbeat, 30000);
  console.log(
    `📢 للبث الجماعي (رسالة واحدة للكل): حدّث numbers.txt و message.txt ثم شغّل npm run send-now`
  );
  console.log(
    `📋 لحالة التسجيل (رسالة مخصصة لكل مزارع): حدّث registration_status.csv ثم شغّل npm run send-registration-status`
  );
  console.log(
    `🎫 لإشعار استلام البطاقة: حدّث card_pickup.csv ثم شغّل npm run send-card-pickup`
  );
  console.log(
    `📄 لطلب مستندات: حدّث documents_request.csv ثم شغّل npm run send-documents-request`
  );
  console.log(
    `✉️ لدعوة التسجيل: حدّث registration_invitation.csv ثم شغّل npm run send-registration-invitation`
  );
  console.log(
    `✍️ لرسالة مخصصة لكل مزارع (نصه الخاص): حدّث custom_message.csv ثم شغّل npm run send-custom-message`
  );
  driveWatcher.ensureFolders();
  codeUpdateWatcher.ensureFolders();
  console.log(`📂 مجلد المزامنة: ${driveWatcher.DRIVE_ROOT}`);
  console.log(
    `   حط أي ملف في مجلد "تسجيل" أو "استلام" أو "طلب مستندات" أو "دعوة للتسجيل" وهيتبعت تلقائيًا خلال ثواني.`
  );
  console.log(
    `🛠️ لتحديث الكود بدون وصول للسيرفر: حط الملف المحدّث في مجلد "تحديث الكود" وهيتطبّق ويعيد التشغيل تلقائيًا.`
  );
  if (portalSync.isConfigured()) {
    console.log("🔗 نظام البطاقات متصل - هيتفحص دوريًا وهيبعت الرسائل تلقائيًا لأي جديد.");
  } else {
    console.log('ℹ️ عايز ربط نظام البطاقات تلقائيًا؟ انسخ portal_config.example.js لـ portal_config.js واملأ بياناتك.');
  }
  watchForTriggers();
});

const REGISTRATION_CSV = path.join(__dirname, "registration_status.csv");
const CARD_PICKUP_CSV = path.join(__dirname, "card_pickup.csv");
const DOCUMENTS_REQUEST_CSV = path.join(__dirname, "documents_request.csv");
const REGISTRATION_INVITATION_CSV = path.join(__dirname, "registration_invitation.csv");
const DRAFT_FORMS_CSV = path.join(__dirname, "draft_forms.csv");
const CUSTOM_MESSAGE_CSV = path.join(__dirname, "custom_message.csv");

// تصنيف الرسائل: registration_status/card_pickup/documents_request = SYSTEM_NOTIFICATION (إشعار
// تلقائي لمزارع بعينه بسبب تغيّر حالة طلبه الفعلية في البوابة - "الطلب تحت المراجعة"/"البطاقة
// جاهزة"/"استكمل مستنداتك") - ما بتدخلش تحت حصة الـ500/يوم و50/ساعة الخاصة بالحملات، ومتتوقفش
// لو Campaign Queue واقفة. registration_invitation/draft_reminder = CAMPAIGN (دعوة/تذكير جماعي
// لكل مين لسه ما سجّلش، مش رد فعل لحدث فردي) - بتدخل تحت نفس الحصة زي أي حملة تانية.
async function sendRegistrationStatusBroadcast() {
  await runPersonalizedBroadcast(client, {
    csvPath: REGISTRATION_CSV,
    columns: ["name", "phone", "request_number"],
    template: getCfgText("REGISTRATION_STATUS_TEMPLATE"),
    logFile: path.join(__dirname, "registration-status-log.txt"),
    logLabel: "حالة التسجيل",
    campaignType: "registration_status",
    messageSource: "SYSTEM_NOTIFICATION",
  });
}

async function sendCardPickupBroadcast() {
  await runPersonalizedBroadcast(client, {
    csvPath: CARD_PICKUP_CSV,
    columns: ["name", "phone"],
    template: getCfgText("CARD_PICKUP_TEMPLATE"),
    logFile: path.join(__dirname, "card-pickup-log.txt"),
    logLabel: "استلام البطاقة",
    campaignType: "card_pickup",
    messageSource: "SYSTEM_NOTIFICATION",
  });
}

async function sendDocumentsRequestBroadcast() {
  await runPersonalizedBroadcast(client, {
    csvPath: DOCUMENTS_REQUEST_CSV,
    columns: ["name", "phone"],
    template: getCfgText("DOCUMENTS_REQUEST_TEMPLATE"),
    logFile: path.join(__dirname, "documents-request-log.txt"),
    logLabel: "طلب مستندات",
    campaignType: "documents_request",
    messageSource: "SYSTEM_NOTIFICATION",
  });
}

async function sendRegistrationInvitationBroadcast() {
  const template = getCfgText("REGISTRATION_INVITATION_TEMPLATE").replace(
    "{link}",
    getCfgText("REGISTRATION_LINK")
  );
  await runPersonalizedBroadcast(client, {
    csvPath: REGISTRATION_INVITATION_CSV,
    columns: ["name", "phone"],
    template,
    logFile: path.join(__dirname, "registration-invitation-log.txt"),
    logLabel: "دعوة للتسجيل",
    campaignType: "registration_invitation",
    messageSource: "CAMPAIGN",
  });
}

async function sendDraftFormsBroadcast() {
  const template = getCfgText("DRAFT_REMINDER_TEMPLATE").replace("{link}", getCfgText("REGISTRATION_LINK"));
  return runPersonalizedBroadcast(client, {
    csvPath: DRAFT_FORMS_CSV,
    columns: ["name", "phone", "request_number"],
    template,
    logFile: path.join(__dirname, "draft-forms-log.txt"),
    logLabel: "تذكير درافت",
    campaignType: "draft_reminder",
    messageSource: "CAMPAIGN",
  });
}

async function sendCustomMessageBroadcast() {
  await runPersonalizedBroadcast(client, {
    csvPath: CUSTOM_MESSAGE_CSV,
    columns: ["name", "phone", "message"],
    template: getCfgText("CUSTOM_MESSAGE_TEMPLATE"),
    logFile: path.join(__dirname, "custom-message-log.txt"),
    logLabel: "رسالة مخصصة",
    // ملاحظة: مفيش campaignType هنا عمدًا - كل رسالة مخصصة ليها نصها الخاص، فمنعتبرش "نفس الحملة"
    // زي باقي الأنواع، عشان لو بعت رسالة مخصصة تانية لنفس الرقم تتبعت عادي
  });
}

// بيعمل دورة مزامنة واحدة مع نظام البطاقات (بطاقات جاهزة + طلبات جديدة + درافت)
// بطلب من الإدارة: البطاقات الجاهزة وحالة الطلب (الرفيو) من غير أي حد أقصى - يبعتوا لكل الموجودين كل مرة.
// الدرافت وحدها عليها حد أقصى يومي (10 مزارعين) لأن عددها كبير جدًا (185+) ومحتاجة تحكم تدريجي.
// بيرجع ملخص نصي للنتيجة
async function runPortalSyncOnce() {
  const summary = { printed: 0, pending: 0, draft: 0 };

  // بطلب من الإدارة: رسائل البطاقات الجاهزة والرفيو (الطلبات الجديدة) تبدأ من تاريخ محدد (صباح الغد وقت الطلب)
  // ومفلترة بتاريخ حديث أيضًا (شوف PORTAL_START_DATE في portalSync.js) - الدرافت وحدها معفاة من الشرط ده
  const pastStartDate = portalSync.isPastStartDate();
  let cardKeys = new Set();
  let reviewKeys = new Set();

  if (pastStartDate) {
    // 1) قسم البطاقات الجاهزة (الأولوية الأولى) - بدون حد أقصى
    const printedResult = await portalSync.syncPrintedCards(Infinity);
    cardKeys = portalSync.buildKeySet(printedResult.rows); // مفاتيح جوال+هوية لكل مزارع في قسم البطاقات
    if (printedResult.count > 0) {
      await sendCardPickupBroadcast();
      summary.printed = printedResult.count;
    }

    // 2) قسم الرفيو/الطلبات الجديدة (الأولوية الثانية) - بدون حد أقصى، ويستبعد أي حد أصلًا في قسم البطاقات
    const pendingResult = await portalSync.syncPendingPrintingRequests(Infinity, cardKeys);
    reviewKeys = portalSync.buildKeySet(pendingResult.rows);
    if (pendingResult.count > 0) {
      await sendRegistrationStatusBroadcast();
      summary.pending = pendingResult.count;
    }
  }

  // 3) قسم الدرافت (الأولوية الأخيرة) - الوحيدة اللي عليها حد أقصى يومي، ويستبعد أي حد أصلًا في البطاقات أو الرفيو
  const remaining = portalSync.getRemainingQuota();
  if (remaining > 0) {
    const excludeForDraft = new Set([...cardKeys, ...reviewKeys]);
    const draftResult = await portalSync.syncDraftForms(remaining, excludeForDraft);
    if (draftResult.count > 0) {
      const sendSummary = await sendDraftFormsBroadcast();
      // بنستهلك الحصة بعدد اللي "اتبعتله فعلًا" (sent) بس، مش عدد الصفوف اللي كانت في الملف -
      // لو فشل نص الإرسال (رقم مش على واتساب، خطأ شبكة...) مش عادل نحسبهم كأنهم استهلكوا الحصة
      const actuallySent = (sendSummary && sendSummary.sent) || 0;
      portalSync.addToTodayCount(actuallySent);
      summary.draft = actuallySent;
    }
  }

  const startNote = pastStartDate
    ? ""
    : `\n(ملاحظة: البطاقات الجاهزة والرفيو لسه ما بدأوش - هيبدأوا تلقائيًا من ${portalSync.PORTAL_START_DATE.toLocaleDateString("ar-SA")})`;
  const draftNote = remaining <= 0 ? " (وصلنا للحد اليومي للدرافت، هيكمل بكرة)" : "";
  return `✅ تمت المزامنة: ${summary.printed} بطاقة جاهزة، ${summary.pending} طلب جديد، ${summary.draft} درافت${draftNote}. راجع pm2 logs للتفاصيل.${startNote}`;
}

// بيدخل نظام البطاقات (لو متظبّط) كل CHECK_INTERVAL_MINUTES تلقائيًا
let lastPortalSyncAt = 0;
async function maybeSyncPortal() {
  if (!portalSync.isConfigured()) return;

  const cfgIntervalMinutes = (() => {
    try {
      return require("./portal_config").CHECK_INTERVAL_MINUTES || 60;
    } catch {
      return 60;
    }
  })();

  const now = Date.now();
  if (now - lastPortalSyncAt < cfgIntervalMinutes * 60 * 1000) return;
  lastPortalSyncAt = now;

  await runExclusive("نظام البطاقات", async () => {
    const resultText = await runPortalSyncOnce();
    console.log(`🔄 [نظام البطاقات] ${resultText}`);
  });
}

// نفّذ مهمة بث (بث عادي / حالة تسجيل / استلام بطاقة) مع قفل عشان منشغلش أكتر من مهمة في نفس الوقت
async function runExclusive(label, fn) {
  if (broadcastInProgress) return false;
  broadcastInProgress = true;
  try {
    await fn();
  } catch (err) {
    console.log(`❌ [${label}] حصل خطأ: ${err.message}`);
  } finally {
    broadcastInProgress = false;
  }
  return true;
}

function watchForTriggers() {
  // نتأكد كل ثانيتين هل أي ملف تريجر اتعمل، بدل fs.watch اللي بيختلف سلوكه بين الأنظمة
  setInterval(async () => {
    if (broadcastInProgress) return;

    // فحص مجلد "تحديث الكود" جوه درايف المزامَن الأول قبل أي حاجة تانية
    // لو فيه تحديث، نطبّقه ونعيد تشغيل البوت فورًا (PM2 هيرجّعه يشتغل بالكود الجديد تلقائيًا)
    const codeUpdate = codeUpdateWatcher.applyPendingUpdates();
    if (codeUpdate.updated) {
      console.log(`🔄 [تحديث الكود] اتطبّق: ${codeUpdate.applied.join(", ")}`);
      if (codeUpdate.skipped.length > 0) {
        console.log(`⚠️ [تحديث الكود] اتجاهل: ${codeUpdate.skipped.join(", ")}`);
      }
      console.log("🔄 [تحديث الكود] البوت هيعيد تشغيل نفسه دلوقتي عشان الكود الجديد يشتغل...");
      process.exit(0);
    }

    if (fs.existsSync(TRIGGER_FILE)) {
      fs.unlinkSync(TRIGGER_FILE);
      await runExclusive("بث", () => runBroadcast(client));
      return;
    }

    if (fs.existsSync(REGISTRATION_TRIGGER_FILE)) {
      fs.unlinkSync(REGISTRATION_TRIGGER_FILE);
      await runExclusive("حالة التسجيل", sendRegistrationStatusBroadcast);
      return;
    }

    if (fs.existsSync(CARD_PICKUP_TRIGGER_FILE)) {
      fs.unlinkSync(CARD_PICKUP_TRIGGER_FILE);
      await runExclusive("استلام البطاقة", sendCardPickupBroadcast);
      return;
    }

    if (fs.existsSync(DOCUMENTS_TRIGGER_FILE)) {
      fs.unlinkSync(DOCUMENTS_TRIGGER_FILE);
      await runExclusive("طلب مستندات", sendDocumentsRequestBroadcast);
      return;
    }

    if (fs.existsSync(INVITATION_TRIGGER_FILE)) {
      fs.unlinkSync(INVITATION_TRIGGER_FILE);
      await runExclusive("دعوة للتسجيل", sendRegistrationInvitationBroadcast);
      return;
    }

    if (fs.existsSync(DRAFT_TRIGGER_FILE)) {
      fs.unlinkSync(DRAFT_TRIGGER_FILE);
      await runExclusive("تذكير درافت", sendDraftFormsBroadcast);
      return;
    }

    if (fs.existsSync(CUSTOM_MESSAGE_TRIGGER_FILE)) {
      fs.unlinkSync(CUSTOM_MESSAGE_TRIGGER_FILE);
      await runExclusive("رسالة مخصصة", sendCustomMessageBroadcast);
      return;
    }

    // فحص مجلد درايف المزامَن (drive_incoming) لأي ملف جديد اتحط في أي من المجلدات الأربعة
    const incoming = driveWatcher.processNextIncomingFile();
    if (incoming) {
      const typeLabels = {
        registration: ["حالة التسجيل", sendRegistrationStatusBroadcast],
        pickup: ["استلام البطاقة", sendCardPickupBroadcast],
        documents: ["طلب مستندات", sendDocumentsRequestBroadcast],
        invitation: ["دعوة للتسجيل", sendRegistrationInvitationBroadcast],
      };
      const [label, sendFn] = typeLabels[incoming.type] || [];

      if (incoming.count === 0) {
        console.log(`⚠️ [درايف] الملف "${incoming.fileName}" مفيهوش بيانات صحيحة، اتجاهل.`);
      } else if (sendFn) {
        console.log(`📥 [درايف] استلمت "${incoming.fileName}" (${incoming.count} مزارع) لـ${label}، بدء الإرسال...`);
        const started = await runExclusive(label, sendFn);
        // بننقل الملف لـ"تمت المعالجة" بس لو الإرسال فعلًا بدأ - لو فيه عملية تانية شغالة
        // (started=false) بننقله لـ"فشل الإرسال" عشان تقدر تعيد محاولته بدل ما يضيع في الأرشيف
        driveWatcher.finalizeIncomingFile(incoming.processingPath, started);
        if (!started) {
          console.log(
            `⚠️ [درايف] "${incoming.fileName}" اتنقل لمجلد "فشل الإرسال" - كان فيه عملية إرسال تانية شغالة. انقله لمجلد المصدر تاني عشان يعاد محاولته.`
          );
        }
      }
      return;
    }

    await maybeSyncPortal();
    // ملحوظة: التقرير التلقائي متوقف بطلب الإدارة - المديرين هم اللي بيطلبوه يدويًا بكتابة "تقرير"
    // (الدالة maybeSendDailyReport باقية تحت من غير استدعاء، لو حبينا نرجّعها تاني في المستقبل)
  }, 2000);
}

// بيبعت تقرير النشاط اليومي تلقائيًا لـ"رسائلي" + كل أرقام المديرين، مرة واحدة كل يوم الساعة REPORT_HOUR
// (متوقفة حاليًا - شوف الملحوظة فوق. التقرير دلوقتي بيتطلب يدويًا بس بكتابة "تقرير")
async function maybeSendDailyReport() {
  const now = new Date();
  const today = todayStr(now);
  if (lastReportSentDate === today) return;
  if (now.getHours() < REPORT_HOUR) return;

  lastReportSentDate = today;
  const summary = getDailySummary(now);
  const text = formatDailySummary(summary);
  const selfChatId = client.info.wid._serialized;
  const recipients = adminStore.isSelfReportEnabled()
    ? [selfChatId, ...getAdminChatIds()]
    : getAdminChatIds();

  for (const chatId of recipients) {
    try {
      await client.sendMessage(chatId, text);
    } catch (err) {
      console.log(`⚠️ فشل إرسال التقرير اليومي لـ ${chatId}: ${err.message}`);
    }
  }
  console.log(`📊 اتبعت التقرير اليومي تلقائيًا (${today}).`);
}

// بيعالج رسالة مزارع واحدة فعليًا (آخر رسالة في أي مجموعة رسائل متتالية بعد ما تهدى - شوف الـdebounce تحت)
async function processFarmerMessage(msg) {
  // بنستخدم المعرّف الموحّد (رقم الهاتف الحقيقي لو اتترجم من @lid) بدل msg.from الخام - عشان
  // نفس المزارع يفضل بنفس الجلسة/السجل حتى لو رسايله بتوصل أحيانًا بصيغة @lid وأحيانًا @c.us
  const chatId = msg._canonicalChatId || msg.from;
  const text = toWesternDigits((msg.body || "").trim());

  // اسم واتساب الظاهر (notifyName) متاح مباشرة من بيانات الرسالة من غير أي استدعاء إضافي -
  // بنسجّله عشان أمر "كل الارقام" يقدر يعرض اسم حتى المزارعين اللي كلّموا البوت من نفسهم
  const displayName = (msg._data && msg._data.notifyName) || "";
  logIncomingMessage(chatId, displayName);
  const session = getSession(chatId);
  let replied = false;

  // إرسال 0 (أو "قائمة"/"menu") يرجع المستخدم للقائمة الرئيسية في أي وقت
  if (/^(0|قائمة|menu|القائمة)$/i.test(text)) {
    session.state = "MENU";
    replied = await safeReply(msg, getCfgText("MAIN_MENU"));
    logReplyOutcome(chatId, replied);
    return;
  }

  switch (session.state) {
    case "MENU": {
      if (text === "1") {
        replied = await safeReply(
          msg,
          `للتسجيل في بطاقة المزرعة، يرجى الدخول إلى رابط التسجيل التالي وإكمال البيانات المطلوبة:\n\n🔗 ${getCfgText(
            "REGISTRATION_LINK"
          )}`
        );
        session.state = "MENU";
        logEvent("choice_1", chatId);
      } else if (text === "2") {
        const withinHours = staffStore.isWithinWorkingHours();
        const handoffText = withinHours
          ? getCfgText("HUMAN_HANDOFF")
          : getCfgText("HUMAN_HANDOFF_OUT_OF_HOURS")
              .replace("{start}", staffStore.minutesToHHMM(staffStore.getState().workingHours.startMinutes))
              .replace("{end}", staffStore.minutesToHHMM(staffStore.getState().workingHours.endMinutes));
        replied = await safeReply(msg, handoffText);
        session.state = "HANDED_OFF";
        sessionStore.setHandedOff(chatId); // تخزين دائم - إعادة تشغيل البوت متلغيش التحويل
        logEvent("choice_2", chatId);
        notifyStaff(chatId, withinHours);
      } else if (text === "3") {
        replied = await safeReply(
          msg,
          "يرجى اختيار نوع طلبكم:\n\n1. شكوى\n2. استفسار\n3. اقتراح\n4. الرجوع إلى القائمة الرئيسية"
        );
        session.state = "AWAITING_TICKET_CATEGORY";
        logEvent("choice_3", chatId);
      } else {
        replied = await safeReply(msg, getCfgText("MAIN_MENU"));
        logEvent("invalid_choice", chatId);
      }
      break;
    }

    // اختيار صريح للنوع من قائمة ثابتة - مفيش استنتاج Category من كلمات نص المزارع خالص
    case "AWAITING_TICKET_CATEGORY": {
      const TICKET_CATEGORY_MAP = { 1: "COMPLAINT", 2: "INQUIRY", 3: "SUGGESTION" };
      if (text === "4") {
        session.state = "MENU";
        replied = await safeReply(msg, getCfgText("MAIN_MENU"));
      } else if (TICKET_CATEGORY_MAP[text]) {
        session.ticketCategory = TICKET_CATEGORY_MAP[text];
        replied = await safeReply(msg, getCfgText("COMPLAINT_INTRO"));
        session.state = "AWAITING_TICKET_TEXT";
      } else {
        replied = await safeReply(msg, "يرجى اختيار رقم صحيح:\n\n1. شكوى\n2. استفسار\n3. اقتراح\n4. الرجوع إلى القائمة الرئيسية");
      }
      break;
    }

    case "AWAITING_TICKET_TEXT": {
      // أي رسالة تعتبر تفاصيل الطلب المطلوبة - بتتحفظ كـTicket حقيقي بمعرّف مرجعي، بـCategory
      // اترختار صراحةً في الخطوة اللي فاتت (مش استنتاج من نص الرسالة دي خالص)
      logComplaint(chatId, msg.body); // نسيبها كمان كنسخة CSV بسيطة للتوافق مع أي استخدام قديم
      logEvent("complaint_submitted", chatId);
      const ticket = ticketStore.createTicket({
        farmerName: displayName,
        phone: chatId.replace(/@.*/, ""),
        category: session.ticketCategory || "COMPLAINT",
        message: msg.body || "",
      });
      replied = await safeReply(
        msg,
        `${getCfgText("COMPLAINT_THANKS")}\n\n📋 رقم مرجعي: ${ticket.ticket_id}`
      );
      session.state = "MENU";
      delete session.ticketCategory;
      break;
    }

    case "HANDED_OFF": {
      // البوت لا يرد تلقائيًا بعد التحويل لموظف بشري (يُحتسب كمحادثة لم يتم الرد عليها آليًا)
      replied = false;
      break;
    }

    default: {
      session.state = "MENU";
      replied = await safeReply(msg, getCfgText("MAIN_MENU"));
    }
  }

  logReplyOutcome(chatId, replied);
}

client.on("message", async (msg) => {
  // أول سطر في الهاندلر بالكامل - لو الحدث ده مش ظاهر في اللوج خالص لرسالة معينة، يبقى الحدث
  // نفسه مش وصل من واتساب ويب أصلًا (مش مشكلة في كودنا بعد كده) - مفيد جدًا للتشخيص السريع
  console.log(`📩 [message] وصلت رسالة من ${msg.from} (fromMe=${msg.fromMe})`);
  // تجاهل أي رسالة اتبعتت من رقم البوت نفسه - واتساب ويب أحيانًا (مشكلة معروفة مع الأجهزة
  // المرتبطة/multi-device) بيبعت حدث "message" حتى للرسائل اللي البوت نفسه بعتها (زي رسائل
  // الحملات: استلام البطاقة، تذكير الدرافت...إلخ) مش بس الرسائل الواردة فعلاً. من غير الفلتر ده
  // كان بيحصل إن البوت يستقبل نص رسالته هو نفسه كأنه رسالة من المزارع، ما يطابقش أي خيار من القائمة،
  // فيرد عليه بالقائمة الرئيسية فورًا بعد ما يبعتله رسالة الحملة - من غير ما المزارع يكتب أي حاجة.
  if (msg.fromMe) return;

  // تجاهل رسائل المجموعات - البوت يرد على المحادثات الفردية فقط
  // (نتأكد من شكل الرقم مباشرة بدل msg.getChat() اللي بتفشل حاليًا
  // بسبب نفس مشكلة تحديث واتساب ويب اللي كسرت إرسال الردود)
  if (msg.from.endsWith("@g.us")) return;

  // حماية ضد ازدواج حدث "message" (مشكلة معروفة حاليًا في واتساب ويب بتبعت نفس الرسالة مرتين أحيانًا)
  // بنستخدم (المرسل + الوقت + أول جزء من النص) كمعرّف بديل، لأن msg.id نفسه بقى غير موثوق بسبب نفس مشكلة تحديث واتساب
  const msgId = `${msg.from}|${msg.timestamp}|${(msg.body || "").slice(0, 50)}`;
  if (recentlyProcessedMessageIds.has(msgId)) return;
  recentlyProcessedMessageIds.add(msgId);
  if (recentlyProcessedMessageIds.size > 500) {
    const oldest = recentlyProcessedMessageIds.values().next().value;
    recentlyProcessedMessageIds.delete(oldest);
  }

  const chatId = msg.from;
  const text = toWesternDigits((msg.body || "").trim());

  // أرقام المحررين ليهم كل أوامر التحكم (تعديل النصوص/الدوام/الموظفين...) من رقمهم هم مباشرة
  // (مش بيتأجلوا بالـdebounce - أوامر التحكم لازم تتنفذ فورًا)
  if (await isEditorMessage(msg)) {
    msg.isSelfChatCommand = false;
    await handleControlCommand(msg);
    return;
  }

  // أرقام المديرين ليهم كل أوامر التحكم برضه (احصائيات، مزامنة النظام، ارسالات اليوم...إلخ)
  // من رقمهم هم مباشرة، زي المحررين بالظبط - ومش بيتحسبوا ضمن إحصائيات المزارعين
  if (await isAdminMessage(msg)) {
    msg.isSelfChatCommand = false;
    await handleControlCommand(msg);
    return;
  }

  // تشخيص: لو النص شكله أمر تحكم معروف (أي أمر من أوامر handleControlCommand) بس الرقم مكانش
  // متعرف عليه كمحرر/مدير، بنسجّل تحذير واضح في اللوج فيه صيغة الرقم الفعلية - عشان لو حصلت
  // مشكلة زي دي تاني (خصوصًا مع أرقام بتوصل بصيغة @lid) نلاقي السبب فورًا من غير تخمين
  const CONTROL_COMMAND_PATTERN =
    /^(احصائيات|إحصائيات|مزامنة النظام|تقرير|الحصة|مدراء|محررين|اجمالي\s*الارسال|إجمالي\s*الإرسال|ارسالات|إرسالات|تقرير\s*الارسال|تقرير\s*الإرسال|اضف\s*مدير|احذف\s*مدير|اضف\s*محرر|احذف\s*محرر|ارسل\s*\S+|ايقاف\s*التقرير|تشغيل\s*التقرير|تسجيل\s*بيانات\s*المنصة|انواع\s*الرسائل|اسماء\s+\S+|كل\s*الا?رقام|تأكيد\s*(?:ارسال|إرسال)\s+\S+|(?:اعادة|إعادة)\s*محاولة\s+\S+|استئناف\s*البوت\s+\S+|علم\s*استلام\s*البطاقة\s+\S+|حالة\s*المزارع\s+\S+|تذاكر\s*مفتوحة|ايقاف\s*الارسال|تشغيل\s*الارسال)/i;
  if (CONTROL_COMMAND_PATTERN.test(text)) {
    console.log(`⚠️ رسالة شكلها أمر تحكم ("${text}") من رقم مش متعرف عليه كمحرر/مدير: ${chatId}`);
  }

  // بنترجم معرّف @lid (لو موجود) لرقم الهاتف الحقيقي قبل أي تتبع جلسة - عشان لو المزارع ده
  // استلم رسالة حملة قبل كده على رقمه العادي، ورد برسالة وصلت بصيغة @lid، البوت يتعامل معاه
  // كنفس الشخص (نفس الجلسة) مش كأنه شخص جديد تمامًا (وده كان بيسبب رد "القائمة الرئيسية"
  // غير المتوقع فور استلام رسالة حملة، رغم إنه نفس الشخص بالظبط)
  const canonicalChatId = await resolveCanonicalChatId(msg);
  msg._canonicalChatId = canonicalChatId;

  // بتأجيل معالجة رسالة المزارع لحد ما يهدى الإرسال منه (FARMER_DEBOUNCE_MS).
  // لو وصلت رسالة تانية منه قبل ما الوقت يخلص، بنلغي الرد القديم ونبدأ العد تاني من الآخر -
  // فلو البوت رجع أونلاين ولقى 10 رسائل اتجمعت وقت الانقطاع، هيرد مرة واحدة بس على آخر واحدة فيهم.
  if (farmerMessageDebounce.has(canonicalChatId)) {
    clearTimeout(farmerMessageDebounce.get(canonicalChatId));
  }
  const timer = setTimeout(() => {
    farmerMessageDebounce.delete(canonicalChatId);
    processFarmerMessage(msg).catch((err) =>
      console.log(`⚠️ خطأ في معالجة رسالة مزارع (${canonicalChatId}): ${err.message}`)
    );
  }, FARMER_DEBOUNCE_MS);
  farmerMessageDebounce.set(canonicalChatId, timer);
});

// أوامر التحكم عبر واتساب: بترسلها لنفسك في محادثة "رسائلي" (Note to Self)، أو من رقم أي "محرر" مُضاف
// - ابعت ملف Excel/CSV بتعليق (caption) فيه كلمة "تسجيل" -> يتحفظ كبيانات حالة التسجيل
// - ابعت ملف Excel/CSV بتعليق فيه كلمة "استلام" -> يتحفظ كبيانات استلام البطاقة
// - ابعت نص "ارسل تسجيل" -> يبعت رسائل حالة التسجيل لكل اللي في الملف
// - ابعت نص "ارسل استلام" -> يبعت رسائل استلام البطاقة لكل اللي في الملف
async function handleControlCommand(msg) {
  try {
    // بنشيل أي رموز اتجاه نص خفية (RLM/LRM وغيرها) - أندرويد بيحطها تلقائيًا لما الرسالة
    // بتخلط عربي مع أرقام/إنجليزي على أكتر من سطر، وده بيكسر مطابقة الأوامر اللي بتبدأ بـ^
    // من غير ما يظهر أي أثر مرئي في الرسالة نفسها (السبب اللي خلى أمر "تسجيل بيانات المنصة" ميردش خالص)
    const BIDI_CONTROL_CHARS = new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069]", "g");
    const text = (msg.body || "").replace(BIDI_CONTROL_CHARS, "").trim();

    if (msg.hasMedia) {
      const caption = text;

      // "رسائل مخصصة": ملف فيه عمود اسم + جوال + رسالة (نص مختلف لكل مزارع)، بيتحفظ كحملة
      // مستقلة بمعرّف ثابت للمعاينة والتأكيد اليدوي. Purpose إلزامي وبيتحدد من التعليق (caption)
      // نفسه صراحةً - مش تخمين من نص الرسالة خالص. لو التعليق "رسائل مخصصة" بس من غير تحديد
      // نوع، الحملة كلها بترفض ومطلوب تحديد النوع.
      if (/رسائل\s*مخصصة|رسالة\s*مخصصة/.test(caption)) {
        const PURPOSE_KEYWORDS = [
          [/تسجيل|دعوة/, "REGISTRATION"],
          [/مستندات|نواقص/, "DOCUMENTS"],
          [/بطاقة|استلام/, "CARD"],
          [/عام|اشعار|إشعار/, "GENERAL_NOTICE"],
          [/استبيان/, "SURVEY"],
          [/تقييم/, "EVALUATION"],
        ];
        let purpose = null;
        for (const [pattern, p] of PURPOSE_KEYWORDS) {
          if (pattern.test(caption)) {
            purpose = p;
            break;
          }
        }

        if (!purpose) {
          await msg.reply(
            '⚠️ لازم تحدد نوع الحملة (Purpose) في تعليق الملف نفسه. اكتب واحدة من الكلمات دي مع "رسائل مخصصة":\n\n' +
              "• تسجيل / دعوة → REGISTRATION\n" +
              "• مستندات / نواقص → DOCUMENTS\n" +
              "• بطاقة / استلام → CARD\n" +
              "• عام / اشعار → GENERAL_NOTICE\n" +
              "• استبيان → SURVEY\n" +
              "• تقييم → EVALUATION\n\n" +
              'مثال: ابعت الملف بتعليق "رسائل مخصصة تقييم"'
          );
          return;
        }

        // ===== Diagnostic آمن (بدون أي محتوى ملف أو بيانات حساسة) =====
        try {
          const idObj = msg.id;
          console.log("🩺 [Diagnostic-Media] whatsapp-web.js version:", require("whatsapp-web.js/package.json").version);
          console.log("🩺 [Diagnostic-Media] msg.id.remote:", idObj && idObj.remote);
          console.log("🩺 [Diagnostic-Media] msg.id.id:", idObj && idObj.id);
          console.log("🩺 [Diagnostic-Media] msg.id.fromMe:", idObj && idObj.fromMe);
          console.log("🩺 [Diagnostic-Media] msg.id.self:", idObj && idObj.self);
          console.log("🩺 [Diagnostic-Media] msg.id._serialized موجود:", !!(idObj && idObj._serialized));
          console.log("🩺 [Diagnostic-Media] msg.type:", msg.type, "| msg.hasMedia:", msg.hasMedia);
        } catch (diagErr) {
          console.log(`🩺 [Diagnostic-Media] فشل تسجيل بيانات التشخيص: ${diagErr.message}`);
        }

        // السبب الجذري الحقيقي (مؤكد من Stack Trace فعلي + بحث في GitHub Issues الخاصة
        // بمكتبة whatsapp-web.js): تحديث "LID Migration" من واتساب (منتصف يوليو 2026) خلّى
        // واتساب ويب يعرض Serialized Message ID لرسائل محادثات @lid تحت اسم مختلف ($1) بدل
        // الاسم القديم (_serialized) اللي نسخة المكتبة المنشورة (1.34.7 - أحدث نسخة npm متاحة،
        // مفيش نسخة أحدث تحل المشكلة دي لحد الآن) لسه بتعتمد عليه. فيه Pull Request مفتوح غير
        // مدموج على مستودع المكتبة بعنوان "$1 vs _serialized rename" بيعالج بالظبط نفس المشكلة.
        // getChat() نفسها بترمي نفس الخطأ (r: r) لنفس السبب - المشكلة مش في downloadMedia() بس،
        // هي في أي عملية بتحتاج تلاقي الرسالة/المحادثة جوّه Store واتساب ويب الداخلي باستخدام
        // _serialized المفقودة. الحل: lib/downloadMediaCompat.js - Wrapper مستقل في مشروعنا
        // (مش تعديل على node_modules، قابل للإزالة بسهولة لما المكتبة تتحدّث رسميًا) بيستخدم $1
        // بدل _serialized مباشرة عند غيابها - نفس فكرة الـPR المفتوح، بس كـWrapper من عندنا.
        const { downloadMediaCompat } = require("./lib/downloadMediaCompat");

        let media;
        let lastMediaErr;
        for (let attempt = 1; attempt <= 3 && !media; attempt++) {
          try {
            media = await downloadMediaCompat(client, msg);
            if (!media) {
              console.log(`⚠️ downloadMediaCompat رجعت undefined (محاولة ${attempt}/3)`);
              if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500));
            }
          } catch (err) {
            lastMediaErr = err;
            console.log(`⚠️ downloadMediaCompat رمت استثناء (محاولة ${attempt}/3): ${err && err.message}`);
            console.log(`🩺 [Diagnostic-Media] err.stack:\n${(err && err.stack) || "(مفيش stack)"}`);
            if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500));
          }
        }
        if (!media) {
          console.log(`⚠️ فشل تحميل الملف نهائيًا بعد 3 محاولات (${lastMediaErr ? `استثناء: ${lastMediaErr.message}` : "رجعت undefined بدون استثناء"})`);
          await msg.reply("⚠️ تعذّر تحميل الملف من واتساب حاليًا. حاول تبعته تاني بعد شوية.");
          return;
        }
        if (!media || !media.data) {
          await msg.reply("⚠️ تعذّر تحميل الملف، حاول تبعته تاني.");
          return;
        }

        const buffer = Buffer.from(media.data, "base64");
        const rawRows = parseCustomMessageRows(buffer);

        if (rawRows.length === 0) {
          await msg.reply('⚠️ مفيش بيانات في الملف. لازم أعمدة: الاسم، رقم الجوال، الرسالة.');
          return;
        }

        const built = buildCampaignRows(rawRows, purpose);
        if (built.rejected) {
          await msg.reply(`⚠️ اترفضت الحملة: ${built.reason}`);
          return;
        }
        const campaignRows = built.rows;
        const counts = summarizeCampaignRows(campaignRows);
        // "جوال غير صحيح/رسالة فاضية" كانت بتحسب invalid_phone بس - دلوقتي فيه missing_name/
        // missing_message منفصلين (Preview الجديدة في campaign-inbox بتعرضهم لوحدهم)، فبنجمعهم هنا
        // عشان الرقم المعروض في الشات القديم يفضل شامل زي ما كان بالظبط (مفيش نقصان في العد)
        const invalidOrMissing = counts.invalid_phone + counts.missing_name + counts.missing_message;

        if (counts.valid === 0) {
          await msg.reply(
            `⚠️ مفيش أي صف صالح للإرسال في الملف.\n\n` +
              `إجمالي المرفوع: ${counts.total}\n` +
              `❌ جوال غير صحيح/اسم أو رسالة فاضية: ${invalidOrMissing}\n` +
              `🔁 مكرر داخل الملف: ${counts.duplicate}\n` +
              `📨 اتبعتله نفس الرسالة قبل كده: ${counts.already_received}\n` +
              `🚫 طلب نشط: ${counts.excluded_active_application}\n` +
              `🚫 بطاقة صادرة: ${counts.excluded_card_issued}\n` +
              `🚫 بطاقة مُستلمة: ${counts.excluded_card_collected}`
          );
          return;
        }

        const firstValid = campaignRows.find((r) => r.status === "pending");
        const sample = fillTemplate(firstValid.message, firstValid);

        const campaignId = campaignStore.createCampaign({
          label: "رسائل مخصصة",
          createdBy: msg.from,
          rows: campaignRows,
        });

        await msg.reply(
          `📋 معاينة الحملة - المعرّف: *${campaignId}* (النوع: ${purpose})\n\n` +
            `Total uploaded: ${counts.total}\n` +
            `Invalid phones: ${invalidOrMissing}\n` +
            `Duplicates in file: ${counts.duplicate}\n` +
            `Active applications: ${counts.excluded_active_application}\n` +
            `Card issued: ${counts.excluded_card_issued}\n` +
            `Card collected: ${counts.excluded_card_collected}\n` +
            `Already received same message: ${counts.already_received}\n` +
            `Ready to send: ${counts.valid}\n\n` +
            `📝 عينة من أول رسالة (${firstValid.name || firstValid.phone}):\n"${sample}"\n\n` +
            `الملف ده لسه ما اتبعتش لحد دلوقتي. للبدء الفعلي في الإرسال، ابعت بالظبط:\nتأكيد ارسال ${campaignId}`
        );
        return;
      }

      // ترتيب الفحص مهم: "تسجيل" ممكن تكون جزء من "دعوة تسجيل"، فبنفحص الأنواع الأكتر تحديدًا الأول
      const isDocuments = /مستندات/.test(caption);
      const isInvitation = /دعوة/.test(caption);
      const isCardPickup = !isDocuments && !isInvitation && /استلام/.test(caption);
      const isRegistration = !isDocuments && !isInvitation && !isCardPickup && /تسجيل/.test(caption);

      const kind = isRegistration
        ? "registration"
        : isCardPickup
        ? "pickup"
        : isDocuments
        ? "documents"
        : isInvitation
        ? "invitation"
        : null;

      if (kind) {
        const KIND_INFO = {
          registration: { csv: REGISTRATION_CSV, needsRequestNumber: true, label: "حالة التسجيل", sendCmd: "ارسل تسجيل", fallbackFile: "registration_status.csv", fallbackCmd: "npm run send-registration-status" },
          pickup: { csv: CARD_PICKUP_CSV, needsRequestNumber: false, label: "إشعار استلام البطاقة", sendCmd: "ارسل استلام", fallbackFile: "card_pickup.csv", fallbackCmd: "npm run send-card-pickup" },
          documents: { csv: DOCUMENTS_REQUEST_CSV, needsRequestNumber: false, label: "طلب مستندات", sendCmd: "ارسل مستندات", fallbackFile: "documents_request.csv", fallbackCmd: "npm run send-documents-request" },
          invitation: { csv: REGISTRATION_INVITATION_CSV, needsRequestNumber: false, label: "دعوة للتسجيل", sendCmd: "ارسل دعوة", fallbackFile: "registration_invitation.csv", fallbackCmd: "npm run send-registration-invitation" },
        };
        const info = KIND_INFO[kind];

        let media;
        try {
          media = await msg.downloadMedia();
        } catch (err) {
          console.log(`⚠️ فشل تحميل الملف من واتساب (مشكلة معروفة حاليًا في المكتبة): ${err.message}`);
          await msg.reply(
            `⚠️ تعذّر تحميل الملف من واتساب حاليًا (مشكلة معروفة في واتساب ويب لسه مش متصلحة).\n\nالبديل: حط الملف باسم ${info.fallbackFile} في مجلد المشروع على الجهاز، وشغّل الأمر:\n${info.fallbackCmd}`
          );
          return;
        }
        if (!media || !media.data) {
          await msg.reply("⚠️ تعذّر تحميل الملف، حاول تبعته تاني.");
          return;
        }
        const buffer = Buffer.from(media.data, "base64");
        const rows = parseFarmerRows(buffer, info.needsRequestNumber);

        if (rows.length === 0) {
          await msg.reply("⚠️ مفيش بيانات صحيحة في الملف (محتاج عمود فيه رقم جوال صحيح).");
          return;
        }

        fs.writeFileSync(info.csv, farmerRowsToCsvText(rows, info.needsRequestNumber), "utf8");
        await msg.reply(
          `✅ استلمت بيانات ${rows.length} مزارع لـ${info.label}.\n\nابعت "${info.sendCmd}" للتأكيد وبدء الإرسال.`
        );
      }
      return;
    }

    if (/^ارسل\s*تسجيل$/i.test(text)) {
      if (!fs.existsSync(REGISTRATION_CSV)) {
        await msg.reply('⚠️ لسه مفيش ملف بيانات تسجيل متبعت. ابعت الملف الأول بتعليق "تسجيل".');
        return;
      }
      const started = await runExclusive("حالة التسجيل", sendRegistrationStatusBroadcast);
      if (!started) await msg.reply("⚠️ فيه عملية إرسال شغالة بالفعل، استنى تخلص وحاول تاني.");
      return;
    }

    if (/^ارسل\s*استلام$/i.test(text)) {
      if (!fs.existsSync(CARD_PICKUP_CSV)) {
        await msg.reply('⚠️ لسه مفيش ملف بيانات استلام متبعت. ابعت الملف الأول بتعليق "استلام".');
        return;
      }
      const started = await runExclusive("استلام البطاقة", sendCardPickupBroadcast);
      if (!started) await msg.reply("⚠️ فيه عملية إرسال شغالة بالفعل، استنى تخلص وحاول تاني.");
      return;
    }

    if (/^ارسل\s*مستندات$/i.test(text)) {
      if (!fs.existsSync(DOCUMENTS_REQUEST_CSV)) {
        await msg.reply('⚠️ لسه مفيش ملف بيانات مستندات متبعت. ابعت الملف الأول بتعليق "مستندات".');
        return;
      }
      const started = await runExclusive("طلب مستندات", sendDocumentsRequestBroadcast);
      if (!started) await msg.reply("⚠️ فيه عملية إرسال شغالة بالفعل، استنى تخلص وحاول تاني.");
      return;
    }

    if (/^ارسل\s*دعوة$/i.test(text)) {
      if (!fs.existsSync(REGISTRATION_INVITATION_CSV)) {
        await msg.reply('⚠️ لسه مفيش ملف بيانات دعوة متبعت. ابعت الملف الأول بتعليق "دعوة".');
        return;
      }
      const started = await runExclusive("دعوة للتسجيل", sendRegistrationInvitationBroadcast);
      if (!started) await msg.reply("⚠️ فيه عملية إرسال شغالة بالفعل، استنى تخلص وحاول تاني.");
      return;
    }

    // "ارسل درافت" و"ارسل رسالة مخصصة": لازم الملف يكون متحط يدوي في مجلد المشروع
    // (draft_forms.csv بيتحدّث تلقائيًا من نظام البطاقات، وcustom_message.csv بتحدّثه انت بنفسك)
    if (/^ارسل\s*درافت$/i.test(text)) {
      if (!fs.existsSync(DRAFT_FORMS_CSV)) {
        await msg.reply('⚠️ لسه مفيش ملف بيانات درافت. لو نظام البطاقات متظبّط هيتحدّث لوحده، وإلا حطه يدوي باسم draft_forms.csv.');
        return;
      }
      // نفس حصة الدرافت اليومية (10) بتتطبق هنا كمان حتى لو الملف اتحط يدوي - عشان نضمن إن
      // مفيش أي مسار بيبعت رسائل درافت من غير ما يستهلك/يحترم نفس الحد الأقصى اليومي
      const remainingQuota = portalSync.isConfigured() ? portalSync.getRemainingQuota() : Infinity;
      if (remainingQuota <= 0) {
        await msg.reply("⚠️ وصلنا للحد اليومي لرسائل الدرافت (10). حاول تاني بكرة.");
        return;
      }
      if (Number.isFinite(remainingQuota)) {
        const rows = parseCsv(fs.readFileSync(DRAFT_FORMS_CSV, "utf8")).filter(
          (r) => r.length > 1 || (r[0] || "").trim()
        );
        if (rows.length > remainingQuota) {
          const trimmed = rows
            .slice(0, remainingQuota)
            .map((r) => r.map((f) => csvField(f)).join(","))
            .join("\n") + "\n";
          fs.writeFileSync(DRAFT_FORMS_CSV, trimmed, "utf8");
          await msg.reply(
            `ℹ️ الملف فيه ${rows.length} مزارع، بس متبقي ${remainingQuota} بس من حصة اليوم. هنبعت لأول ${remainingQuota} والباقي هيتأجل لبكرة.`
          );
        }
      }
      const started = await runExclusive("تذكير درافت", async () => {
        const sendSummary = await sendDraftFormsBroadcast();
        if (portalSync.isConfigured()) {
          portalSync.addToTodayCount((sendSummary && sendSummary.sent) || 0);
        }
      });
      if (!started) await msg.reply("⚠️ فيه عملية إرسال شغالة بالفعل، استنى تخلص وحاول تاني.");
      return;
    }

    if (/^ارسل\s*رسالة\s*مخصصة$/i.test(text)) {
      if (!fs.existsSync(CUSTOM_MESSAGE_CSV)) {
        await msg.reply('⚠️ لسه مفيش ملف رسالة مخصصة. حط بياناتك في custom_message.csv (الاسم، رقم الجوال، الرسالة) في مجلد المشروع.');
        return;
      }
      const started = await runExclusive("رسالة مخصصة", sendCustomMessageBroadcast);
      if (!started) await msg.reply("⚠️ فيه عملية إرسال شغالة بالفعل، استنى تخلص وحاول تاني.");
      return;
    }

    // بدء (أو استكمال) إرسال حملة "رسائل مخصصة" اللي اتحفظت بعد رفع الملف - لازم تأكيد صريح
    // بالمعرّف عشان مايتبعتش أي حاجة تلقائي فور الرفع. لو الحملة فيها صفوف "pending" باقية من
    // مرة قبل كده (البوت اتوقف نص الطريق)، هيكمل منها بالظبط من غير ما يعيد اللي اتبعت فعلًا.
    const confirmSendMatch = text.match(/^تأكيد\s*(?:ارسال|إرسال)\s+(\S+)$/i);
    if (confirmSendMatch) {
      const campaignId = confirmSendMatch[1];
      const campaign = campaignStore.getCampaign(campaignId);
      if (!campaign) {
        await msg.reply(`⚠️ مفيش حملة بالمعرّف "${campaignId}".`);
        return;
      }
      const pendingCount = campaign.rows.filter((r) => r.status === "pending").length;
      if (pendingCount === 0) {
        const failedCount = campaign.rows.filter(
          (r) => r.status === "failed" || r.status === "not_on_whatsapp"
        ).length;
        await msg.reply(
          `ℹ️ الحملة "${campaignId}" خلصت بالفعل (مفيش صفوف متبقية للإرسال).` +
            (failedCount > 0 ? `\n\nلإعادة محاولة الفاشل (${failedCount}): اعادة محاولة ${campaignId}` : "")
        );
        return;
      }
      await msg.reply(`🔄 جاري إرسال ${pendingCount} رسالة من الحملة "${campaignId}"...`);
      const started = await runExclusive("رسائل مخصصة (حملة)", async () => {
        const summary = await sendCampaignRows(client, campaignId);
        await msg.reply(formatSummaryText(campaignId, summary));
      });
      if (!started) await msg.reply("⚠️ فيه عملية إرسال شغالة بالفعل، استنى تخلص وحاول تاني.");
      return;
    }

    // إعادة محاولة الصفوف الفاشلة بس في حملة معيّنة (مش الحملة كلها من الأول)
    const retryMatch = text.match(/^(?:اعادة|إعادة)\s*محاولة\s+(\S+)$/i);
    if (retryMatch) {
      const campaignId = retryMatch[1];
      const campaign = campaignStore.getCampaign(campaignId);
      if (!campaign) {
        await msg.reply(`⚠️ مفيش حملة بالمعرّف "${campaignId}".`);
        return;
      }
      const resetCount = campaignStore.resetFailedRows(campaignId);
      if (resetCount === 0) {
        await msg.reply(`ℹ️ مفيش أي صف فاشل في الحملة "${campaignId}" يستاهل إعادة محاولة.`);
        return;
      }
      await msg.reply(`🔄 جاري إعادة محاولة ${resetCount} رسالة فاشلة من الحملة "${campaignId}"...`);
      const started = await runExclusive("رسائل مخصصة (إعادة محاولة)", async () => {
        const summary = await sendCampaignRows(client, campaignId);
        await msg.reply(formatSummaryText(campaignId, summary));
      });
      if (!started) await msg.reply("⚠️ فيه عملية إرسال شغالة بالفعل، استنى تخلص وحاول تاني.");
      return;
    }

    if (/^تقرير$/i.test(text)) {
      const summary = getDailySummary();
      await msg.reply(formatDailySummary(summary));
      return;
    }

    if (/^الحصة$/i.test(text)) {
      if (!portalSync.isConfigured()) {
        await msg.reply("⚠️ نظام البطاقات مش متظبّط أصلًا.");
        return;
      }
      const remaining = portalSync.getRemainingQuota();
      await msg.reply(
        `📊 الحصة اليومية لرسائل الدرافت فقط: ${remaining} متبقي من أصل ${portalSync.DAILY_LIMIT} (بيترجع 10 تاني بكرة).\nملحوظة: البطاقات الجاهزة وحالة الطلب من غير حد أقصى - بتتبعت لكل الموجودين كل مرة.`
      );
      return;
    }

    if (/^(احصائيات|إحصائيات)$/i.test(text)) {
      if (!portalSync.isConfigured()) {
        await msg.reply("⚠️ نظام البطاقات مش متظبّط أصلًا.");
        return;
      }
      await msg.reply("📊 جاري جلب الإحصائيات من المنصة...");
      try {
        const { fetchPortalStats } = require("./lib/portalScraper");
        const s = await fetchPortalStats();
        const fmt = (v) => (v === null || v === undefined ? "غير متاح" : v);
        await msg.reply(
          `📊 إحصائيات نظام البطاقات (لحظة الاستعلام):\n\n` +
          `📝 مراجعة التسجيل:\n` +
          `• قيد المراجعة: ${fmt(s.pendingReview)}\n` +
          `• معلّق (On Hold): ${fmt(s.onHold)}\n` +
          `• مقبول: ${fmt(s.approved)}\n` +
          `• مرفوض: ${fmt(s.rejected)}\n` +
          `• مؤرشف: ${fmt(s.archived)}\n\n` +
          `🖨️ إصدار البطاقات:\n` +
          `• قيد الطباعة: ${fmt(s.issuingPending)}\n` +
          `• قيد التسليم: ${fmt(s.pendingDelivery)}\n` +
          `• تم التسليم: ${fmt(s.delivered)}\n` +
          `• الإجمالي في الطابور: ${fmt(s.totalInQueue)}\n\n` +
          `📋 الدرافت (لسه ما اتقدّمتش): ${fmt(s.draft)}`
        );
      } catch (err) {
        await msg.reply(`⚠️ تعذّر جلب الإحصائيات: ${err.message}`);
      }
      return;
    }

    // تقرير كل الرسائل اللي اتبعتت النهارده (أو تاريخ معيّن)، مجمّعة حسب النوع
    // "ارسالات اليوم" أو "تقرير الارسال اليوم" - وممكن كمان تحدد تاريخ زي "ارسالات 2026-09-06"
    const sendReportMatch = text.match(/^(?:ارسالات|إرسالات|تقرير\s*الارسال|تقرير\s*الإرسال)(?:\s+اليوم)?(?:\s+(\d{4}-\d{2}-\d{2}))?$/i);
    if (sendReportMatch) {
      const dateArg = sendReportMatch[1];
      const summary = sendLog.getDaySummary(dateArg);
      if (summary.total === 0) {
        await msg.reply(`📭 مفيش أي رسائل اتبعتت بتاريخ ${summary.date}.`);
        return;
      }
      const lines = [`📬 تقرير الإرسال ليوم ${summary.date}:\n`];
      for (const [label, g] of Object.entries(summary.groups)) {
        lines.push(`\n*${label}* (${g.sent.length} تم الإرسال${g.failed.length ? `، ${g.failed.length} فشل` : ""}):`);
        g.sent.forEach((e) => lines.push(`✅ ${e.name} (${e.phone})`));
        g.failed.forEach((e) => lines.push(`❌ ${e.name} (${e.phone}) - ${e.status}`));
      }
      await msg.reply(lines.join("\n"));
      return;
    }

    // إجمالي عدد اللي اتبعتلهم كل نوع رسالة على مر الوقت (مش بس النهارده) - من ملف sent_history.json
    if (/^(اجمالي|إجمالي)\s*(الارسال|الإرسال)$/i.test(text)) {
      const counts = sentTracker.getAllCounts();
      const LABELS = {
        card_pickup: "استلام البطاقة",
        registration_status: "حالة التسجيل",
        draft_reminder: "تذكير الدرافت",
      };
      const entries = Object.entries(counts);
      if (entries.length === 0) {
        await msg.reply("📭 مفيش أي رسائل اتبعتت من نظام البطاقات لحد دلوقتي.");
        return;
      }
      const lines = ["📊 إجمالي عدد المزارعين اللي اتبعتلهم كل نوع رسالة (من أول ما اشتغل النظام):\n"];
      entries.forEach(([campaignType, count]) => {
        lines.push(`• ${LABELS[campaignType] || campaignType}: ${count}`);
      });
      await msg.reply(lines.join("\n"));
      return;
    }

    // بيوري كل أنواع الرسائل المسجّلة فعليًا في السجل مع عدد كل نوع - عشان تعرف تكتب الاسم
    // الصح لما تستخدم أمر "اسماء <نوع الرسالة>" اللي جاي تحت
    if (/^انواع\s*الرسائل$/i.test(text)) {
      const counts = sendLog.getLabelCounts();
      const entries = Object.entries(counts);
      if (entries.length === 0) {
        await msg.reply("📭 مفيش أي رسائل مسجّلة لحد دلوقتي.");
        return;
      }
      const lines = ["📋 أنواع الرسائل المسجّلة:\n"];
      entries.forEach(([label, count]) => lines.push(`• ${label}: ${count}`));
      lines.push(`\nاكتب "اسماء <النوع>" (مثلاً: اسماء استلام البطاقة) عشان تشوف كل الأسماء.`);
      await msg.reply(lines.join("\n"));
      return;
    }

    // بيوري كل الأرقام المختلفة (بدون تكرار) اللي البوت له تواصل معاها - سواء بعتلها حملة
    // (استلام بطاقة، تذكير درافت...إلخ) أو كلّمت البوت من نفسها من غير أي حملة (بنعلّم دول
    // بـ"تواصل مباشر"). قبل كده كان بيوري بس اللي جاله حملة، فمزارعين كتير كلّموا البوت بنفسهم
    // كانوا مش ظاهرين في القايمة دي خالص رغم إن البوت فعلاً اتكلم معاهم
    if (/^كل\s*الارقام$/i.test(text) || /^كل\s*الأرقام$/i.test(text)) {
      const merged = new Map();
      sendLog.getAllRecipients().forEach((r) => {
        merged.set(r.phone, { phone: r.phone, name: r.name, labels: [...r.labels] });
      });
      getKnownSenders().forEach((s) => {
        const phone = s.chatId.replace(/@.*/, "");
        if (!/^\d{8,15}$/.test(phone)) return; // تجاهل معرّفات @lid قديمة ما اتترجمتش لرقم حقيقي
        if (merged.has(phone)) {
          if (s.name && !merged.get(phone).name) merged.get(phone).name = s.name;
        } else {
          merged.set(phone, { phone, name: s.name, labels: ["تواصل مباشر"] });
        }
      });
      const recipients = Array.from(merged.values());

      if (recipients.length === 0) {
        await msg.reply("📭 مفيش أي تواصل اتسجّل لحد دلوقتي.");
        return;
      }
      const LIMIT = 150;
      const lines = [`👥 كل الأرقام اللي للبوت تواصل معاها (${recipients.length} رقم مختلف):\n`];
      recipients.slice(0, LIMIT).forEach((r) => {
        lines.push(`• ${r.name || "بدون اسم"} (${r.phone}) - ${r.labels.join("، ")}`);
      });
      if (recipients.length > LIMIT) {
        lines.push(`\n...و${recipients.length - LIMIT} رقم إضافي.`);
      }
      await msg.reply(lines.join("\n"));
      return;
    }

    // بيوري كل المزارعين اللي اتبعتلهم نوع رسالة معيّن بنجاح، على مر الوقت (مش بس النهارده) -
    // زي "اسماء استلام البطاقة" أو "اسماء تذكير درافت" أو "اسماء رسالة مخصصة"
    const namesMatch = text.match(/^اسماء\s+(.+)$/i);
    if (namesMatch) {
      const requestedLabel = namesMatch[1].trim();
      const counts = sendLog.getLabelCounts();
      const matchedLabel = Object.keys(counts).find((label) => label === requestedLabel) || requestedLabel;
      const rows = sendLog.getAllByLabel(matchedLabel);
      if (rows.length === 0) {
        const available = Object.keys(counts);
        const hint = available.length
          ? `\n\nالأنواع المتاحة: ${available.join("، ")}`
          : "";
        await msg.reply(`📭 مفيش أي رسائل من نوع "${requestedLabel}" مسجّلة.${hint}`);
        return;
      }
      const lines = [`👥 المزارعين اللي اتبعتلهم "${matchedLabel}" (${rows.length}):\n`];
      rows.forEach((e) => lines.push(`• ${e.name || "بدون اسم"} (${e.phone})`));
      await msg.reply(lines.join("\n"));
      return;
    }

    // تحديث بيانات الدخول للمنصة مباشرة من واتساب: "تسجيل بيانات المنصة <يوزر> <باسورد>"
    // ملحوظة أمنية: الباسورد هيفضل موجود في سجل محادثة واتساب - استخدم الأمر ده بحذر
    const credMatch = text.match(/^تسجيل\s*بيانات\s*المنصة\s+(\S+)\s+(\S+)$/i);
    if (credMatch) {
      const [, username, password] = credMatch;
      try {
        const { saveCredentials } = require("./lib/portalScraper");
        saveCredentials(username, password);
        await msg.reply(
          '✅ تم تحديث بيانات الدخول للمنصة بنجاح.\n\nجرب دلوقتي "مزامنة النظام" أو "احصائيات" للتأكد إن الدخول شغال.'
        );
      } catch (err) {
        await msg.reply(`⚠️ تعذّر حفظ البيانات: ${err.message}`);
      }
      return;
    }

    // بحث حر بالاسم/الجوال/الهوية في المنصة: "دور محمد أحمد" أو "دور 966501234567"
    const searchMatch = text.match(/^دور\s+(.+)$/i);
    if (searchMatch) {
      if (!portalSync.isConfigured()) {
        await msg.reply("⚠️ نظام البطاقات مش متظبّط أصلًا.");
        return;
      }
      const query = searchMatch[1].trim();
      await msg.reply(`🔎 جاري البحث عن "${query}" في المنصة...`);
      try {
        const { searchPortal } = require("./lib/portalScraper");
        const rows = await searchPortal(query);
        if (rows.length === 0) {
          await msg.reply("لا توجد نتائج مطابقة.");
        } else {
          const lines = rows
            .slice(0, 15)
            .map(
              (r) =>
                `• ${r.name || "بدون اسم"} — ${r.phone || "بدون جوال"}${r.nationalId ? ` — هوية: ${r.nationalId}` : ""}${r.status ? ` — (${r.status})` : ""}`
            );
          const extra = rows.length > 15 ? `\n\n...و${rows.length - 15} نتيجة إضافية.` : "";
          await msg.reply(`🔎 نتائج البحث (${rows.length}):\n\n${lines.join("\n")}${extra}`);
        }
      } catch (err) {
        await msg.reply(`⚠️ تعذّر البحث: ${err.message}`);
      }
      return;
    }

    // قائمة أسماء حسب الحالة - بنقبل صياغات طبيعية مختلفة زي "قائمة الطلبات المرفوضة" أو
    // "قائمة الطلبات التي تم قبولها" مش بس الكلمة المضبوطة، عن طريق البحث عن جذر الكلمة
    // بدل المطابقة الحرفية الكاملة. كل نمط بيتفحص بالترتيب ده لتجنب أي تداخل بين الفئات
    const LIST_KEYWORD_ALIASES = [
      { test: /مرفوض|رفضها|تم\s*الرفض/i, key: "مرفوض", isReview: true },
      { test: /مقبول|قبول/i, key: "مقبول", isReview: true },
      { test: /معلق|هولد|on\s*hold/i, key: "معلق", isReview: true },
      { test: /مؤرشف|ارشيف|أرشيف/i, key: "مؤرشف", isReview: true },
      { test: /طابور\s*الطباعة|بانتظار\s*الطباعة|قيد\s*الطباعة/i, key: "قيد الطباعة", isReview: true },
      { test: /مراجعة/i, key: "قيد المراجعة", isReview: true },
      { test: /تم\s*الطباعة|مطبوعة|طبعت/i, key: "مطبوعة", isReview: false },
      { test: /تسليم/i, key: "تم التسليم", isReview: false },
    ];

    const listMatch = text.match(/^قائمة\s+(.+)$/i);
    if (listMatch) {
      if (!portalSync.isConfigured()) {
        await msg.reply("⚠️ نظام البطاقات مش متظبّط أصلًا.");
        return;
      }
      const { fetchReviewByStatus, fetchIssuingByTab } = require("./lib/portalScraper");
      const rawKeyword = listMatch[1].trim();
      const alias = LIST_KEYWORD_ALIASES.find((a) => a.test.test(rawKeyword));

      if (!alias) {
        await msg.reply(
          `⚠️ مش فاهم الحالة المطلوبة. جرب كلمة زي: مرفوض، مقبول، معلق، مؤرشف، قيد المراجعة، قيد الطباعة، مطبوعة، تم التسليم.`
        );
        return;
      }

      await msg.reply(`📋 جاري جلب قائمة "${alias.key}" من المنصة...`);
      try {
        const rows = alias.isReview ? await fetchReviewByStatus(alias.key) : await fetchIssuingByTab(alias.key);
        if (rows.length === 0) {
          await msg.reply(`لا يوجد سجلات في حالة "${alias.key}" حاليًا.`);
        } else {
          const lines = rows
            .slice(0, 20)
            .map((r) => `• ${r.name || "بدون اسم"} — ${r.phone || "بدون جوال"}${r.nationalId ? ` — هوية: ${r.nationalId}` : ""}`);
          const extra = rows.length > 20 ? `\n\n...و${rows.length - 20} اسم إضافي.` : "";
          await msg.reply(`📋 قائمة "${alias.key}" (${rows.length}):\n\n${lines.join("\n")}${extra}`);
        }
      } catch (err) {
        await msg.reply(`⚠️ تعذّر جلب القائمة: ${err.message}`);
      }
      return;
    }

    // إضافة/حذف رقم يستقبل التقرير اليومي ويقدر يطلبه: "اضف مدير 966501234567"
    // بيقبل إما رقم عادي (966...) أو معرّف واتساب كامل بصيغة @lid - مفيد لما رقم مدير معيّن بيوصل
    // بصيغة @lid (مشكلة معروفة في بعض الحسابات) ومينفعش نتعرف عليه من رقمه العادي. تقدر تاخد
    // المعرّف الكامل من رسالة تحذير في pm2 logs زي: "...من رقم مش متعرف عليه كمحرر/مدير: xxxx@lid"
    const addAdminMatch = toWesternDigits(text).match(/^اضف\s*مدير\s+(\d{8,15}(?:@lid)?)$/i);
    if (addAdminMatch) {
      const phone = addAdminMatch[1];
      const added = adminStore.addAdmin(phone);
      await msg.reply(
        added
          ? `✅ تمت إضافة ${phone} كمستقبل للتقرير اليومي.`
          : `ℹ️ الرقم ${phone} مضاف بالفعل.`
      );
      return;
    }

    const removeAdminMatch = toWesternDigits(text).match(/^احذف\s*مدير\s+(\d{8,15}(?:@lid)?)$/i);
    if (removeAdminMatch) {
      const phone = removeAdminMatch[1];
      const removed = adminStore.removeAdmin(phone);
      await msg.reply(
        removed ? `✅ تم حذف ${phone} من مستقبلي التقرير.` : `ℹ️ الرقم ${phone} مش موجود أصلًا.`
      );
      return;
    }

    // بيرجّع البوت يرد تلقائيًا تاني على مزارع اتحوّلت محادثته لموظف (HANDED_OFF) - يستخدمها
    // الموظف بعد ما يخلص مع المزارع. الحالة دي محفوظة بشكل دائم (مش Map في الذاكرة بس)
    const resumeBotMatch = toWesternDigits(text).match(/^استئناف\s*البوت\s+(\d{8,15})$/i);
    if (resumeBotMatch) {
      const phone = normalizeSaudiPhone(resumeBotMatch[1]);
      const chatIdToResume = `${phone}@c.us`;
      const wasHandedOff = sessionStore.resumeBot(chatIdToResume);
      if (sessions.has(chatIdToResume)) sessions.set(chatIdToResume, { state: "MENU" });
      await msg.reply(
        wasHandedOff
          ? `✅ تم استئناف الرد التلقائي للمزارع ${phone}.`
          : `ℹ️ المزارع ${phone} مش متحوّل لموظف أصلًا (HANDED_OFF).`
      );
      return;
    }

    // تصحيح/تحديث يدوي لحالة مزارع - البوابة مالهاش مصدر موثوق لـ"البطاقة اتسلّمت فعليًا"،
    // فده بديل يدوي للموظف يعلّمها بنفسه بعد ما المزارع يستلم بطاقته الفعلية
    // السبب إلزامي - مفيش تغيير حالة يدوي من غير توثيق (changedBy + reason) بيتسجّل في
    // history المزارع وفي الـAudit Log المركزي
    const markCollectedMatch = toWesternDigits(text).match(/^علم\s*استلام\s*البطاقة\s+(\d{8,15})\s+(.+)$/i);
    if (markCollectedMatch) {
      const phone = normalizeSaudiPhone(markCollectedMatch[1]);
      const reason = markCollectedMatch[2].trim();
      try {
        farmerState.setManualState(phone, "CARD_COLLECTED", { changedBy: msg.from, reason });
        await msg.reply(`✅ اتعلّم إن المزارع ${phone} استلم بطاقته فعليًا (CARD_COLLECTED).\nالسبب: ${reason}`);
      } catch (err) {
        await msg.reply(`⚠️ تعذّر التحديث: ${err.message}`);
      }
      return;
    }
    if (/^علم\s*استلام\s*البطاقة\s+\d{8,15}$/i.test(toWesternDigits(text))) {
      await msg.reply('⚠️ لازم تكتب السبب كمان. مثال: علم استلام البطاقة 966501234567 تم التسليم يدويًا في المركز');
      return;
    }

    // بيوري حالة مزارع معيّن من الـFarmer State Machine
    const stateOfMatch = toWesternDigits(text).match(/^حالة\s*المزارع\s+(\d{8,15})$/i);
    if (stateOfMatch) {
      const phone = normalizeSaudiPhone(stateOfMatch[1]);
      try {
        const info = farmerState.getState(phone);
        await msg.reply(
          `📍 حالة المزارع ${phone}:\n` +
            `الحالة: ${info.state}\n` +
            `المصدر: ${info.stateSource || "غير معروف"}\n` +
            `آخر تحديث: ${info.updatedAt || "-"}\n` +
            `آخر ظهور: ${info.lastSeenAt || "-"}`
        );
      } catch (err) {
        await msg.reply(`⚠️ تعذّر قراءة حالة المزارع حاليًا: ${err.message}`);
      }
      return;
    }

    // بيوري كل التذاكر المفتوحة (شكاوى/استفسارات/اقتراحات لسه ما اتقفلتش)
    if (/^تذاكر\s*مفتوحة$/i.test(text)) {
      const open = ticketStore.listTickets({ status: "OPEN" });
      if (open.length === 0) {
        await msg.reply("📭 مفيش تذاكر مفتوحة حاليًا.");
        return;
      }
      const lines = [`🎫 التذاكر المفتوحة (${open.length}):\n`];
      open.forEach((t) => lines.push(`• ${t.ticket_id} - ${t.farmer_name || t.phone} (${t.category}) - ${t.created_at}`));
      await msg.reply(lines.join("\n"));
      return;
    }

    // إيقاف/تشغيل الإرسال بالكامل (كل الحملات) مؤقتًا - مفيد وقت مشكلة طارئة أو صيانة
    if (/^ايقاف\s*الارسال$/i.test(text)) {
      rateLimiter.pause();
      await msg.reply("⏸️ تم إيقاف كل عمليات الإرسال مؤقتًا. ابعت \"تشغيل الارسال\" لإرجاعه.");
      return;
    }
    if (/^تشغيل\s*الارسال$/i.test(text)) {
      rateLimiter.resume();
      await msg.reply("▶️ تم تشغيل الإرسال تاني.");
      return;
    }

    // إيقاف/تشغيل استقبال التقرير في محادثة "رسائلي" نفسها (بدون التأثير على باقي المديرين)
    if (/^ايقاف\s*التقرير$/i.test(text)) {
      adminStore.setSelfReportEnabled(false);
      await msg.reply("🔕 تم إيقاف إرسال التقرير اليومي لمحادثة رسائلي. ابعت \"تشغيل التقرير\" لإرجاعه.");
      return;
    }

    if (/^تشغيل\s*التقرير$/i.test(text)) {
      adminStore.setSelfReportEnabled(true);
      await msg.reply("🔔 تم تشغيل إرسال التقرير اليومي لمحادثة رسائلي تاني.");
      return;
    }

    if (/^(مدراء|قائمة\s*المدراء)$/i.test(text)) {
      const state = adminStore.getState();
      const list = [...new Set([...(cfg.ADMIN_NUMBERS || []), ...state.admins])];
      const listText = list.length ? list.join("\n") : "لا يوجد";
      await msg.reply(
        `📋 مستقبلو التقرير اليومي:\n\n${listText}\n\nرسائلي (Note to Self): ${
          state.selfReportEnabled ? "مفعّل ✅" : "متوقف 🔕"
        }`
      );
      return;
    }

    // إضافة/حذف موظف خدمة مزارعين (بياخد تنبيه فوري لما مزارع يختار "التواصل مع موظف")
    const addStaffMatch = toWesternDigits(text).match(/^اضف\s*موظف\s+(\d{8,15})$/i);
    if (addStaffMatch) {
      const phone = addStaffMatch[1];
      const added = staffStore.addStaff(phone);
      await msg.reply(
        added ? `✅ تمت إضافة ${phone} كموظف خدمة مزارعين، هياخد تنبيه فوري لأي مزارع يختار "2".` : `ℹ️ الرقم ${phone} مضاف بالفعل.`
      );
      return;
    }

    const removeStaffMatch = toWesternDigits(text).match(/^احذف\s*موظف\s+(\d{8,15})$/i);
    if (removeStaffMatch) {
      const phone = removeStaffMatch[1];
      const removed = staffStore.removeStaff(phone);
      await msg.reply(removed ? `✅ تم حذف ${phone} من موظفي الخدمة.` : `ℹ️ الرقم ${phone} مش موجود أصلًا.`);
      return;
    }

    if (/^موظفين$/i.test(text)) {
      const staff = staffStore.getStaff();
      const listText = staff.length ? staff.join("\n") : "لا يوجد";
      await msg.reply(
        `👷 موظفو خدمة المزارعين:\n\n${listText}\n\n🕒 ساعات الدوام: ${staffStore.formatWorkingHours()}`
      );
      return;
    }

    if (/^الدوام$/i.test(text)) {
      await msg.reply(`🕒 ساعات الدوام الحالية: ${staffStore.formatWorkingHours()}`);
      return;
    }

    // تعيين ساعات الدوام: "تعيين الدوام 8-16" أو "الدوام من 8 الى 16"
    const workingHoursMatch = toWesternDigits(text).match(/^(?:تعيين\s*)?الدوام\s*(?:من\s*)?(.+)$/i);
    if (workingHoursMatch) {
      const range = staffStore.parseTimeRange(workingHoursMatch[1]);
      if (!range) {
        await msg.reply('⚠️ صيغة غير مفهومة. جرب مثلًا: "تعيين الدوام 8-16" أو "الدوام من 8 الى 16"');
        return;
      }
      staffStore.setWorkingHours(range.startMinutes, range.endMinutes);
      await msg.reply(`✅ تم تعيين ساعات الدوام: ${staffStore.formatWorkingHours()}`);
      return;
    }

    // تعديل أي نص من نصوص الرد التلقائي: أول سطر "تعديل <اسم النص>" والباقي هو النص الجديد كامل
    // مثال:
    // تعديل رسالة الموظف
    // شكرًا لتواصلكم، سيتم الرد عليكم قريبًا.
    const editMatch = text.match(/^تعديل\s+([^\n]+)\n([\s\S]+)$/);
    if (editMatch) {
      const label = editMatch[1].trim();
      const newText = editMatch[2].trim();
      const key = textStore.keyFromLabel(label);
      if (!key) {
        await msg.reply(
          `⚠️ اسم النص "${label}" مش معروف.\n\nالأسماء المتاحة:\n${textStore.labelsList().join("\n")}`
        );
        return;
      }
      textStore.setOverride(key, newText);
      await msg.reply(`✅ تم تحديث "${label}". ابعت "استرجاع ${label}" لو حبيت ترجع للنص الافتراضي.`);
      return;
    }

    // استرجاع نص لوضعه الافتراضي: "استرجاع رسالة الموظف"
    const resetMatch = text.match(/^استرجاع\s+(.+)$/);
    if (resetMatch) {
      const label = resetMatch[1].trim();
      const key = textStore.keyFromLabel(label);
      if (!key) {
        await msg.reply(
          `⚠️ اسم النص "${label}" مش معروف.\n\nالأسماء المتاحة:\n${textStore.labelsList().join("\n")}`
        );
        return;
      }
      textStore.clearOverride(key);
      await msg.reply(`✅ تم إرجاع "${label}" لنصه الافتراضي.`);
      return;
    }

    if (/^(عرض الردود|الردود)$/i.test(text)) {
      const overrides = textStore.load();
      const lines = textStore
        .labelsList()
        .map((label) => {
          const key = textStore.keyFromLabel(label);
          const isEdited = overrides[key] !== undefined;
          return `${isEdited ? "✏️" : "•"} ${label}${isEdited ? " (مُعدَّل)" : ""}`;
        });
      await msg.reply(
        `📋 نصوص الرد المتاحة للتعديل:\n\n${lines.join(
          "\n"
        )}\n\nللتعديل: "تعديل <الاسم>" ثم النص الجديد بسطر جديد.\nللمعاينة: "عرض <الاسم>".`
      );
      return;
    }

    // معاينة نص معين كامل: "عرض رسالة الموظف"
    const previewMatch = text.match(/^عرض\s+(.+)$/);
    if (previewMatch) {
      const label = previewMatch[1].trim();
      const key = textStore.keyFromLabel(label);
      if (!key) {
        await msg.reply(
          `⚠️ اسم النص "${label}" مش معروف.\n\nالأسماء المتاحة:\n${textStore.labelsList().join("\n")}`
        );
        return;
      }
      await msg.reply(`📄 "${label}" حاليًا:\n\n${getCfgText(key)}`);
      return;
    }

    // إضافة/حذف "محرر" - رقم يقدر يستخدم كل أوامر التحكم دي من رقمه هو مباشرة (مش لازم رسائلي)
    // ملحوظة: الأمر ده بس مسموح من رسائلي (رقم البوت نفسه)، مش من محرر تاني، لتفادي أي محرر يضيف محررين لوحده
    const addEditorMatch = toWesternDigits(text).match(/^اضف\s*محرر\s+(\d{8,15})$/i);
    if (addEditorMatch) {
      if (!msg.isSelfChatCommand) {
        await msg.reply("⚠️ الأمر ده بس متاح من محادثة رسائلي (رقم البوت نفسه).");
        return;
      }
      const phone = addEditorMatch[1];
      const added = editorStore.addEditor(phone);
      await msg.reply(
        added
          ? `✅ تمت إضافة ${phone} كمحرر - يقدر يستخدم كل أوامر التحكم دي من رقمه هو.`
          : `ℹ️ الرقم ${phone} مضاف بالفعل.`
      );
      return;
    }

    const removeEditorMatch = toWesternDigits(text).match(/^احذف\s*محرر\s+(\d{8,15})$/i);
    if (removeEditorMatch) {
      if (!msg.isSelfChatCommand) {
        await msg.reply("⚠️ الأمر ده بس متاح من محادثة رسائلي (رقم البوت نفسه).");
        return;
      }
      const phone = removeEditorMatch[1];
      const removed = editorStore.removeEditor(phone);
      await msg.reply(removed ? `✅ تم حذف ${phone} من المحررين.` : `ℹ️ الرقم ${phone} مش موجود أصلًا.`);
      return;
    }

    if (/^محررين$/i.test(text)) {
      const editors = editorStore.getEditors();
      const listText = editors.length ? editors.join("\n") : "لا يوجد";
      await msg.reply(`✏️ المحررون المسموح لهم بأوامر التحكم:\n\n${listText}`);
      return;
    }

    // فحص فوري لنظام البطاقات وإرسال أي جديد، من غير ما ننتظر الفحص الدوري
    if (/^مزامنة النظام$/i.test(text)) {
      if (!portalSync.isConfigured()) {
        await msg.reply(
          '⚠️ نظام البطاقات مش متظبّط. انسخ portal_config.example.js لـ portal_config.js على الجهاز واملأ بياناتك.'
        );
        return;
      }
      await msg.reply("🔄 جاري فحص نظام البطاقات...");
      const started = await runExclusive("مزامنة النظام", async () => {
        // بنلف runPortalSyncOnce بمحاولة/مسك خاصة بيها هنا عشان لو حصل أي خطأ (زي مشاكل السكرابينج)
        // يوصلك رد فعلي بدل ما يتبلع جوه runExclusive ومتوصلكش أي رسالة خالص
        try {
          const resultText = await runPortalSyncOnce();
          await msg.reply(resultText);
        } catch (err) {
          await msg.reply(`⚠️ حصل خطأ أثناء المزامنة: ${err.message}`);
        }
      });
      if (!started) await msg.reply("⚠️ فيه عملية إرسال شغالة بالفعل، استنى تخلص وحاول تاني.");
      return;
    }
  } catch (err) {
    console.log(`⚠️ [أوامر واتساب] حصل خطأ: ${err.message}`);
  }
}

client.on("message_create", async (msg) => {
  if (!msg.fromMe) return; // بس رسائل صاحب رقم البوت نفسه (بما فيها ردود البوت العادية على المزارعين!)
  // بس محادثة "رسائلي" (Note to Self). في الوضع العادي to === from، بس في محادثة رسائلي
  // تحديدًا واتساب بيستخدم صيغة معرّف مختلفة (@lid) لحقل "to" غير مطابقة لـfrom. كان الكود القديم
  // بيعتبر أي "to" بصيغة @lid = رسائلي (خطأ فادح: أي رسالة بيبعتها البوت لأي حد تاني معرّفه
  // بصيغة @lid كانت بتتفسّر غلط كأمر تحكم من "رسائلي"). دلوقتي بنتأكد فعليًا إن المستلم هو
  // البوت نفسه (contact.isMe) قبل ما نعتبرها محادثة رسائلي.
  if (!(await isTrueSelfChat(msg))) return;

  msg.isSelfChatCommand = true;
  await handleControlCommand(msg);
});

console.log("🔌 [بدء] جاري نداء client.initialize() (فتح Chrome والاتصال بواتساب ويب)...");
client.initialize().catch((err) => {
  console.log(`🚨 [فشل التهيئة] client.initialize() رفض الـpromise: ${err.message}`);
  process.exit(1);
});
