console.log(`🚀 [بدء] السكريبت بدأ التنفيذ - ${new Date().toISOString()} - Node ${process.version}`);

const fs = require("fs");
const path = require("path");
const { Client, LocalAuth, List, MessageMedia } = require("whatsapp-web.js");
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
const { buildPendingItemsReport, formatPendingItemsReport } = require("./lib/pendingItemsReport");
const { buildDeliveryDailyReport, formatDeliveryDailyReport } = require("./lib/deliveryReport");
const { applyDeliveredFromPortal, saveDeliveredSnapshot, matchDelivered } = require("./lib/portalDeliveryCheck");
const { buildFullReport, formatFullReportMessage, formatPrepList, buildFullReportBuffer, reportFileName, buildPrepBuffer, prepFileName } = require("./lib/deliveryFullReport");
const { parseOutcomeCommand, buildFailedNotice, platformNumberFor, classifyFreeText, extractRequestId } = require("./lib/deliveryOutcome");
const deliveryStore = require("./lib/deliveryStore");
const deliveryFlow = require("./lib/deliveryFlow");
const sentEcho = require("./lib/sentEcho");
const adminStore = require("./lib/adminStore");
const staffStore = require("./lib/staffStore");
const textStore = require("./lib/textStore");
const editorStore = require("./lib/editorStore");
const driveWatcher = require("./lib/driveWatcher");
const portalSync = require("./lib/portalSync");
const codeUpdateWatcher = require("./lib/codeUpdateWatcher");
const gitAutoUpdate = require("./updater/gitAutoUpdate");
const sendLog = require("./lib/sendLog");
const campaignCheck = require("./lib/campaignCheck");
const cardNoticeVerify = require("./lib/cardNoticeVerify");
const surveyRecipients = require("./lib/surveyRecipients");
const { isArabicName } = require("./lib/arabicNameGuard");
const sentTracker = require("./lib/sentTracker");
const { parseCsv, csvField } = require("./lib/csvUtil");
const farmerState = require("./lib/farmerState");
const ticketStore = require("./lib/ticketStore");
const sessionStore = require("./lib/sessionStore");
const rateLimiter = require("./lib/rateLimiter");
const safeJsonStore = require("./lib/safeJsonStore");
const { normalizeSaudiPhone, isValidSaudiPhone } = require("./lib/phoneUtil");
const farmerRegistry = require("./lib/farmerRegistry");
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
    let matched = !!rawNumber && phoneList.includes(rawNumber);
    if (!matched) {
      // getContact أحيانًا بيرجّع الـLID نفسه بدل الرقم (وده سبب رفض أوامر الأدمن) - بنجرب ذاكرة
      // الـLID ثم client.getContactLidAndPhone اللي بترجع الرقم الحقيقي
      let pn = deliveryStore.lookupLid(chatId);
      if (!pn) {
        try {
          const res = await boundedCall("lid-phone", () => client.getContactLidAndPhone([chatId]));
          pn = res && res[0] && res[0].pn ? String(res[0].pn).replace(/@.*/, "") : "";
          if (pn) deliveryStore.cacheLid(chatId, pn);
        } catch (e) {
          console.log(`⚠️ [تحقق هوية] getContactLidAndPhone فشل: ${e.message}`);
        }
      }
      if (pn && phoneList.includes(pn)) matched = true;
      console.log(`ℹ️ [تحقق هوية] ترجمة ثانية للـLID -> "${pn || "؟"}" (${matched ? "متطابق" : "مش متطابق"})`);
    }
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

// بيبعت نص لـ"رسائلي" (رقم البوت نفسه) + كل أرقام المديرين - استخدام عام لأي تنبيه إداري
// (زي نتيجة تحديث GitHub التلقائي)، كل رقم لوحده جوّه try/catch عشان فشل واحد ما يمنعش الباقي
async function notifyAdmins(text) {
  const selfChatId = client.info && client.info.wid ? client.info.wid._serialized : null;
  const recipients = [...(selfChatId ? [selfChatId] : []), ...getAdminChatIds()];
  for (const chatId of recipients) {
    try {
      await client.sendMessage(chatId, text);
    } catch (err) {
      console.log(`⚠️ فشل إرسال تنبيه إداري لـ ${chatId}: ${err.message}`);
    }
  }
}

const REPORT_HOUR = 20; // الساعة اللي بيتبعت فيها التقرير اليومي تلقائيًا (بتوقيت الجهاز)
let lastReportSentDate = null;
const PENDING_REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000; // كل 4 ساعات - بطلب صريح من الإدارة
let lastPendingReminderAt = 0;

const DELIVERY_REPORT_HOUR = 10; // تقرير طلبات التوصيل اليومي بيتبعت الساعة 10 صباحًا (بتوقيت الجهاز)
let lastDeliveryReportSentDate = null;

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

// أي نص بيبعته البوت (رسائل حملات/ردود) بنفتكره شوية عشان نتجاهل صداه لو رجع كرسالة "واردة"
const originalSendMessage = client.sendMessage.bind(client);
client.sendMessage = async (to, content, options) => {
  if (typeof content === "string") sentEcho.remember(content);
  return originalSendMessage(to, content, options);
};

// حماية: بعض تحديثات واتساب ويب بتكسر مكتبة whatsapp-web.js مؤقتًا
// (مشكلة معروفة وموثقة في المكتبة نفسها، مش في كودنا) وبتسبب كراش كامل للبوت.
// السطرين دول بيمنعوا أي خطأ غير متوقع من إيقاف العملية بالكامل.
process.on("unhandledRejection", (err) => {
  console.log(`⚠️ خطأ غير متوقع (تم تجاهله عشان البوت يفضل شغال): ${err.message}`);
});
process.on("uncaughtException", (err) => {
  console.log(`⚠️ خطأ غير متوقع (تم تجاهله عشان البوت يفضل شغال): ${err.message}`);
});

// معرّف الرسالة بصيغة قابلة للاستخدام كـquotedMessageId - رسائل @lid بترجّع معرّفها تحت اسم $1
// بدل _serialized (نفس مشكلة LID Migration الموثقة في lib/downloadMediaCompat.js)
function messageId(msg) {
  const id = msg.id || {};
  return id._serialized || id.$1 || null;
}

// نسخة آمنة من الرد بترجع false لو فشلت بدل ما توقف البوت كله. msg.reply() بتفشل مع رسائل @lid
// (بتعتمد على _serialized اللي مبقاش موجود في الصيغة دي) - fallback: نبعت رسالة عادية لنفس
// الشات مع quotedMessageId محسوب يدويًا، بدل ما نسيب المزارع من غير أي رد خالص
// بيضيف تذييل "للرجوع للقائمة الرئيسية اضغط 0" آخر أي رد للمزارع - إلا لو النص أصلًا فيه
// خيار الرجوع للقائمة (زي القائمة الرئيسية نفسها ورسالة "اختيار غير صحيح") عشان منكررهوش
function appendMenuFooter(text) {
  // أي ذكر لـ"القائمة الرئيسية" في النص معناه فيه أصلًا طريقة مذكورة للرجوع ليها (سواء بـ0 أو
  // رقم تاني زي "4. الرجوع إلى القائمة الرئيسية" في قائمة نوع التذكرة) - منضيفش فوق كده تاني
  // عشان منتعارضش مع رقم مختلف مذكور فعلًا (كان بيحصل مع "للعودة" لأنها من غير همزة "ا")
  if (text.includes("القائمة الرئيسية")) return text;
  return `${text}\n\n${getCfgText("MENU_FOOTER")}`;
}

async function safeReply(msg, text) {
  const finalText = appendMenuFooter(text);
  try {
    await msg.reply(finalText);
    return true;
  } catch (err) {
    console.log(`⚠️ فشل إرسال رد عادي (${err.message}) - بجرّب رد بديل (مشكلة @lid معروفة)...`);
    try {
      const quotedId = messageId(msg);
      await boundedCall("safe-reply-fallback", () => client.sendMessage(msg.from, finalText, quotedId ? { quotedMessageId: quotedId } : undefined), 15000);
      return true;
    } catch (err2) {
      console.log(`⚠️ فشل الرد البديل كمان: ${err2.message}`);
      return false;
    }
  }
}

// قفل نظيف بدل process.exit() مباشر: بنستنى أي عملية إرسال شغالة فعليًا تخلص (لحد 30 ثانية)،
// وبعدين نقفل جلسة واتساب (client.destroy()) بمهلة 15 ثانية قبل ما نقفل العملية. من غير كده
// Chrome بيفضل فاتح ماسك ملفات الجلسة، والتشغيلة الجاية (PM2) بتعلّق من غير ما تعرف تفتح واتساب
// من غير أي خطأ ظاهر في اللوج - أصعب حاجة تتشخّص لأنها "مفيش خطأ" أصلاً
let exiting = false;
async function gracefulExit(code, reason) {
  if (exiting) return;
  exiting = true;
  console.log(`🛑 [إغلاق نظيف] بيقفل (${reason})...`);
  const deadline = Date.now() + 30000;
  while (broadcastInProgress && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  await Promise.race([client.destroy().catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
  process.exit(code);
}

client.on("qr", (qr) => {
  console.log("امسح رمز QR ده بواتساب (الأجهزة المرتبطة > ربط جهاز):");
  qrcode.generate(qr, { small: true });
  // نسخة صفحة HTML بتتحدّث تلقائيًا (QR الطرفية بيتقصّ على الشاشات الصغيرة) - افتحها بأي متصفح على الجهاز
  try {
    const file = require("./lib/qrFile").writeQrHtml(qr);
    console.log(`🖼️ رمز QR كصفحة (أسهل في المسح): افتح الملف ده بالمتصفح: ${file}`);
  } catch (err) {
    console.log(`⚠️ تعذّر كتابة صفحة QR: ${err.message}`);
  }
});

// لو حصل انقطاع في الاتصال (نت اتقطع، الكهربا رجعت، جلسة واتساب اتلغت...)
// أضمن حاجة إن البوت يقفل نفسه بنظافة، وPM2 هيرجّعه يشتغل تلقائيًا من الصفر بعد ثواني
client.on("disconnected", (reason) => {
  console.log(`⚠️ انقطع الاتصال بواتساب (${reason}). البوت هيتقفل عشان PM2 يرجّعه يشتغل تلقائيًا...`);
  gracefulExit(1, "انقطع الاتصال بواتساب");
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
const READY_TIMEOUT_MS = 240000;
const readyTimeout = setTimeout(() => {
  console.log(
    `🚨 [مهلة الاتصال] البوت ما اتصلش بواتساب خلال ${READY_TIMEOUT_MS / 1000} ثانية من بدء التشغيل - ` +
      `غالبًا مشكلة في تشغيل Chrome (عمليات عالقة/قلة رام/ملف قفل). هيتقفل عشان PM2 يرجّعه من جديد.`
  );
  gracefulExit(1, "التشغيل علّق");
}, READY_TIMEOUT_MS);
client.on("ready", () => clearTimeout(readyTimeout));

// Chrome ممكن يعلّق وهو شغّال (خصوصًا مع الرام العالية على الجهاز ده) والبوت يفضل "online" في
// PM2 وهو فعليًا مش بيستقبل ولا بيبعت حاجة. كل 5 دقايق بنسأل واتساب عن حالته؛ 3 فشلات ورا بعض
// (بمهلة دقيقة لكل محاولة) = نقفل بنظافة وPM2 يعيد التشغيل
let watchdogFailures = 0;
setInterval(async () => {
  if (!client.info || exiting) return;
  try {
    const state = await boundedCall("watchdog-getState", () => client.getState(), 60000);
    if (state !== "CONNECTED") throw new Error(String(state));
    watchdogFailures = 0;
  } catch (err) {
    watchdogFailures++;
    console.log(`⚠️ [صحة البوت] فحص حالة واتساب فشل (${watchdogFailures}/3): ${err.message}`);
    if (watchdogFailures >= 3) gracefulExit(1, "واتساب مش بيستجيب");
  }
}, 5 * 60 * 1000);

// Chrome يتيم من تشغيلة قبل كده لسه ماسك جلسة البوت ده بالتحديد (بمجلد المشروع ده - مش بوت
// تاني شغّال على نفس الجهاز زي work-order-bot، وده مهم جدًا نتجنبه)
function killOrphanChrome() {
  if (process.platform !== "win32") return;
  try {
    const marker = __dirname.replace(/\\/g, "\\\\").replace(/'/g, "''");
    const ps =
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`;
    const killed = require("child_process")
      .execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 30000 })
      .trim();
    if (killed) console.log(`🧹 [بدء] اتقفلت عمليات Chrome يتيمة كانت ماسكة جلسة البوت ده: ${killed.split(/\s+/).join(", ")}`);
  } catch (err) {
    console.log(`⚠️ [بدء] تعذّر البحث عن Chrome يتيم: ${err.message}`);
  }
}
killOrphanChrome();

// إصلاح دفاعي لإرسال الملفات (مش بيصلح باگ نشط حاليًا - البوت ده بيستقبل ملفات بس، مايبعتش
// ملفات لمزارعين/مجموعات لحد دلوقتي) - بس لو أي ميزة مستقبلية بعتت ملف، نفس المشكلة الموثقة في
// whatsapp-web.js 1.34.7 مع واتساب ويب 2.3000.10477+ (processMediaData بيرجّع __x_id فاضي
// فيغطّي على id الرسالة) هتحصل. التصحيح جوّه الصفحة نفسها (مش تعديل node_modules) عشان يفضل
// شغّال بعد أي npm install. مرجع: whatsapp-web.js#201921
async function patchMediaSend() {
  try {
    const patched = await boundedCall(
      "patch-media-send",
      () =>
        client.pupPage.evaluate(() => {
          const W = window.WWebJS;
          if (!W || !W.processMediaData) return false;
          if (W.__mediaIdPatch) return true;
          const orig = W.processMediaData;
          W.processMediaData = async (...args) => {
            const data = await orig(...args);
            const copy = { ...data };
            delete copy.__x_id;
            return copy;
          };
          W.__mediaIdPatch = true;
          return true;
        }),
      10000
    );
    if (!patched) console.log("⚠️ [بدء] مقدرتش أطبّق إصلاح إرسال الملفات الدفاعي (مش مؤثر حاليًا - البوت مايبعتش ملفات).");
  } catch (err) {
    console.log(`⚠️ [بدء] فشل تطبيق إصلاح إرسال الملفات الدفاعي: ${err.message}`);
  }
}

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
  patchMediaSend();
  notifyGitUpdateIfPending();
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
  startGitAutoUpdateWatcher();
  console.log(`🔄 تحديث GitHub تلقائي مفعّل - هيتفحص كل ${GIT_AUTO_UPDATE_INTERVAL_MS / 60000} دقايق ويسحب أي كود جديد بعد ما يتأكد إنه سليم.`);
});

const REGISTRATION_CSV = path.join(__dirname, "registration_status.csv");
const CARD_PICKUP_CSV = path.join(__dirname, "card_pickup.csv");
// أقصى عدد إشعارات استلام بيتبعتوا في المزامنة الواحدة (كل 30 دقيقة) - إشعارات النظام مش خاضعة لحد الحملات،
// فالسقف ده بيمنع إرسال مئات الرسائل دفعة واحدة (حظر واتساب). الباقي بيكمّل في المزامنات اللي بعدها
const CARD_PICKUP_BATCH_CAP = 25;
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
    // حالة انتظار رد "استلام/توصيل" بتتفعّل بس لو نص الرسالة المُرسلة فعلًا بيعرض خيار التوصيل
    onSent: ({ phone, name }) => {
      if (deliveryStore.templateOffersDelivery(getCfgText("CARD_PICKUP_TEMPLATE"))) {
        deliveryStore.markAwaitingChoice(phone, name);
      }
    },
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
    const printedResult = await portalSync.syncPrintedCards(Infinity, CARD_PICKUP_BATCH_CAP);
    cardKeys = portalSync.buildKeySet(printedResult.rows); // مفاتيح جوال+هوية لكل مزارع في قسم البطاقات
    if (printedResult.count > 0) {
      await sendCardPickupBroadcast();
      summary.printed = printedResult.count;
    }
    // تحقق إن كل بطاقة جاهزة اتبعتلها إشعار الاستلام فعلًا - وأي مشكلة بتتبلّغ لموظف التجهيز
    await verifyCardNotices(printedResult.rows);

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
      // بطلب من الإدارة: مزامنة المنصة كل نص ساعة. الحد الأقصى 30 دقيقة حتى لو الإعداد القديم 60؛
      // ولو الإعداد أقل (مثلًا 15) بنحترمه
      return Math.min(require("./portal_config").CHECK_INTERVAL_MINUTES || 30, 30);
    } catch {
      return 30;
    }
  })();

  const now = Date.now();
  if (now - lastPortalSyncAt < cfgIntervalMinutes * 60 * 1000) return;
  lastPortalSyncAt = now;

  await runExclusive("نظام البطاقات", async () => {
    const resultText = await runPortalSyncOnce();
    console.log(`🔄 [نظام البطاقات] ${resultText}`);
    // بعد المزامنة: تأكيد تسليم طلبات التوصيل من تاب "Delivered" في المنصة (من غير ما نستنى الموظف)
    try {
      const reconcileText = await boundedCall("deliveries-reconcile", () => reconcileDeliveriesWithPortal(), 9 * 60 * 1000);
      console.log(`🚚 [تسليم المنصة] ${reconcileText}`);
      await autoSendSurvey(reconcileDeliveriesWithPortal.lastRows);
    } catch (err) {
      console.log(`⚠️ [تسليم المنصة] تعذّر الفحص: ${err.message}`);
    }
  });
}

// قبل أي تقرير يومي (توصيل/تجهيز) بنحدّث تسليم الطلبات من المنصة عشان التقرير يعكس آخر وضع فعلي.
// لو فيه فحص حصل في آخر 10 دقائق، أو مهمة تانية شغّالة، أو المنصة مش متظبّطة - بنكمّل بالبيانات الحالية
async function refreshDeliveriesBeforeReport() {
  if (!portalSync.isConfigured()) return;
  if (Date.now() - lastDeliveryReconcileAt < 10 * 60 * 1000) return;
  if (broadcastInProgress) return;
  broadcastInProgress = true;
  try {
    console.log(`🚚 [تسليم المنصة] ${await boundedCall("deliveries-refresh", () => reconcileDeliveriesWithPortal(), 9 * 60 * 1000)} (قبل التقرير اليومي)`);
  } catch (err) {
    console.log(`⚠️ [تسليم المنصة] تعذّر التحديث قبل التقرير - هنكمّل بالبيانات الحالية: ${err.message}`);
  } finally {
    broadcastInProgress = false;
  }
}

// بيقرا تاب "Delivered" من المنصة ويطابقه مع طلبات التوصيل المفتوحة/المتعذّرة، وأي طلب ظاهر
// هناك بيتسجّل "تم التوصيل" (مصدره "portal") - مع إشعار في مجموعة منطقته. بيرجّع نص ملخّص
// رقم موظف تجهيز البطاقات اللي بتوصله تنبيهات مشاكل إرسال إشعار الاستلام (+ أي رقم مسجّل بأمر
// "اضف رقم تجهيز البطاقات")
const CARD_ISSUE_ALERT_DEFAULT = "966535571579";

// بعد كل مزامنة: كل بطاقة جاهزة (Printed/Pending Delivery) لازم يكون وصلها إشعار "جاهزة للاستلام".
// اللي ما وصلهاش بيتحدّد سببه (مش على واتساب/رقم غلط/اسم غير عربي...) وبيتبعت تنبيه لموظف التجهيز
async function verifyCardNotices(rows) {
  try {
    const decisions = new Map();
    require("./lib/auditLog").readAll().forEach((e) => {
      if (e.campaignType === "card_pickup" && e.normalizedPhone) decisions.set(e.normalizedPhone, e);
    });
    const result = cardNoticeVerify.verify(rows, {
      hasBeenSent: (phone) => sentTracker.hasBeenSent("card_pickup", phone),
      lastDecision: (phone) => decisions.get(phone) || null,
    });
    const real = result.problems.filter((p) => !p.temporary);
    console.log(`📬 [تحقق الإشعارات] ${result.total} بطاقة جاهزة: وصل الإشعار لـ ${result.sent}، مشاكل: ${real.length}${result.problems.length > real.length ? ` (+${result.problems.length - real.length} مؤقتة بسبب حد الإرسال)` : ""}.`);

    const state = cardNoticeVerify.loadIssueState();
    cardNoticeVerify.trackFirstSeen(result.problems, state);
    const toNotify = cardNoticeVerify.selectToNotify(result.problems, state);
    if (toNotify.length > 0) {
      const recipients = [...new Set([...deliveryStore.getPrepRecipients(), CARD_ISSUE_ALERT_DEFAULT])];
      const text = cardNoticeVerify.formatAlert(result, toNotify);
      let delivered = 0;
      for (const phone of recipients) {
        try {
          await boundedCall("card-issue-alert", () => client.sendMessage(`${phone}@c.us`, text), 20000);
          delivered++;
        } catch (err) {
          console.log(`⚠️ [تحقق الإشعارات] فشل إرسال التنبيه لـ ${phone}: ${err.message}`);
        }
      }
      if (delivered > 0) cardNoticeVerify.markNotified(toNotify, state);
    }
    cardNoticeVerify.pruneResolved(result.problems, state);
    cardNoticeVerify.saveIssueState(state);
  } catch (err) {
    console.log(`⚠️ [تحقق الإشعارات] تعذّر التحقق: ${err.message}`);
  }
}

// ===== استبيان الإنتاج الزراعي للمزارعين اللي استلموا بطاقاتهم =====
// المصدر: تاب "Delivered" في المنصة. الاسم لازم عربي موثوق (طلب توصيل سابق بالجوال، أو سجل المزارعين،
// أو الاسم العربي من تفاصيل المنصة) - غير كده الرسالة بتتمنع (BLOCKED_NON_ARABIC_NAME) زي باقي الحملات.
const SURVEY_CSV = path.join(__dirname, "production_survey.csv");
const SURVEY_AUTO_BATCH = 10; // أقصى عدد بيتبعتلهم تلقائيًا في كل مزامنة (حماية من حظر واتساب)

function resolveSurveyName(phone, candidate) {
  const req = deliveryStore.getAllRequests().find((r) => r.phone === phone && r.name && isArabicName(r.name));
  if (req) return req.name;
  return farmerRegistry.resolveTrustedArabicName(phone, candidate);
}

function selectSurvey(rows, limit = Infinity) {
  return surveyRecipients.selectSurveyRecipients(
    rows,
    { hasBeenSent: (phone) => sentTracker.hasBeenSent("production_survey", phone), resolveName: resolveSurveyName },
    limit
  );
}

async function sendProductionSurveyBroadcast() {
  return runPersonalizedBroadcast(client, {
    csvPath: SURVEY_CSV,
    columns: ["name", "phone"],
    template: getCfgText("PRODUCTION_SURVEY_TEMPLATE"),
    logFile: path.join(__dirname, "production-survey-log.txt"),
    logLabel: "استبيان الإنتاج",
    campaignType: "production_survey",
    messageSource: "CAMPAIGN",
  });
}

// تلقائيًا بعد كل فحص تسليم: أي مزارع ظاهر "Delivered" ولسه ما اتبعتلوش الاستبيان بيتبعتله (بس لو
// الإرسال التلقائي اتفعّل بتأكيد صريح من الأدمن، عشان ما نبعتش لكل المستلمين القدام من غير موافقة)
async function autoSendSurvey(rows) {
  const state = surveyRecipients.loadState();
  if (!state.autoEnabled || !Array.isArray(rows) || rows.length === 0) return;
  let sel = selectSurvey(rows, SURVEY_AUTO_BATCH);
  // أسماء الجدول العادي إنجليزي - لو فيه مستلمين من غير اسم عربي موثوق، بنقرا الأسماء العربية من تفاصيل
  // المنصة (بطيء، فمرة كل 12 ساعة بس) وبتتحفظ في سجل المزارعين فيتبعتلهم بعدها
  if (sel.blocked.length > 0 && Date.now() - (state.lastNameScrapeAt || 0) > 12 * 60 * 60 * 1000) {
    surveyRecipients.saveState({ ...state, lastNameScrapeAt: Date.now() });
    try {
      console.log(`🔎 [استبيان] ${sel.blocked.length} مستلم بدون اسم عربي - بقرا الأسماء العربية من تفاصيل المنصة...`);
      const detailed = await boundedCall("survey-names", () => require("./lib/portalScraper").fetchIssuingByTab("تم التسليم", 1000), 12 * 60 * 1000);
      selectSurvey(detailed); // بيحفظ الأسماء العربية في السجل (resolveTrustedArabicName)
      sel = selectSurvey(rows, SURVEY_AUTO_BATCH);
    } catch (err) {
      console.log(`⚠️ [استبيان] تعذّر قراءة الأسماء العربية: ${err.message}`);
    }
  }
  if (sel.blocked.length) console.log(`📝 [استبيان] ${sel.blocked.length} مزارع مستلم بدون اسم عربي موثوق - مش هيتبعتلهم.`);
  if (sel.send.length === 0) return;
  fs.writeFileSync(SURVEY_CSV, farmerRowsToCsvText(sel.send.map((r) => ({ name: r.name, phone: r.phone })), false), "utf8");
  console.log(`📢 [استبيان] بإرسال الاستبيان لـ ${sel.send.length} مزارع استلموا بطاقاتهم حديثًا...`);
  await sendProductionSurveyBroadcast();
}

let lastDeliveryReconcileAt = 0;
async function reconcileDeliveriesWithPortal() {
  lastDeliveryReconcileAt = Date.now();
  const open = deliveryStore.getAllRequests().filter((r) => r.status === "NEW" || r.status === "FAILED_DELIVERY");
  const scraper = require("./lib/portalScraper");
  const rows = await scraper.fetchDeliveredRows();
  const expected = rows.expected;
  // لو القراءة ناقصة (الترقيم ما اشتغلش) نبحث بالجوال في تاب Delivered عن الطلبات اللي لسه مفتوحة بس
  if (expected && rows.length < expected && open.length > 0) {
    const matchedIds = new Set(matchDelivered(open, rows, platformNumberFor).map((m) => m.request.id));
    const phones = [...new Set(open.filter((r) => !matchedIds.has(r.id)).map((r) => r.phone))];
    if (phones.length) {
      console.log(`🔎 [تسليم المنصة] القراءة ناقصة (${rows.length}/${expected}) - بحث بالجوال لـ${phones.length} طلب مفتوح...`);
      const extra = await boundedCall("deliveries-search", () => scraper.fetchDeliveredByPhones(phones), 5 * 60 * 1000);
      extra.forEach((r) => rows.push(r));
    }
    rows.expected = expected;
    rows.searched = true;
  }
  saveDeliveredSnapshot(rows);
  reconcileDeliveriesWithPortal.lastRows = rows;
  const updated = applyDeliveredFromPortal(rows, platformNumberFor);
  const groups = deliveryStore.getGroups();
  for (const u of updated) {
    const groupId = groups[u.regionKey];
    if (!groupId) continue;
    try {
      await boundedCall("portal-delivered-notice", () => client.sendMessage(groupId, `✅ الطلب ${u.id} (${u.name || u.phone}) ظاهر "تم التسليم" في المنصة - تم تسجيله توصيلًا.`), 15000);
    } catch (err) {
      console.log(`⚠️ [تسليم المنصة] فشل إشعار المجموعة لـ${u.id}: ${err.message}`);
    }
  }
  const expectedNote = rows.searched ? ` (التاب بيعرض ${rows.expected}، قرأنا بالترقيم جزء وبحثنا بالجوال عن الطلبات المفتوحة)` : rows.expected && rows.expected !== rows.length ? ` (⚠️ التاب بيعرض ${rows.expected} - القراءة ناقصة)` : "";
  const text = `قرأت ${rows.length} بطاقة "تم التسليم" من المنصة${expectedNote}، وتأكّد تسليم ${updated.length} من ${open.length} طلب مفتوح.`;
  reconcileDeliveriesWithPortal.lastUpdated = updated;
  return text;
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

const GIT_AUTO_UPDATE_INTERVAL_MS = 10 * 60 * 1000; // كل 10 دقائق - تحديث تلقائي من GitHub من غير أي تدخل يدوي
const GIT_UPDATE_NOTICE_FILE = path.join(__dirname, "git_update_pending_notice.json");
let gitUpdateFailureNotifiedFor = null; // آخر remoteHash اتبعت عنه تنبيه فشل - عشان منكررش نفس التنبيه كل 10 دقايق

// بيتأكد دوريًا هل فيه Commit جديد على origin/main، ولو فيه بيسحبه ويتأكد إنه سليم (صياغة +
// كل اختبارات طبقة الأمان) قبل ما يعيد تشغيل نفسه بيه - تمامًا زي "تحديث الكود" (مجلد درايف)
// بس المصدر هنا GitHub مباشرة بدل ملف بيتحط يدويًا. لو الفحص فشل، الكود بيرجع لآخر نسخة سليمة
// تلقائيًا ومفيش أي إعادة تشغيل - البوت فاضل شغّال بالكود القديم الآمن من غير أي انقطاع
function startGitAutoUpdateWatcher() {
  setInterval(async () => {
    if (broadcastInProgress) return; // مانوقفش وسط إرسال حملة شغّالة فعليًا
    try {
      const result = await gitAutoUpdate.pullAndVerify();
      if (result.aborted) {
        const stageLabel = result.stage === "npm_install" ? `npm install فشل: ${result.error}` : result.stage;
        console.log(
          `🚨 [تحديث GitHub تلقائي] وصل كود جديد (${result.fromHash.slice(0, 7)} -> ${result.attemptedHash.slice(0, 7)}) لكن فشل (${stageLabel}) - تم الرجوع للكود القديم تلقائيًا، البوت مستمر بالكود الحالي من غير تأثير.`
        );
        // تنبيه مرة واحدة بس لكل remoteHash فاشل - عشان لو فضل فاشل، مش هيبعت نفس التنبيه كل 10 دقايق
        if (gitUpdateFailureNotifiedFor !== result.attemptedHash) {
          gitUpdateFailureNotifiedFor = result.attemptedHash;
          await notifyAdmins(
            `🚨 تحديث GitHub تلقائي فشل (${result.fromHash.slice(0, 7)} -> ${result.attemptedHash.slice(0, 7)})\n\nالسبب: ${stageLabel}\n\nتم الرجوع تلقائيًا للكود القديم السليم - البوت مستمر بدون أي تأثير. محتاج مراجعة يدوية للكود الجديد قبل أي محاولة تانية.`
          ).catch(() => {});
        }
        return;
      }
      if (result.updated) {
        console.log(
          `🔄 [تحديث GitHub تلقائي] كود جديد اتسحب ونجح في كل الفحوصات (${result.fromHash.slice(0, 7)} -> ${result.toHash.slice(0, 7)}) - البوت هيعيد تشغيل نفسه دلوقتي عشان الكود الجديد يشتغل...`
        );
        // بنسجّل تفاصيل التحديث في ملف عشان نبلّغ الأدمن بعد ما البوت يرجع يشتغل بالكود الجديد
        // (مش قبل كده - العملية هتتقفل فورًا فمفيش وقت نبعت فيه دلوقتي)
        try {
          fs.writeFileSync(GIT_UPDATE_NOTICE_FILE, JSON.stringify({ fromHash: result.fromHash, toHash: result.toHash, ranInstall: result.ranInstall, at: new Date().toISOString() }), "utf8");
        } catch (writeErr) {
          console.log(`⚠️ [تحديث GitHub تلقائي] فشل حفظ ملف التنبيه: ${writeErr.message}`);
        }
        gracefulExit(0, "تحديث GitHub تلقائي");
      }
    } catch (err) {
      console.log(`⚠️ [تحديث GitHub تلقائي] تعذّر فحص/سحب التحديث: ${err.message}`);
    }
  }, GIT_AUTO_UPDATE_INTERVAL_MS);
}

// لو البوت رجع يشتغل بسبب تحديث GitHub تلقائي (ملف التنبيه موجود من قبل القفلة)، بنسجّل النجاح
// في اللوج بس (بطلب من الإدارة - مفيش داعي لرسالة واتساب لكل تحديث ناجح، غير الفشل اللي
// لسه بيتبعت تنبيه عليه لأنه بيحتاج مراجعة فعلية) ونمسح الملف عشان منعالجوش تاني
async function notifyGitUpdateIfPending() {
  if (!fs.existsSync(GIT_UPDATE_NOTICE_FILE)) return;
  try {
    const info = JSON.parse(fs.readFileSync(GIT_UPDATE_NOTICE_FILE, "utf8"));
    fs.unlinkSync(GIT_UPDATE_NOTICE_FILE);
    console.log(
      `✅ [تحديث GitHub تلقائي] نجح (${info.fromHash.slice(0, 7)} -> ${info.toHash.slice(0, 7)})${info.ranInstall ? " - شمل npm install" : ""} - البوت شغّال بالكود الجديد ومتصل بواتساب.`
    );
  } catch (err) {
    console.log(`⚠️ فشل معالجة ملف تنبيه اكتمال تحديث GitHub: ${err.message}`);
  }
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
      gracefulExit(0, "تحديث الكود اليدوي");
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
    await maybeSendPendingItemsReminder();
    await maybeSendDeliveryDailyReport();
    await maybeSendPrepListDaily();
    // ملحوظة: التقرير التلقائي متوقف بطلب الإدارة - المديرين هم اللي بيطلبوه يدويًا بكتابة "تقرير"
    // (الدالة maybeSendDailyReport باقية تحت من غير استدعاء، لو حبينا نرجّعها تاني في المستقبل)
  }, 2000);
}

// تذكير تلقائي بالحالات المعلّقة لمحادثة "رسائلي" بس (رقم البوت نفسه) كل PENDING_REMINDER_INTERVAL_MS
// - بطلب صريح من الإدارة. بيتبعت بس لو فيه حاجة معلّقة فعليًا (مفيش إزعاج برسالة فاضية كل مرة)
async function maybeSendPendingItemsReminder() {
  if (Date.now() - lastPendingReminderAt < PENDING_REMINDER_INTERVAL_MS) return;
  lastPendingReminderAt = Date.now();

  try {
    const data = await buildPendingItemsReport(client);
    const totalPending = data.handedOff.length + data.pendingDocuments.length + data.openTickets.length + data.openDeliveries.length;
    if (totalPending === 0) return;

    const selfChatId = client.info.wid._serialized;
    await client.sendMessage(selfChatId, formatPendingItemsReport(data));
    console.log(`🔔 اتبعت تذكير الحالات المعلّقة تلقائيًا لـ"رسائلي" (${totalPending} حالة معلّقة).`);
  } catch (err) {
    console.log(`⚠️ فشل إرسال تذكير المعلّقات التلقائي: ${err.message}`);
  }
}

// بيبعت تقرير طلبات التوصيل المفتوحة (مقسّم شمال/جنوب/وسط) تلقائيًا كل يوم الساعة
// DELIVERY_REPORT_HOUR لأي رقم مسجّل بأمر "اضف رقم تقرير التوصيل" - بطلب صريح من الإدارة
// بيبعت ملف Excel بتفاصيل طلبات التوصيل لمحادثة معيّنة (بيستخدم نفس الـdata اللي اتبنى منها النص)
async function sendDeliveryReportFile(chatId, data, kind = "full") {
  const prep = kind === "prep";
  const buffer = prep ? await buildPrepBuffer(data) : await buildFullReportBuffer(data);
  const media = new MessageMedia(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer.toString("base64"),
    prep ? prepFileName(data.now) : reportFileName(data.now)
  );
  // معرّف @lid بيفشل مع إرسال الملفات (getChat مكسورة) - بنفضّل رقم الجوال الحقيقي (@c.us) لو معروف
  const candidates = [];
  if (/@lid$/.test(chatId)) {
    const pn = deliveryStore.lookupLid(chatId);
    if (pn) candidates.push(`${pn}@c.us`);
  }
  candidates.push(chatId);
  let lastErr = null;
  for (const target of candidates) {
    try {
      console.log(`📎 [تقرير] بإرسال ملف Excel (${Math.round(buffer.length / 1024)}KB) إلى ${target}...`);
      await boundedCall("send-report-file", () => client.sendMessage(target, media, { sendMediaAsDocument: true }), 60000);
      console.log(`✅ [تقرير] اتبعت ملف Excel إلى ${target}.`);
      return;
    } catch (err) {
      lastErr = err;
      console.log(`⚠️ [تقرير] فشل إرسال ملف Excel إلى ${target}: ${err.message}`);
    }
  }
  throw lastErr;
}

// قائمة تجهيز البطاقات لفرق التسليم (حسب المنطقة) - بتتبعت يوميًا الساعة 10 صباحًا لموظف/موظفي
// التجهيز المسجّلين بأمر "اضف رقم تجهيز البطاقات"، منفصلة عن تقرير التوصيل (ملخص + Excel)
let lastPrepListSentDate = null;
async function maybeSendPrepListDaily() {
  const now = new Date();
  const today = todayStr(now);
  if (lastPrepListSentDate === today) return;
  if (now.getHours() < DELIVERY_REPORT_HOUR) return;
  lastPrepListSentDate = today;

  const recipients = deliveryStore.getPrepRecipients();
  if (recipients.length === 0) return;
  await refreshDeliveriesBeforeReport();
  const data = buildFullReport();
  const text = formatPrepList(data);
  const hasOpen = data.rows.some((r) => r.status === "NEW");
  for (const phone of recipients) {
    try {
      await client.sendMessage(`${phone}@c.us`, text);
      if (hasOpen) await sendDeliveryReportFile(`${phone}@c.us`, data, "prep");
    } catch (err) {
      console.log(`⚠️ فشل إرسال قائمة تجهيز البطاقات لـ ${phone}: ${err.message}`);
    }
  }
  console.log(`📋 اتبعت قائمة تجهيز البطاقات لـ ${recipients.length} رقم.`);
}

async function maybeSendDeliveryDailyReport() {
  const now = new Date();
  const today = todayStr(now);
  if (lastDeliveryReportSentDate === today) return;
  if (now.getHours() < DELIVERY_REPORT_HOUR) return;
  lastDeliveryReportSentDate = today;

  const recipients = deliveryStore.getReportRecipients();
  if (recipients.length === 0) return;
  await refreshDeliveriesBeforeReport();

  try {
    const data = buildFullReport();
    const text = formatFullReportMessage(data);
    for (const phone of recipients) {
      try {
        await client.sendMessage(`${phone}@c.us`, text);
        if (data.total > 0) await sendDeliveryReportFile(`${phone}@c.us`, data);
      } catch (err) {
        console.log(`⚠️ فشل إرسال تقرير التوصيل اليومي لـ ${phone}: ${err.message}`);
      }
    }
    console.log(`🚚 اتبعت تقرير طلبات التوصيل اليومي لـ ${recipients.length} رقم (${data.total} طلب، ${data.open} مفتوح).`);
  } catch (err) {
    console.log(`⚠️ فشل تجهيز تقرير التوصيل اليومي: ${err.message}`);
  }
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

// رقم جوال المزارع الحقيقي (966...) لمطابقته بحالة انتظار "استلام/توصيل" المحفوظة برقمه. المعرّف
// الموحّد أحيانًا بيبقى @lid خام (مش رقم)، فبنجرب: المعرّف نفسه -> ذاكرة @lid السابقة ->
// client.getContactLidAndPhone (بس لو فيه فعلًا مزارعين منتظرين، عشان منسألش واتساب من غير داعي)
async function resolveFarmerPhone(msg, chatId) {
  const direct = String(chatId || "").replace(/@.*/, "");
  if (isValidSaudiPhone(direct)) return direct;
  const cached = deliveryStore.lookupLid(msg.from);
  if (cached) return cached;
  if (!deliveryStore.hasAnyPending()) return null;
  try {
    const result = await boundedCall("lid-phone", () => client.getContactLidAndPhone([msg.from]));
    const pn = result && result[0] && result[0].pn ? String(result[0].pn).replace(/@.*/, "") : "";
    if (isValidSaudiPhone(pn)) {
      deliveryStore.cacheLid(msg.from, pn);
      return pn;
    }
  } catch (err) {
    console.log(`⚠️ [توصيل] تعذّر ترجمة ${msg.from} لرقم جوال: ${err.message}`);
  }
  return null;
}

// تسجيل مجموعة توصيل: "ربط مجموعة الشمال|الجنوب|الوسط" بيتكتب جوّه المجموعة نفسها من مدير/محرر
// (أو من رقم البوت نفسه). بيحفظ معرّف المجموعة عشان بيانات التوصيل تتبعت لها
async function maybeRegisterDeliveryGroup(msg, groupId, senderId, trusted) {
  const m = toWesternDigits((msg.body || "").trim()).match(/^ربط\s*مجموعة\s*(الشمال|الجنوب|الوسط)$/);
  if (!m) {
    // تشخيص: أي رسالة جوّه مجموعة بتوصل هنا حتى لو مش أمر ربط - بنسجّلها بس لو شكلها قريبة من
    // "ربط مجموعة" (تفاديًا لتلويث اللوج بكل دردشة عادية جوّه المجموعات)
    if (/ربط/.test(msg.body || "")) {
      console.log(`ℹ️ [ربط مجموعة] رسالة فيها "ربط" بس مطابقتش الصيغة المطلوبة بالظبط. النص: "${msg.body}"`);
    }
    return false;
  }
  console.log(`🔎 [ربط مجموعة] أمر "ربط مجموعة ${m[1]}" وصل من groupId=${groupId}, senderId=${senderId}, trusted=${trusted}`);
  if (!trusted) {
    const allowed = [...editorStore.getEditors(), ...(cfg.ADMIN_NUMBERS || []), ...adminStore.getAdmins()];
    let ok = allowed.some((n) => (n.includes("@") ? senderId === n : senderId === `${n}@c.us`));
    // نفس مشكلة معرّف @lid المعروفة (شوف matchesPhoneList) - عضو المجموعة أحيانًا بيوصل معرّفه
    // بصيغة @lid بدل @c.us، فحتى لو رقمه فعلًا مدير/محرر مسجّل، المقارنة المباشرة كانت بتفشل بصمت
    if (!ok && senderId && senderId.endsWith("@lid")) {
      try {
        const contact = await boundedCall("delivery-group-sender", () => msg.getContact());
        const rawNumber =
          (contact && contact.number) || ((contact && contact.id && contact.id._serialized) || "").replace(/@.*/, "");
        ok = !!rawNumber && allowed.some((n) => !n.includes("@") && n === rawNumber);
        console.log(`${ok ? "✅" : "ℹ️"} [ربط مجموعة] معرّف @lid "${senderId}" -> "${rawNumber || "؟"}" (${ok ? "متطابق" : "مش متطابق"})`);
      } catch (err) {
        console.log(`⚠️ [ربط مجموعة] تعذّر ترجمة معرّف @lid للمرسل: ${err.message}`);
      }
    }
    if (!ok) {
      console.log(`🚫 [ربط مجموعة] رُفض - المرسل (${senderId}) مش من ضمن المديرين/المحررين المسموح لهم (${allowed.join("، ") || "القائمة فاضية"}).`);
      return false;
    }
  }
  const regionKey = deliveryStore.REGION_BY_WORD[m[1]];
  deliveryStore.setGroup(regionKey, groupId);
  console.log(`✅ [ربط مجموعة] تم ربط ${groupId} بمنطقة ${m[1]}.`);

  // تحقق بسيط: اسم المجموعة الفعلي بيذكر اسم المنطقة دي؟ (يلاقط غلطة ربط مجموعة غلط بدري -
  // زي ربط مجموعة اسمها "توصيل بطاقات - الجنوب" غلط بمنطقة الشمال) - تحذير بس، مش رفض للربط،
  // لأن أسماء المجموعات ممكن تتغيّر لاحقًا أو تتكتب بصياغة مختلفة عن قصد
  let nameWarning = "";
  try {
    const groupName = await fetchGroupName(groupId);
    if (groupName && !deliveryStore.groupNameMatchesRegion(regionKey, groupName)) {
      nameWarning = `\n\n⚠️ تنبيه: اسم المجموعة الفعلي "${groupName}" ما بيذكرش "${m[1].replace(/^ال/, "")}" - تأكد إنك ربطت المجموعة الصح.`;
    }
  } catch (err) {
    console.log(`⚠️ [ربط مجموعة] تعذّر التأكد من اسم المجموعة: ${err.message}`);
  }

  await safeReply(msg, `✅ تم ربط هذه المجموعة بطلبات توصيل منطقة ${m[1]}.${nameWarning}`);
  return true;
}

// نتيجة توصيل من موظف التوصيل: "تم التوصيل D-n" أو "تعذر التوصيل D-n <السبب>". بيرجّع نص الرد
// اللي يتبعت لموظف التوصيل. allowedRegionKey (لو جوّه مجموعة منطقة): الطلب لازم يكون تابع لنفس
// المنطقة. لو تعذّر التسليم: بيتسجّل (FAILED_DELIVERY) وبيتبعت للمزارع رسالة بالسبب
async function processDeliveryOutcome(cmd, allowedRegionKey = null) {
  const request = deliveryStore.findRequest(cmd.id);
  if (!request) return `⚠️ الطلب ${cmd.id} غير موجود.`;
  if (allowedRegionKey && request.regionKey !== allowedRegionKey) {
    return `⚠️ الطلب ${cmd.id} تابع لمنطقة تانية، مش مجموعة المنطقة دي.`;
  }

  if (cmd.kind === "DELIVERED") {
    // مصدر الحقيقة للتسليم هو المنصة (تاب Delivered) - رسالة موظف التوصيل في المجموعة مابتغيّرش الحالة
    // بنفسها، بس بنأكدله إن إفادته اتسجّلت وإن الحالة هتتحدّث لوحدها لما التسليم يتسجّل في المنصة.
    // أمر الأدمن المباشر (من غير مجموعة) فضل متاح كتعديل يدوي عند الحاجة.
    if (allowedRegionKey) {
      return `📝 تم استلام إفادتك بتسليم الطلب ${request.id}. الحالة بتتحدّث تلقائيًا من المنصة بمجرد تسجيل التسليم هناك (التوقيع)، فتأكد إنه اتسجّل في المنصة.`;
    }
    const done = deliveryStore.markDelivered(cmd.id);
    return done ? `✅ تم تسجيل توصيل الطلب ${done.id}.` : `⚠️ الطلب ${cmd.id} اتسجّل مسبقًا.`;
  }

  const failed = deliveryStore.markFailed(cmd.id, cmd.reason);
  if (!failed) return `⚠️ الطلب ${cmd.id} اتقفل قبل كده (تم التوصيل أو تعذّر).`;
  try {
    const text = buildFailedNotice(getCfgText("DELIVERY_FAILED_NOTICE"), failed, cmd.reason, platformNumberFor(failed.phone));
    await boundedCall("delivery-failed-notice", () => client.sendMessage(`${failed.phone}@c.us`, text), 20000);
    return `✅ سجّلت تعذّر تسليم الطلب ${failed.id}، وبعتّ رسالة للمزارع ${failed.name || failed.phone}.`;
  } catch (err) {
    console.log(`⚠️ [توصيل] فشل إرسال رسالة تعذّر التسليم لـ${failed.phone}: ${err.message}`);
    return `⚠️ سجّلت تعذّر تسليم الطلب ${failed.id} لكن فشل إرسال الرسالة للمزارع (${err.message}) - تواصل معاه يدويًا.`;
  }
}

// رسالة جوّه مجموعة توصيل مربوطة: لو أمر نتيجة توصيل (تم/تعذر) بنعالجه ونرد في المجموعة
async function maybeHandleDeliveryOutcome(msg, groupId) {
  const groups = deliveryStore.getGroups();
  const region = Object.values(deliveryStore.REGIONS).find((r) => groups[r.key] === groupId);
  if (!region) return false;
  let cmd = parseOutcomeCommand(msg.body || "");
  if (!cmd) {
    // رد (Reply) على رسالة طلب توصيل بجملة حرة ("تم التسليم"، "لم يتم الرد") - رقم الطلب من الرسالة المقتبسة
    const quotedBody = msg.hasQuotedMsg && msg._data && msg._data.quotedMsg ? msg._data.quotedMsg.body : "";
    const id = extractRequestId(quotedBody);
    const kind = id ? classifyFreeText(msg.body || "") : null;
    if (!kind) return false;
    cmd = { kind, id, reason: kind === "FAILED" ? String(msg.body || "").trim() : "" };
  }
  const reply = await processDeliveryOutcome(cmd, region.key);
  try {
    await boundedCall("delivery-outcome-reply", () => client.sendMessage(groupId, reply), 15000);
  } catch (err) {
    console.log(`⚠️ [توصيل] فشل الرد في المجموعة: ${err.message}`);
  }
  return true;
}

// اسم مجموعة واتساب من معرّفها - client.getChats()/getChatById() بيرموا خطأ "r" حاليًا (نفس
// مشكلة LID Migration الموثقة في lib/downloadMediaCompat.js)، فبنقرا اسم المجموعة مباشرة من
// داخل واتساب ويب نفسه (WAWebCollections.Chat) بدل ما نعتمد على أي دالة من مكتبة whatsapp-web.js
// بتلف على _serialized - بيرجّع null لو تعذّر الوصول لأي سبب
async function fetchGroupName(groupId) {
  return boundedCall(
    `group-name-${groupId}`,
    () =>
      client.pupPage.evaluate((id) => {
        const wid = window.require("WAWebWidFactory").createWid(id);
        const chat = window.require("WAWebCollections").Chat.get(wid);
        return (chat && (chat.formattedTitle || chat.name || (chat.groupMetadata && chat.groupMetadata.subject))) || null;
      }, groupId),
    10000
  );
}

// بيدوّر على مجموعة موجودة بالفعل بنفس الاسم بالظبط - بديل لـclient.getChats() (نفس علة "r").
// بيقرا كل الشاتات من داخل واتساب ويب مباشرة ويرجّع معرّف أول مجموعة بنفس الاسم، أو null
async function findGroupByName(groupName) {
  return boundedCall(
    `find-group-${groupName}`,
    () =>
      client.pupPage.evaluate((name) => {
        const chats = window.require("WAWebCollections").Chat.getModelsArray();
        const match = chats.find((c) => c.isGroup && (c.formattedTitle === name || c.name === name));
        return match ? match.id._serialized || match.id.$1 : null;
      }, groupName),
    15000
  );
}

// كل مجموعات واتساب اللي البوت عضو فيها حاليًا - قراءة مباشرة من داخل واتساب ويب (نفس أسلوب
// findGroupByName) بدل client.getChats() المكسورة. بيرجّع [{id, name}]
async function listBotGroups() {
  return boundedCall(
    "list-bot-groups",
    () =>
      client.pupPage.evaluate(() => {
        const chats = window.require("WAWebCollections").Chat.getModelsArray();
        return chats
          .filter((c) => c.isGroup)
          .map((c) => ({ id: c.id._serialized || c.id.$1, name: c.formattedTitle || c.name || "(بدون اسم)" }));
      }),
    15000
  );
}

// بيغيّر عنوان مجموعة مباشرة (نفس منطق GroupChat.setSubject بالظبط، بس من غير الاعتماد على
// client.getChatById المكسورة حاليًا - بيمرّر chatId كنص مباشرة). بيرجّع true/false حسب النجاح
async function renameGroup(chatId, subject) {
  return boundedCall(
    `rename-group-${chatId}`,
    () =>
      client.pupPage.evaluate(
        async (id, newSubject) => {
          const wid = window.require("WAWebWidFactory").createWid(id);
          try {
            await window.require("WAWebGroupModifyInfoJob").setGroupSubject(wid, newSubject);
            return true;
          } catch {
            return false;
          }
        },
        chatId,
        subject
      ),
    15000
  );
}

// البوت يغادر مجموعة (نفس منطق GroupChat.leave() بالظبط، بدون الاعتماد على getChatById المكسورة)
async function leaveGroup(chatId) {
  return boundedCall(
    `leave-group-${chatId}`,
    () =>
      client.pupPage.evaluate(async (id) => {
        const chat = await window.WWebJS.getChat(id, { getAsModel: false });
        return window.require("WAWebExitGroupAction").sendExitGroup(chat);
      }, chatId),
    15000
  );
}

// محادثات فردية آخر رسالة فيها واردة (من مزارع) من غير أي رد بعدها، خلال آخر `days` يوم - قراءة
// مباشرة من داخل واتساب ويب (client.getChats() مكسورة). بترجّع الأقدم أولًا
const CATCHUP_TYPES = ["chat", "image", "document", "video", "audio", "ptt", "location", "vcard", "sticker"];
async function listUnansweredChats(days) {
  const sinceSec = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const selfId = client.info && client.info.wid ? client.info.wid._serialized : "";
  const rows = await boundedCall(
    "list-unanswered",
    () =>
      client.pupPage.evaluate((since, allowed) => {
        const str = (w) => (w ? w._serialized || w.$1 || "" : "");
        const out = [];
        for (const c of window.require("WAWebCollections").Chat.getModelsArray()) {
          if (c.isGroup) continue;
          const id = str(c.id);
          if (!/@(c\.us|lid)$/.test(id)) continue;
          const msgs = c.msgs && c.msgs.getModelsArray ? c.msgs.getModelsArray() : [];
          const last = msgs[msgs.length - 1];
          if (!last || (last.id && last.id.fromMe) || last.isNotification) continue;
          if (!last.t || last.t < since || !allowed.includes(last.type)) continue;
          out.push({
            chatId: id,
            body: last.body || last.caption || "",
            t: last.t,
            type: last.type,
            lat: last.lat,
            lng: last.lng,
            notifyName: last.notifyName || "",
          });
        }
        return out;
      }, sinceSec, CATCHUP_TYPES),
    30000
  );
  return rows.filter((r) => r.chatId !== selfId).sort((a, b) => a.t - b.t);
}

// رسالة "شبه حقيقية" من بيانات واتساب ويب المباشرة - الردود بتتبعت بـclient.sendMessage للشات نفسه
function buildCatchUpMessage(row) {
  return {
    from: row.chatId,
    fromMe: false,
    body: row.type === "chat" ? row.body : row.type === "location" ? "" : row.body || "",
    timestamp: row.t,
    hasMedia: row.type !== "chat" && row.type !== "location",
    location: row.type === "location" ? { latitude: row.lat, longitude: row.lng } : undefined,
    id: { _serialized: `catchup_${row.chatId}_${row.t}` },
    _data: { notifyName: row.notifyName },
    reply: (text) => client.sendMessage(row.chatId, text),
    getContact: async () => null,
  };
}

let pendingCatchUp = null; // { rows, days } - بيستنى "تأكيد مراجعة الرسائل" من المدير
let catchUpRunning = false;

// بيرد على المحادثات المعلّقة واحدة واحدة بنفس منطق الرد العادي (processFarmerMessage) وبفاصل
// عشوائي 25-50 ثانية بينهم - الحساب اتقيّد قبل كده بسبب نمط رسائل جماعية، فممنوع الرد دفعة واحدة
async function runCatchUp(rows, notify) {
  catchUpRunning = true;
  let done = 0;
  try {
    for (const row of rows) {
      const msg = buildCatchUpMessage(row);
      try {
        if ((await isEditorMessage(msg)) || (await isAdminMessage(msg))) continue;
        msg._canonicalChatId = await resolveCanonicalChatId(msg);
        await processFarmerMessage(msg);
        done++;
      } catch (err) {
        console.log(`⚠️ [مراجعة قديمة] فشل الرد على ${row.chatId}: ${err.message}`);
      }
      if (row !== rows[rows.length - 1]) {
        await new Promise((r) => setTimeout(r, 25000 + Math.random() * 25000));
      }
    }
  } finally {
    catchUpRunning = false;
  }
  await notify(`✅ خلصت مراجعة الرسائل القديمة: اتعالجت ${done} محادثة من ${rows.length}.`);
}

// آخر قائمة مجموعات اتعرضت بأمر "مجموعات البوت" - عشان أمر "غادر مجموعة <رقم>" يقدر يرجع لنفس
// الترتيب من غير ما المدير يضطر يكتب معرّف المجموعة الطويل بنفسه
let lastGroupListing = [];

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
  // أي رسالة واردة فعلية من المزارع = FARMER_REPLIED في Communication Status - مبتلمسش
  // Farmer State إطلاقًا (منفصلين تمامًا بالتصميم). لو اختار "التواصل مع موظف" لاحقًا في نفس
  // الدالة، الحالة هتتحدّث لـHANDED_OFF بعد كده (آخر تحديث بيكسب، وده المطلوب بالظبط)
  try {
    farmerRegistry.recordReply(normalizeSaudiPhone(chatId));
  } catch (regErr) {
    console.log(`⚠️ فشل تحديث Farmer Registry (رد وارد): ${regErr.message}`);
  }

  // مزارع بعت ملف/صورة مباشرة (زي صك الأرض أو مستند إثبات) من غير ما يكون في مسار تذكرة رسمي -
  // بنسجّل الحدث ده بس عشان أمر "المعلقات" يقدر يوري "مزارعين أرسلوا مستندات ولم يتم الرد" لحد
  // ما حد يتفاعل مع نفس الرقم بعدها (تذكرة/تحويل لموظف/رد يدوي - أي حدث تاني بيتسجّل بعده)
  if (msg.hasMedia) {
    logEvent("document_received", chatId);
  }

  const session = getSession(chatId);
  let replied = false;

  // إرسال 0 (أو "قائمة"/"menu") يرجع المستخدم للقائمة الرئيسية في أي وقت
  if (/^(0|قائمة|menu|القائمة)$/i.test(text)) {
    session.state = "MENU";
    try {
      const p = await resolveFarmerPhone(msg, chatId);
      if (p) deliveryStore.clearPending(p);
    } catch {
      // مش مهم - مجرد تنظيف حالة انتظار لو كانت موجودة
    }
    replied = await safeReply(msg, getCfgText("MAIN_MENU"));
    logReplyOutcome(chatId, replied);
    return;
  }

  // ردود "استلام/توصيل البطاقة": بس لو المزارع في القائمة الرئيسية (مش وسط تذكرة أو محوّل لموظف)
  // وعنده حالة انتظار فعلية - "1"/"2" هنا مالهمش علاقة بخيارات القائمة الرئيسية. لو المزارع بعت
  // موقعه الفعلي (📎 ← الموقع) وهو في خطوة اختيار المنطقة، بنحدد المنطقة تلقائيًا من الإحداثيات
  // بدل ما نطلب منه يختار رقم يدويًا (شوف lib/deliveryRegionsGeo.js)
  if (session.state === "MENU") {
    try {
      const farmerPhone = await resolveFarmerPhone(msg, chatId);
      if (farmerPhone) {
        const outcome = msg.location
          ? deliveryFlow.handleLocation(farmerPhone, msg.location.latitude, msg.location.longitude, getCfgText)
          : deliveryFlow.handleReply(farmerPhone, text, getCfgText);
        if (outcome.handled) {
          replied = await safeReply(msg, outcome.reply);
          logReplyOutcome(chatId, replied);
          if (outcome.request) {
            const fwd = await deliveryFlow.forwardRequest(client, outcome.request);
            if (!fwd.ok) console.log(`⚠️ [توصيل] طلب ${outcome.request.id} ما اتبعتش لمجموعة المنطقة (${fwd.reason}) - محفوظ في "طلبات التوصيل".`);
          }
          return;
        }
      }
    } catch (deliveryErr) {
      console.log(`⚠️ [توصيل] خطأ في معالجة رد الاستلام/التوصيل: ${deliveryErr.message}`);
    }
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
        try {
          farmerRegistry.recordHandoff(normalizeSaudiPhone(chatId));
        } catch (regErr) {
          console.log(`⚠️ فشل تحديث Farmer Registry (تحويل لموظف): ${regErr.message}`);
        }
        logEvent("choice_2", chatId);
        notifyStaff(chatId, withinHours);
      } else if (text === "3") {
        replied = await safeReply(
          msg,
          "يرجى اختيار نوع طلبكم:\n\n1. شكوى\n2. استفسار\n3. اقتراح\n4. الرجوع إلى القائمة الرئيسية"
        );
        session.state = "AWAITING_TICKET_CATEGORY";
        logEvent("choice_3", chatId);
      } else if (msg.hasMedia) {
        // مزارع بعت مستند/صورة من غير رقم قائمة (مثلًا صك أرض) - الحدث اتسجّل بالفعل فوق
        // (document_received) عشان "المعلقات"، بس ممنوع نرد بالقائمة الرئيسية هنا لأنها مش
        // رد فعلي على استفسار، وبتبان للمزارع كأن البوت مش فاهم اللي بعته
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

    // رسالة واحدة بتحتوي على كل البيانات المطلوبة (اسم، جوال، منطقة، تفاصيل) - زي ما طُلب
    // صراحةً بدل تجزئتها لخطوات منفصلة. التحقق هنا بيتأكد إن الرد فعلًا محتوى حقيقي شامل (طول
    // معقول + فيه رقم جوال + أكتر من سطر/كلمة) قبل قبوله، عشان مشكلة حقيقية حصلت فعلاً قبل كده:
    // كلمة واحدة قصيرة (زي "اقتراح" - نفس كلمة نوع الطلب!) كانت بتتقبل كرد كامل وتتقفل التذكرة
    // فورًا من غير أي بيانات حقيقية. الاسم/الجوال/المنطقة بيتسحبوا من نص الرسالة نفسها best-effort،
    // وبيرجعوا لاسم بروفايل واتساب/رقم المحادثة كاحتياط لو ما اتلقوش صريحين في النص
    case "AWAITING_TICKET_TEXT": {
      const body = msg.body || "";
      const phoneMatch = toWesternDigits(body).match(/\d{8,15}/);
      const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
      if (text.length < 20 || wordCount < 5 || !phoneMatch) {
        replied = await safeReply(
          msg,
          "يرجى كتابة كل البيانات المطلوبة في رسالة واحدة كاملة (الاسم، رقم الجوال، المنطقة، ونوع وتفاصيل الطلب) - الرسالة الحالية غير كافية:"
        );
        break;
      }

      const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // الاسم: أول سطر ما فيهوش أرقام (غالبًا ده اللي المزارع كتب فيه اسمه) - احتياط اسم البروفايل
      const nameLine = lines.find((l) => !/\d/.test(l));
      const resolvedPhone = phoneMatch[0];
      const resolvedName = nameLine || displayName || "";

      logComplaint(chatId, body); // نسيبها كمان كنسخة CSV بسيطة للتوافق مع أي استخدام قديم
      logEvent("complaint_submitted", chatId);
      const ticket = ticketStore.createTicket({
        farmerName: resolvedName,
        phone: resolvedPhone || chatId.replace(/@.*/, ""),
        category: session.ticketCategory || "COMPLAINT",
        message: body,
      });
      // Communication Status: تسجيل إن المزارع ده فتح تذكرة فعليًا - منفصل تمامًا عن Farmer
      // State Machine (Best-effort، فشله ميوقفش تأكيد التذكرة للمزارع)
      try {
        farmerRegistry.recordReply(normalizeSaudiPhone(chatId), "TICKET_RESPONSE");
      } catch (regErr) {
        console.log(`⚠️ فشل تحديث Farmer Registry (تذكرة جديدة): ${regErr.message}`);
      }
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
  // تجاهل أي رسالة اتبعت من رقم البوت نفسه - واتساب ويب أحيانًا (مشكلة معروفة مع الأجهزة
  // المرتبطة/multi-device) بيبعت حدث "message" حتى للرسائل اللي البوت نفسه بعتها (زي رسائل
  // الحملات: استلام البطاقة، تذكير الدرافت...إلخ) مش بس الرسائل الواردة فعلاً. من غير الفلتر ده
  // كان بيحصل إن البوت يستقبل نص رسالته هو نفسه كأنه رسالة من المزارع، ما يطابقش أي خيار من القائمة،
  // فيرد عليه بالقائمة الرئيسية فورًا بعد ما يبعتله رسالة الحملة - من غير ما المزارع يكتب أي حاجة.
  if (msg.fromMe) return;

  // صدى رسالة البوت نفسه (واتساب ويب بيبعتها كرسالة واردة fromMe=false) - ممنوع نعتبرها من مزارع
  // ونردّ عليها بالقائمة الرئيسية (كانت بتظهر القائمة فورًا بعد رسالة الاستلام من غير ما المزارع يكتب)
  if (sentEcho.isEcho(msg.body)) {
    console.log(`↩️ [صدى] تجاهل رسالة واردة من ${msg.from} نصها مطابق لرسالة أرسلها البوت للتو.`);
    return;
  }

  // تجاهل رسائل المجموعات - البوت يرد على المحادثات الفردية فقط
  // (نتأكد من شكل الرقم مباشرة بدل msg.getChat() اللي بتفشل حاليًا
  // بسبب نفس مشكلة تحديث واتساب ويب اللي كسرت إرسال الردود)
  if (msg.from.endsWith("@g.us")) {
    if (await maybeHandleDeliveryOutcome(msg, msg.from)) return;
    await maybeRegisterDeliveryGroup(msg, msg.from, msg.author, false);
    return;
  }

  // تجاهل تمامًا أي حدث بمعرّف "status@broadcast" - ده مش رسالة من مزارع خالص، ده حدث داخلي
  // من ميزة "الحالة" (Status) في واتساب (لما جهة اتصال تشوف/تتفاعل مع حالة). من غير الفلتر ده،
  // البوت كان بيعامله كرسالة عادية ويرد عليه بالقائمة الرئيسية - وواتساب ويب بيفسّر أي msg.reply()
  // على المعرّف الخاص ده كنشر "حالة" جديدة على حساب البوت نفسه، مش إرسال رسالة عادية (السبب
  // الحقيقي اللي كان بيخلي البوت ينشر حالات تلقائيًا فيها نص القائمة الرئيسية)
  if (msg.from.endsWith("@broadcast")) return;

  // أي محادثة مش فردية عادية (@c.us أو @lid) ممنوع البوت يرد عليها - زي "مساعد الأعمال" (Meta AI،
  // معرّفه @bot) اللي كان البوت بيبعتله القائمة فيرد عليه ويدخلوا في لوب رسائل
  if (!/@(c\.us|lid)$/.test(msg.from)) {
    console.log(`🤖 [تجاهل] رسالة من محادثة غير فردية عادية (${msg.from}) - مفيش رد.`);
    return;
  }

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
    /^((?:تأكيد\s*|ايقاف\s*|حالة\s*)?استبيان\s*(?:ال)?مستلمين|(?:حاله|حالة)?\s*بطاقة\s*المزارع|تحقق\s*(?:من\s*)?[اإأ]رسال|تحقق\s*(?:ال)?بطاقات|فحص\s*تسليم|تجهيز\s*(?:ال)?بطاقات|تفاصيل\s*(?:ال)?مستفيدين|استبعد\s*طلب|احصائيات|إحصائيات|مزامنة النظام|تقرير|الحصة|مدراء|محررين|اجمالي\s*الارسال|إجمالي\s*الإرسال|ارسالات|إرسالات|تقرير\s*الارسال|تقرير\s*الإرسال|اضف\s*مدير|احذف\s*مدير|اضف\s*محرر|احذف\s*محرر|ارسل\s*\S+|ايقاف\s*التقرير|تشغيل\s*التقرير|تسجيل\s*بيانات\s*المنصة|انواع\s*الرسائل|اسماء\s+\S+|كل\s*الا?رقام|تأكيد\s*(?:ارسال|إرسال)\s+\S+|(?:اعادة|إعادة)\s*محاولة\s+\S+|استئناف\s*البوت\s+\S+|علم\s*استلام\s*البطاقة\s+\S+|حالة\s*المزارع\s+\S+|سجل\s+\S+|تواصل\s+\S+|تذاكر\s*مفتوحة|ايقاف\s*الارسال|تشغيل\s*الارسال)/i;
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

        // محاولة واحدة بس أثناء التشخيص عمدًا (مفيش Retry) - الفشل هنا بنيوي (مشكلة LID
        // Migration)، مش عارض مؤقت، فإعادة المحاولة 3 مرات كانت بس بتلخبط اللوج من غير فايدة
        let media, mediaSource, remoteType, mediaErr;
        try {
          const result = await downloadMediaCompat(client, msg);
          media = result.media;
          mediaSource = result.source;
          remoteType = result.remoteType;
        } catch (err) {
          mediaErr = err;
          console.log(`⚠️ downloadMediaCompat رمت استثناء: ${err && err.message}`);
          console.log(`🩺 [Diagnostic-Media] err.stack:\n${(err && err.stack) || "(مفيش stack)"}`);
        }
        console.log(`🩺 [Diagnostic-Media] SERIALIZED_ID_SOURCE: ${mediaSource || "(none)"} | REMOTE_TYPE: ${remoteType || "(unknown)"}`);
        if (!media) {
          console.log(`⚠️ فشل تحميل الملف (${mediaErr ? `استثناء: ${mediaErr.message}` : "رجعت undefined بدون استثناء"})`);
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
              `الإجمالي: ${counts.total}\n` +
              `الأرقام غير الصحيحة: ${invalidOrMissing}\n` +
              `المكرر: ${counts.duplicate}\n` +
              `سبق التواصل معهم (لنفس الغرض): ${counts.blocked_previous_contact}\n` +
              `لديهم طلب قائم: ${counts.excluded_active_application}\n` +
              `لديهم بطاقة: ${counts.excluded_card_issued + counts.excluded_card_collected}\n` +
              `سبق إرسال نفس الغرض/الرسالة: ${counts.already_received}\n` +
              `يحتاج مراجعة: ${counts.blocked_review_required}`
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

        // Backfill فوري في Farmer Registry بمجرد قبول الصفوف - قبل أي إرسال فعلي (بند 3).
        // Best-effort ومحوّط بـtry/catch لكل صف: فشل تسجيل صف واحد ممنوع يوقف رفع الحملة كلها
        const CAMPAIGN_LABEL_AR = {
          REGISTRATION: "حملة تسجيل",
          DOCUMENTS: "حملة مستندات",
          CARD: "حملة بطاقات",
          GENERAL_NOTICE: "حملة إشعار عام",
          SURVEY: "حملة استبيان",
          EVALUATION: "حملة تقييم",
        };
        campaignRows.forEach((row) => {
          if (!row.phone) return;
          try {
            farmerRegistry.backfillFromCampaignRow({
              phone: row.phone,
              nameArabic: row.name,
              campaignId,
              campaignPurpose: purpose,
              campaignLabel: CAMPAIGN_LABEL_AR[purpose] || "حملة",
            });
          } catch (backfillErr) {
            console.log(`⚠️ فشل Backfill لسجل المزارع ${row.phone} (${backfillErr.message}) - مش خطر، بيكمل باقي الحملة عادي`);
          }
        });

        await msg.reply(
          `📋 معاينة الحملة - المعرّف: *${campaignId}* (النوع: ${purpose})\n\n` +
            `الإجمالي: ${counts.total}\n` +
            `الأرقام غير الصحيحة: ${invalidOrMissing}\n` +
            `المكرر: ${counts.duplicate}\n` +
            `سبق التواصل معهم (تنبيه، مش استبعاد): ${counts.any_previous_contact}\n` +
            `لديهم طلب قائم: ${counts.excluded_active_application}\n` +
            `لديهم بطاقة: ${counts.excluded_card_issued + counts.excluded_card_collected}\n` +
            `سبق إرسال نفس الغرض: ${counts.blocked_previous_contact}\n` +
            `سبق إرسال نفس الرسالة بالظبط: ${counts.already_received}\n` +
            `يحتاج مراجعة: ${counts.blocked_review_required}\n` +
            `غير مسجل على واتساب: يظهر وقت الإرسال الفعلي فقط\n` +
            `المتبقي/جاهز للإرسال: ${counts.valid}\n\n` +
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

    // البوت ينشئ مجموعات التوصيل الثلاث بنفسه ويربطها تلقائيًا - بدل الإنشاء اليدوي + "ربط مجموعة".
    // الأعضاء: موظف/موظفي كل منطقة المخصّصين لها بأمر "اضف موظف توصيل" (لو مخصص حد لمنطقة)، وإلا
    // بيرجع لقائمة موظفي خدمة المزارعين العامة (staffStore) كـfallback. بيتخطى أي منطقة مربوطة
    // بالفعل (بدل الرفض الكامل) - عشان لو منطقة نجحت ومنطقة فشلت (مشكلة شبكة/واتساب مؤقتة)،
    // تقدر تعيد المحاولة للناقص بس من غير ما تأثر على اللي اتربط. "تفكيك مجموعات التوصيل" لسه
    // متاح لو حابب يبدأ من الصفر بالكامل
    if (/^انشاء\s*مجموعات\s*التوصيل$/i.test(text)) {
      const existing = deliveryStore.getGroups();
      const pendingRegions = Object.values(deliveryStore.REGIONS).filter((r) => !existing[r.key]);
      if (pendingRegions.length === 0) {
        await msg.reply('✅ الثلاث مناطق مربوطة بالفعل. لو عايز تنشئ مجموعات جديدة، اكتب "تفكيك مجموعات التوصيل" الأول.');
        return;
      }
      const fallbackStaff = staffStore.getStaff();
      const regionsMissingStaff = pendingRegions.filter(
        (r) => deliveryStore.getRegionStaff(r.key).length === 0 && fallbackStaff.length === 0
      );
      if (regionsMissingStaff.length > 0) {
        await msg.reply(
          `⚠️ مفيش موظف مخصّص لـ${regionsMissingStaff.map((r) => r.ar).join("، ")} (ولا موظف عام كـfallback). ضيف موظف بأمر "اضف موظف توصيل <رقم> <المنطقة>" (مثال: اضف موظف توصيل 966536667882 الوسط).`
        );
        return;
      }
      await msg.reply(`⏳ جاري إنشاء مجموعات التوصيل الناقصة (${pendingRegions.map((r) => r.ar).join("، ")})...`);
      const results = [];
      for (const region of pendingRegions) {
        const groupName = `توصيل بطاقات - ${region.ar}`;
        const regionStaff = deliveryStore.getRegionStaff(region.key);
        const members = (regionStaff.length > 0 ? regionStaff : fallbackStaff).map((n) => `${n}@c.us`);
        try {
          // مكتبة واتساب أحيانًا بترمي خطأ قراءة الرد (findImpl/unknown error) حتى لو المجموعة
          // اتعملت فعليًا على السيرفر - قبل أي محاولة إنشاء جديدة، نتأكد الأول إن مفيش مجموعة
          // بنفس الاسم اتعملت من محاولة سابقة فشلت في الرد بس (تفاديًا لتكرار الإنشاء)
          const existingGroupId = await findGroupByName(groupName);
          if (existingGroupId) {
            deliveryStore.setGroup(region.key, existingGroupId);
            results.push(`✅ ${region.ar}: اتلاقت مجموعة موجودة بنفس الاسم من محاولة سابقة واتربطت (من غير إنشاء مجموعة جديدة)`);
            continue;
          }
          const result = await boundedCall(`create-group-${region.key}`, () => client.createGroup(groupName, members), 30000);
          if (typeof result === "string") {
            results.push(`❌ ${region.ar}: فشل الإنشاء (${result})`);
            continue;
          }
          deliveryStore.setGroup(region.key, result.gid._serialized);
          const failed = Object.values(result.participants).filter((p) => p.statusCode !== 200).length;
          results.push(`✅ ${region.ar}: اتربطت (${regionStaff.length > 0 ? "موظف مخصّص" : "موظف عام - fallback"})${failed > 0 ? ` - تعذّر إضافة ${failed} مباشرة، هيوصلهم دعوة` : ""}`);
        } catch (err) {
          results.push(`❌ ${region.ar}: ${err.message} - ⚠️ ممكن المجموعة اتعملت فعليًا رغم الخطأ، حاول تاني بنفس الأمر وهيكتشفها ويربطها بدل ما يكرر الإنشاء`);
        }
      }
      const stillFailed = results.some((r) => r.startsWith("❌"));
      await msg.reply(
        `🚚 نتيجة إنشاء مجموعات التوصيل:\n\n${results.join("\n")}${
          stillFailed ? '\n\nلو فيه منطقة فشلت، ممكن تحاول تاني بنفس الأمر بعد شوية (يتخطى اللي نجح فعلًا)، أو تنشئها يدويًا من واتساب وتربطها بأمر "ربط مجموعة الشمال/الجنوب/الوسط" داخلها.' : ""
        }`
      );
      return;
    }

    // إضافة/حذف موظف مخصّص لمنطقة توصيل معينة (يُستخدم كعضو في مجموعة تلك المنطقة فقط عند
    // "انشاء مجموعات التوصيل" - منفصل عن قائمة موظفي خدمة المزارعين العامة)
    const addRegionStaffMatch = toWesternDigits(text).match(/^اضف\s*موظف\s*توصيل\s+(\d{8,15})\s+(الشمال|الجنوب|الوسط)$/i);
    if (addRegionStaffMatch) {
      const [, phone, regionWord] = addRegionStaffMatch;
      const regionKey = deliveryStore.REGION_BY_WORD[regionWord];
      const added = deliveryStore.assignRegionStaff(regionKey, phone);
      await msg.reply(
        added ? `✅ تمت إضافة ${phone} كموظف توصيل لمنطقة ${regionWord}.` : `ℹ️ الرقم ${phone} مضاف بالفعل لمنطقة ${regionWord}.`
      );
      return;
    }

    const removeRegionStaffMatch = toWesternDigits(text).match(/^احذف\s*موظف\s*توصيل\s+(\d{8,15})\s+(الشمال|الجنوب|الوسط)$/i);
    if (removeRegionStaffMatch) {
      const [, phone, regionWord] = removeRegionStaffMatch;
      const regionKey = deliveryStore.REGION_BY_WORD[regionWord];
      const removed = deliveryStore.removeRegionStaff(regionKey, phone);
      await msg.reply(removed ? `✅ تم حذف ${phone} من موظفي توصيل ${regionWord}.` : `ℹ️ الرقم ${phone} مش مسجّل لمنطقة ${regionWord}.`);
      return;
    }

    if (/^موظفين\s*التوصيل$/i.test(text)) {
      const all = deliveryStore.getAllRegionStaff();
      const lines = Object.values(deliveryStore.REGIONS).map((r) => {
        const list = all[r.key] || [];
        return `• ${r.ar}: ${list.length ? list.join("، ") : "مفيش موظف مخصّص (هيستخدم الموظفين العامين كـfallback)"}`;
      });
      await msg.reply(`👷 موظفو التوصيل لكل منطقة:\n\n${lines.join("\n")}`);
      return;
    }

    // إزالة الربط بس (مش حذف المجموعات الفعلية من واتساب) - عشان لو الإدارة حابة تنشئ مجموعات
    // جديدة تاني بأمر "انشاء مجموعات التوصيل"
    if (/^تفكيك\s*مجموعات\s*التوصيل$/i.test(text)) {
      deliveryStore.clearGroups();
      await msg.reply('✅ اتفكّك ربط الثلاث مجموعات. المجموعات نفسها لسه موجودة على واتساب - اكتب "انشاء مجموعات التوصيل" لإنشاء مجموعات جديدة، أو اربط مجموعات موجودة يدويًا بأمر "ربط مجموعة الشمال" داخلها.');
      return;
    }

    // أوامر توصيل البطاقة الإدارية (قراءة/تسجيل حالة فقط - مفيش إرسال لمزارعين)
    if (/^مجموعات\s*التوصيل$/i.test(text)) {
      const groups = deliveryStore.getGroups();
      const lines = Object.values(deliveryStore.REGIONS).map((r) => `• ${r.ar}: ${groups[r.key] ? "مربوطة ✅" : "غير مربوطة ❌"}`);
      await msg.reply(`🚚 مجموعات التوصيل:\n\n${lines.join("\n")}\n\nللربط: اكتب داخل المجموعة "ربط مجموعة الشمال" (أو الجنوب/الوسط).`);
      return;
    }
    // بيتأكد إن اسم كل مجموعة توصيل مربوطة فعليًا بيذكر اسم منطقتها - يلاقط غلطة ربط مجموعة
    // بمنطقة غلط (زي مجموعة اسمها "الجنوب" اتربطت غلط بمنطقة الشمال) من غير ما نستنى مشكلة حقيقية
    // (طلب توصيل يوصل لمجموعة غلط) عشان نكتشفها
    if (/^تحقق\s*مجموعات\s*التوصيل$/i.test(text)) {
      const groups = deliveryStore.getGroups();
      const linkedRegions = Object.values(deliveryStore.REGIONS).filter((r) => groups[r.key]);
      if (linkedRegions.length === 0) {
        await msg.reply('⚠️ مفيش أي مجموعة مربوطة أصلًا. اكتب "مجموعات التوصيل" لمعرفة الحالة.');
        return;
      }
      await msg.reply(`⏳ جاري التحقق من أسماء ${linkedRegions.length} مجموعة مربوطة...`);
      const results = [];
      for (const region of linkedRegions) {
        try {
          const groupName = await fetchGroupName(groups[region.key]);
          if (!groupName) {
            results.push(`❓ ${region.ar}: تعذّر جلب اسم المجموعة (ممكن تكون اتحذفت أو البوت اتشال منها)`);
          } else if (deliveryStore.groupNameMatchesRegion(region.key, groupName)) {
            results.push(`✅ ${region.ar}: "${groupName}" - الاسم مطابق`);
          } else {
            results.push(`⚠️ ${region.ar}: "${groupName}" - الاسم ما بيذكرش "${region.ar.replace(/^ال/, "")}"، تأكد من الربط`);
          }
        } catch (err) {
          results.push(`❓ ${region.ar}: تعذّر التحقق (${err.message})`);
        }
      }
      await msg.reply(`🔎 نتيجة التحقق من أسماء مجموعات التوصيل:\n\n${results.join("\n")}`);
      return;
    }

    // بيعرض كل مجموعات واتساب اللي البوت عضو فيها حاليًا (مش بس مجموعات التوصيل المربوطة) -
    // مفيد لاكتشاف مجموعات مكررة أو زيادة عن الحاجة، ولازم قبل أمر "غادر مجموعة <رقم>"
    if (/^مجموعات\s*البوت$/i.test(text)) {
      try {
        const groups = await listBotGroups();
        if (!groups || groups.length === 0) {
          await msg.reply("📭 البوت مش عضو في أي مجموعة حاليًا.");
          return;
        }
        lastGroupListing = groups;
        const linked = deliveryStore.getGroups();
        const lines = groups.map((g, i) => {
          const linkedRegion = Object.values(deliveryStore.REGIONS).find((r) => linked[r.key] === g.id);
          return `${i + 1}. ${g.name}${linkedRegion ? ` (مربوطة بمنطقة ${linkedRegion.ar} ✅)` : ""}`;
        });
        await msg.reply(`👥 مجموعات البوت (${groups.length}):\n\n${lines.join("\n")}\n\nلمغادرة مجموعة غير محتاجها، اكتب: غادر مجموعة <رقمها من القائمة دي>`);
      } catch (err) {
        await msg.reply(`⚠️ تعذّر جلب قائمة المجموعات: ${err.message}`);
      }
      return;
    }

    // بيصحّح اسم أي مجموعة توصيل مربوطة اسمها الفعلي مش مطابق لمنطقتها (زي المجموعات المكررة
    // اللي أسماؤها اتلخبطت وقت الإنشاء) - بيغيّر الاسم للصيغة القياسية "توصيل بطاقات - <المنطقة>"
    if (/^صحح\s*اسماء\s*مجموعات\s*التوصيل$/i.test(text)) {
      const groups = deliveryStore.getGroups();
      const linkedRegions = Object.values(deliveryStore.REGIONS).filter((r) => groups[r.key]);
      if (linkedRegions.length === 0) {
        await msg.reply('⚠️ مفيش أي مجموعة مربوطة أصلًا. اكتب "مجموعات التوصيل" لمعرفة الحالة.');
        return;
      }
      await msg.reply(`⏳ جاري مراجعة وتصحيح أسماء ${linkedRegions.length} مجموعة مربوطة...`);
      const results = [];
      for (const region of linkedRegions) {
        const canonicalName = `توصيل بطاقات - ${region.ar}`;
        try {
          const currentName = await fetchGroupName(groups[region.key]);
          if (currentName === canonicalName) {
            results.push(`✅ ${region.ar}: الاسم سليم بالفعل ("${currentName}")`);
            continue;
          }
          const ok = await renameGroup(groups[region.key], canonicalName);
          results.push(
            ok
              ? `✅ ${region.ar}: اتغيّر الاسم من "${currentName || "؟"}" لـ "${canonicalName}"`
              : `❌ ${region.ar}: فشل تغيير الاسم (ممكن البوت مش أدمن في المجموعة دي)`
          );
        } catch (err) {
          results.push(`❌ ${region.ar}: ${err.message}`);
        }
      }
      await msg.reply(`✏️ نتيجة تصحيح أسماء مجموعات التوصيل:\n\n${results.join("\n")}`);
      return;
    }

    // بيخلي البوت يغادر مجموعة معيّنة برقمها من آخر قائمة "مجموعات البوت" - مش بيحذف المجموعة
    // نفسها من واتساب (ده مستحيل تقنيًا من عضو عادي)، بس بيشيل البوت منها. لازم "مجموعات البوت"
    // الأول عشان الأرقام تتحدد صح، ومينفعش تتخمّن من غير القائمة دي
    const leaveGroupMatch = toWesternDigits(text).match(/^غادر\s*مجموعة\s+(\d+)$/i);
    if (leaveGroupMatch) {
      const index = parseInt(leaveGroupMatch[1], 10) - 1;
      if (lastGroupListing.length === 0) {
        await msg.reply('⚠️ اكتب "مجموعات البوت" الأول عشان تعرف رقم المجموعة اللي عايز تغادرها.');
        return;
      }
      const target = lastGroupListing[index];
      if (!target) {
        await msg.reply(`⚠️ رقم غير صحيح. القائمة فيها ${lastGroupListing.length} مجموعة بس.`);
        return;
      }
      // لو المجموعة دي مربوطة بمنطقة توصيل، لازم نفكّها الأول عشان منسيبش طلبات توصيل تروح لمجموعة البوت غادرها
      const linkedRegion = Object.values(deliveryStore.REGIONS).find((r) => deliveryStore.getGroups()[r.key] === target.id);
      try {
        await leaveGroup(target.id);
        if (linkedRegion) deliveryStore.setGroup(linkedRegion.key, null);
        await msg.reply(`✅ غادر البوت مجموعة "${target.name}"${linkedRegion ? ` (وكانت مربوطة بمنطقة ${linkedRegion.ar} - اتفكّ الربط تلقائيًا)` : ""}.`);
      } catch (err) {
        await msg.reply(`❌ فشلت مغادرة المجموعة: ${err.message}`);
      }
      return;
    }

    if (/^طلبات\s*التوصيل$/i.test(text)) {
      const open = deliveryStore.listOpenRequests();
      if (open.length === 0) {
        await msg.reply("📭 مفيش طلبات توصيل مفتوحة.");
        return;
      }
      const lines = open.map(
        (r) =>
          `• ${r.id} - ${r.name || "بدون اسم"} - ${deliveryStore.formatContact(r.phone)} - ${deliveryStore.REGION_BY_KEY[r.regionKey].ar}${r.forwarded ? "" : " ⚠️ لم يُرسل للمجموعة"}`
      );
      await msg.reply(`🚚 طلبات التوصيل المفتوحة (${open.length}):\n\n${lines.join("\n")}`);
      return;
    }
    // "تم التوصيل D-n" / "تعذر التوصيل D-n <السبب>" من الأدمن (نفس منطق مجموعات التوصيل)
    const outcomeCmd = parseOutcomeCommand(text);
    if (outcomeCmd) {
      await msg.reply(await processDeliveryOutcome(outcomeCmd));
      return;
    }

    // تذكير بكل الحالات المعلّقة اللي محتاجة متابعة بشرية - قراءة فقط، مفيش استهلاك لحصة
    // الحملات ولا تغيير في أي حالة. أمر إداري (محرر/مدير بس) زي "تقرير" بالظبط
    if (/^(المعلقات|رسائل\s*معلقة|المعلّقات)$/i.test(text)) {
      try {
        const data = await buildPendingItemsReport(client);
        await msg.reply(formatPendingItemsReport(data));
      } catch (err) {
        await msg.reply(`⚠️ تعذّر تجهيز تذكير المعلّقات حاليًا: ${err.message}`);
      }
      return;
    }

    // تحقق مباشر من المنصة: كل البطاقات الجاهزة للاستلام (Printed + Pending Delivery) مقابل سجل
    // إرسال "card_pickup" - قراءة فقط، مفيش إرسال لأي مزارع
    if (/^تحقق\s*(من\s*)?(ال)?بطاقات\s*(ال)?جاهز[ةه]$/i.test(text)) {
      if (!portalSync.isConfigured()) {
        await msg.reply("⚠️ نظام البطاقات مش متظبّط أصلًا.");
        return;
      }
      await msg.reply("⏳ بقرا البطاقات الجاهزة من المنصة وبقارنها بسجل الإرسال (ممكن تاخد دقيقة)...");
      try {
        const rows = await require("./lib/portalScraper").fetchPrintedCards(1000);
        const noPhone = rows.filter((r) => !r.phone);
        const withPhone = rows.filter((r) => r.phone);
        const unsent = withPhone.filter((r) => !sentTracker.hasBeenSent("card_pickup", r.phone));
        const lines = [
          `📋 البطاقات الجاهزة في المنصة: ${rows.length}`,
          `✅ تم الإرسال لهم: ${withPhone.length - unsent.length}`,
          `❌ لم يُرسل لهم: ${unsent.length}`,
          `📵 بدون رقم جوال: ${noPhone.length}`,
        ];
        if (unsent.length) {
          lines.push("", "*لم يُرسل لهم:*", ...unsent.map((r, i) => `${i + 1}. ${r.name || "-"} - ${r.phone}${r.formNumber ? ` (طلب ${r.formNumber})` : ""}`));
        }
        if (noPhone.length) {
          lines.push("", "*بدون جوال:*", ...noPhone.map((r, i) => `${i + 1}. ${r.name || "-"}${r.formNumber ? ` (طلب ${r.formNumber})` : ""}`));
        }
        if (!unsent.length && !noPhone.length) lines.push("", "✔️ كل البطاقات الجاهزة وصلها إشعار الاستلام.");
        await msg.reply(lines.join("\n"));
      } catch (err) {
        await msg.reply(`⚠️ تعذّر التحقق من المنصة: ${err.message}`);
      }
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

    // استبيان الإنتاج الزراعي للمستلمين - بخطوتين (تجهيز ثم تأكيد صريح) عشان الإرسال الجماعي مايحصلش بالغلط
    // (وعشان حظر واتساب السابق): "استبيان المستلمين" يجهّز القائمة ويعرضها، "تأكيد استبيان المستلمين"
    // يبدأ الإرسال ويفعّل الإرسال التلقائي لأي مستلم جديد، "ايقاف استبيان المستلمين" يوقف التلقائي.
    if (/^استبيان\s*(ال)?مستلمين$/i.test(text)) {
      if (!portalSync.isConfigured()) {
        await safeReply(msg, "⚠️ نظام البطاقات مش متظبّط أصلًا.");
        return;
      }
      if (broadcastInProgress) {
        await safeReply(msg, "⏳ فيه مهمة تانية شغّالة (إرسال أو مزامنة) - جرّب بعد دقائق.");
        return;
      }
      await safeReply(msg, "⏳ بقرا المزارعين المستلمين من المنصة (بيفتح تفاصيل كل واحد ممكن ياخد عدة دقائق)...");
      broadcastInProgress = true;
      let reply;
      try {
        const rows = await boundedCall("survey-recipients", () => require("./lib/portalScraper").fetchIssuingByTab("تم التسليم", 1000), 12 * 60 * 1000);
        const sel = selectSurvey(rows);
        fs.writeFileSync(SURVEY_CSV, farmerRowsToCsvText(sel.send.map((r) => ({ name: r.name, phone: r.phone })), false), "utf8");
        surveyRecipients.saveState({ ...surveyRecipients.loadState(), pending: { createdAt: new Date().toISOString(), count: sel.send.length } });
        reply =
          `📋 استبيان الإنتاج الزراعي - المستلمون من المنصة: ${rows.length}\n\n` +
          `✅ جاهز للإرسال: ${sel.send.length}\n` +
          `↩️ اتبعتلهم قبل كده: ${sel.alreadySent}\n` +
          `🚫 ممنوع (ما فيه اسم عربي موثوق): ${sel.blocked.length}\n` +
          `📵 بدون رقم جوال صالح: ${sel.noPhone}\n\n` +
          (sel.send.length
            ? `أول 3 أسماء: ${sel.send.slice(0, 3).map((r) => r.name).join("، ")}\n\n` +
              `الإرسال بيتم تدريجيًا (فاصل 20-45 ثانية بين كل رسالة، وحد 15 بالساعة) عشان حساب واتساب.\n` +
              `الإرسال التلقائي مفعّل ويبدأ مع المزامنة القادمة بدون أي تأكيد. للإيقاف اكتب: ايقاف استبيان المستلمين`
            : "مفيش حد جاهز للإرسال.");
      } catch (err) {
        reply = `⚠️ تعذّر تجهيز قائمة الاستبيان: ${err.message}`;
      } finally {
        broadcastInProgress = false;
      }
      await safeReply(msg, reply);
      return;
    }

    if (/^تأكيد\s*استبيان\s*(ال)?مستلمين$/i.test(text)) {
      const state = surveyRecipients.loadState();
      if (!state.pending || !fs.existsSync(SURVEY_CSV)) {
        await safeReply(msg, "⚠️ مفيش قائمة استبيان مجهّزة. اكتب أولًا: استبيان المستلمين");
        return;
      }
      if (broadcastInProgress) {
        await safeReply(msg, "⏳ فيه مهمة تانية شغّالة - جرّب بعد دقائق.");
        return;
      }
      surveyRecipients.saveState({ autoEnabled: true, pending: null });
      // أول دفعة بس (حماية الحساب)؛ الباقي بيكمّل تلقائيًا بعد كل مزامنة (دفعات من 10) لحد ما يخلص
      const csvLines = fs.readFileSync(SURVEY_CSV, "utf8").split(/\r?\n/).filter(Boolean);
      fs.writeFileSync(SURVEY_CSV, csvLines.slice(0, 1 + SURVEY_AUTO_BATCH).join("\n") + "\n", "utf8");
      await safeReply(
        msg,
        `✅ تم التأكيد. بدأ إرسال الاستبيان تدريجيًا: أول ${Math.min(SURVEY_AUTO_BATCH, state.pending.count)} دلوقتي، والباقي (إجمالي ${state.pending.count}) بيكمّل تلقائيًا مع كل مزامنة، وكمان أي مزارع يستلم بطاقته بعد كده.\nللإيقاف: ايقاف استبيان المستلمين`
      );
      runExclusive("استبيان الإنتاج", async () => {
        await sendProductionSurveyBroadcast();
      });
      return;
    }

    if (/^ايقاف\s*استبيان\s*(ال)?مستلمين$/i.test(text)) {
      surveyRecipients.saveState({ ...surveyRecipients.loadState(), autoEnabled: false });
      await safeReply(msg, "⏹️ تم إيقاف الإرسال التلقائي للاستبيان.");
      return;
    }

    if (/^حالة\s*استبيان\s*(ال)?مستلمين$/i.test(text)) {
      const st = surveyRecipients.loadState();
      await safeReply(
        msg,
        `📊 استبيان المستلمين\n• اتبعت لـ: ${sentTracker.getSentCount("production_survey")} مزارع\n• الإرسال التلقائي: ${st.autoEnabled ? "مفعّل ✅" : "متوقف ⏹️"}\n• قائمة مجهّزة بانتظار التأكيد: ${st.pending ? st.pending.count : "لا"}`
      );
      return;
    }

    // شريحة "بطاقة المزارع" الأسبوعية بأرقام المنصة الحية: بتقرا الإحصائيات وبترسم الشريحة (PNG + PDF).
    // قيد المراجعة = كل حالات المراجعة (قيد المراجعة + معلّق + مقبول) ما عدا المؤرشف والمرفوض
    if (/^(حاله|حالة)?\s*بطاقة\s*المزارع$|^لوحة\s*(ال)?بطاقات$/i.test(text)) {
      if (!portalSync.isConfigured()) {
        await safeReply(msg, "⚠️ نظام البطاقات مش متظبّط أصلًا.");
        return;
      }
      if (broadcastInProgress) {
        await safeReply(msg, "⏳ فيه مهمة تانية شغّالة (إرسال أو مزامنة) - جرّب بعد دقائق.");
        return;
      }
      await safeReply(msg, "⏳ بجيب أرقام المنصة وبجهّز شريحة بطاقة المزارع (حوالي دقيقتين)...");
      broadcastInProgress = true;
      let summaryText = null;
      let files = null;
      try {
        const slide = require("./lib/farmerCardSlide");
        const stats = await boundedCall("farmer-card-stats", () => require("./lib/portalScraper").fetchPortalStats(), 4 * 60 * 1000);
        const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
        const previous = slide.pickPrevious(slide.loadSnapshots(), dateStr);
        const data = slide.computeSlideData(stats, { dateStr, previous });
        files = await boundedCall("farmer-card-render", () => slide.renderSlideFiles(data), 2 * 60 * 1000);
        slide.saveSnapshot(slide.computeCounts(stats), dateStr);
        summaryText =
          `📊 بطاقة المزارع - ${dateStr}\n\n` +
          `الإجمالي: ${data.total}\n` +
          `• قيد المراجعة (مراجعة + معلّق + مقبول، بدون المؤرشف والمرفوض): ${data.review}\n` +
          `• في انتظار الطباعة: ${data.waitingPrint}\n` +
          `• تمت طباعتها: ${data.printed} (تم تسليمها ${data.delivered}، بانتظار التسليم ${data.pendingDelivery})`;
        const chatId = msg.from;
        const toMedia = (buf, mime, name) => new MessageMedia(mime, buf.toString("base64"), name);
        await safeReply(msg, summaryText);
        await boundedCall("farmer-card-send-png", () => client.sendMessage(chatId, toMedia(files.png, "image/png", `بطاقة المزارع - ${dateStr}.png`)), 60000);
        await boundedCall("farmer-card-send-pdf", () => client.sendMessage(chatId, toMedia(files.pdf, "application/pdf", `بطاقة المزارع - ${dateStr}.pdf`), { sendMediaAsDocument: true }), 60000);
      } catch (err) {
        console.log(`⚠️ [بطاقة المزارع] فشل: ${err.message}`);
        await safeReply(msg, `⚠️ تعذّر تجهيز الشريحة: ${err.message}`);
      } finally {
        broadcastInProgress = false;
      }
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

    // تقرير كل الرسائل اللي اتبعت النهارده (أو تاريخ معيّن)، مجمّعة حسب النوع
    // "ارسالات اليوم" أو "تقرير الارسال اليوم" - وممكن كمان تحدد تاريخ زي "ارسالات 2026-09-06"
    const sendReportMatch = text.match(/^(?:ارسالات|إرسالات|تقرير\s*الارسال|تقرير\s*الإرسال)(?:\s+اليوم)?(?:\s+(\d{4}-\d{2}-\d{2}))?$/i);
    if (sendReportMatch) {
      const dateArg = sendReportMatch[1];
      const summary = sendLog.getDaySummary(dateArg);
      if (summary.total === 0) {
        await msg.reply(`📭 مفيش أي رسائل اتبعت بتاريخ ${summary.date}.`);
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
        await msg.reply("📭 مفيش أي رسائل اتبعت من نظام البطاقات لحد دلوقتي.");
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
    // فحص أرقام معيّنة: "تحقق ارسال الدرافت" + الأرقام (سطر لكل رقم أو مفصولة بمسافات) - بيوري لكل
    // رقم هل اتبعتله فعلًا، ولو لأ سبب المنع. قراءة بس، مفيش إرسال لأي حد
    const checkSendMatch = toWesternDigits(text).match(/^(?:تحقق|فحص)\s*(?:من\s*)?[اإأ]رسال\s*(?:رسائل\s*)?(الدرافت|درافت|الدرفت|تذكير\s*(?:ال)?درافت|استلام\s*(?:ال)?بطاق[ةه])\s*([\s\S]+)$/i);
    if (checkSendMatch) {
      const kind = checkSendMatch[1].replace(/\s+/g, " ");
      const isDraft = /درافت/.test(kind);
      const label = isDraft ? "تذكير درافت" : "استلام البطاقة";
      const campaignType = isDraft ? "draft_reminder" : "card_pickup";
      const phones = campaignCheck.extractPhones(checkSendMatch[2]);
      if (phones.length === 0) {
        await safeReply(msg, "⚠️ ما لقيت أي رقم جوال سعودي صالح في الرسالة.");
        return;
      }
      // أرقام الملف الحالي (draft_forms.csv / card_pickup.csv) - الدور لسه ما جاش
      const inCurrentFile = new Set();
      try {
        const csvPath = isDraft ? DRAFT_FORMS_CSV : path.join(__dirname, "card_pickup.csv");
        if (fs.existsSync(csvPath)) {
          fs.readFileSync(csvPath, "utf8").split(/\r?\n/).forEach((l) => {
            const m = l.match(/9665\d{8}/);
            if (m) inCurrentFile.add(m[0]);
          });
        }
      } catch {
        // الملف مش ضروري للفحص
      }
      const results = campaignCheck.checkPhones(phones, {
        sentRows: sendLog.getAllByLabel(label),
        auditEntries: require("./lib/auditLog").readAll(),
        campaignType,
        inCurrentFile,
      });
      let reply = campaignCheck.formatCheck(label, results);
      if (isDraft && results.some((r) => !r.sent)) {
        reply += `\n\nℹ️ رسائل الدرافت محدودة بـ${portalSync.DAILY_LIMIT} مزارعين في اليوم، فالباقي بيتبعت في الأيام اللي بعد كده (بيترجع الحد كل يوم).`;
      }
      await safeReply(msg, reply);
      return;
    }

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
      // مقسّمة حسب تاريخ الإرسال (ترتيب تصاعدي) - بدل قائمة واحدة مسطّحة، عشان تعرف كل دفعة
      // اتبعت إمتى بالظبط لو الإرسال كان على أكتر من يوم
      const byDate = {};
      rows.forEach((e) => {
        if (!byDate[e.date]) byDate[e.date] = [];
        byDate[e.date].push(e);
      });
      const dates = Object.keys(byDate).sort();
      const lines = [`👥 المزارعين اللي اتبعتلهم "${matchedLabel}" (${rows.length}):`];
      dates.forEach((date) => {
        lines.push(`\n📅 ${date} (${byDate[date].length}):`);
        byDate[date].forEach((e) => lines.push(`• ${e.name || "بدون اسم"} (${e.phone})`));
      });
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

    // تجربة معزولة تمامًا لرسالة "قائمة تفاعلية" (زي قوائم أمازون/الشركات على واتساب بيزنس) -
    // "اختبار قائمة 966XXXXXXXXX". مفيش أي لمس للقائمة الرئيسية العادية للمزارعين - رسالة اختبار
    // لرقم واحد بس بيحدده المدير، عشان نتأكد هل واتساب بيقبلها فعليًا على الحساب ده (مش مضمون -
    // القوائم التفاعلية دي جزء من واتساب بيزنس الرسمي، ومش مضمون تشتغل عبر whatsapp-web.js على
    // حساب شخصي عادي) قبل ما نفكّر نستخدمها في أي حاجة حقيقية
    const listTestMatch = toWesternDigits(text).match(/^اختبار\s*قائمة\s+(\d{8,15})$/i);
    if (listTestMatch) {
      const targetPhone = normalizeSaudiPhone(listTestMatch[1]);
      try {
        const list = new List(
          "يرجى اختيار الخدمة المطلوبة:",
          "القائمة",
          [
            {
              title: "الخدمات",
              rows: [
                { id: "1", title: "التسجيل في بطاقة المزرعة" },
                { id: "2", title: "التواصل مع موظف علاقات المزارعين" },
                { id: "3", title: "الاقتراحات والشكاوى" },
              ],
            },
          ],
          "مركز الزراعة",
          "رسالة اختبار - تجاهلها لو وصلتك بالغلط"
        );
        await boundedCall("list-test-send", () => client.sendMessage(`${targetPhone}@c.us`, list), 15000);
        await msg.reply(`⏳ اتبعت رسالة القائمة التجريبية لـ ${targetPhone}. تابع مع صاحب الرقم هل ظهرتله كقائمة تفاعلية فعلًا ولا نص عادي/ما وصلتش.`);
      } catch (err) {
        await msg.reply(`❌ فشل إرسال القائمة التجريبية: ${err.message}`);
      }
      return;
    }

    // تجربة معزولة للشكل الجديد المقترح للقائمة الرئيسية (نص عادي منسّق زي رسائل الشركات) -
    // "اختبار القائمة الجديدة 966XXXXXXXXX". بيبعت نص MAIN_MENU_PREVIEW لرقم واحد بس، من غير أي
    // تأثير على القائمة الحقيقية للمزارعين العاديين لحد ما تُعتمد فعليًا (باستبدال MAIN_MENU نفسها)
    const menuPreviewMatch = toWesternDigits(text).match(/^اختبار\s*القائمة\s*الجديدة\s+(\d{8,15})$/i);
    if (menuPreviewMatch) {
      const targetPhone = normalizeSaudiPhone(menuPreviewMatch[1]);
      try {
        await boundedCall("menu-preview-send", () => client.sendMessage(`${targetPhone}@c.us`, getCfgText("MAIN_MENU_PREVIEW")), 15000);
        await msg.reply(`⏳ اتبعت الشكل الجديد المقترح للقائمة لـ ${targetPhone} - ده معاينة بس، مفيش أي تأثير على القائمة الحقيقية.`);
      } catch (err) {
        await msg.reply(`❌ فشل إرسال المعاينة: ${err.message}`);
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

    // مراجعة الرسائل القديمة اللي وصلت وقت ما البوت كان مقفول/مقيّد ومحدش رد عليها: خطوتين
    // (معاينة العدد الأول، وبعدين "تأكيد مراجعة الرسائل" للرد الفعلي) عشان الرد الجماعي المفاجئ
    // هو بالظبط اللي سبّب تقييد الحساب قبل كده
    const catchUpPreviewMatch = toWesternDigits(text).match(/^راجع\s*الرسائل\s*القديمة(?:\s+(\d{1,2}))?$/i);
    if (catchUpPreviewMatch) {
      if (catchUpRunning) {
        await msg.reply("⚠️ فيه مراجعة شغّالة بالفعل، استنى تخلص.");
        return;
      }
      const days = Math.min(parseInt(catchUpPreviewMatch[1] || "3", 10), 14);
      try {
        const MAX_PER_RUN = 25;
        const all = await listUnansweredChats(days);
        if (all.length === 0) {
          await msg.reply(`📭 مفيش محادثات فردية معلّقة (من غير رد) خلال آخر ${days} يوم.`);
          return;
        }
        const rows = all.slice(0, MAX_PER_RUN);
        pendingCatchUp = { rows, days };
        await msg.reply(
          `🔎 لقيت ${all.length} محادثة فردية آخر رسالة فيها من مزارع من غير رد (آخر ${days} يوم).\n` +
            `هرد على أقدم ${rows.length} منهم بفاصل 25-50 ثانية بين كل رد (${Math.ceil((rows.length * 37) / 60)} دقيقة تقريبًا) - بنفس منطق الرد العادي.\n\n` +
            `⚠️ الحساب اتقيّد قبل كده بسبب الإرسال الجماعي، فتأكد إن التقييد اتفك فعلًا قبل ما تأكد.\n` +
            `للبدء اكتب: تأكيد مراجعة الرسائل`
        );
      } catch (err) {
        await msg.reply(`⚠️ تعذّر قراءة المحادثات المعلّقة: ${err.message}`);
      }
      return;
    }

    if (/^تأكيد\s*مراجعة\s*الرسائل$/i.test(text)) {
      if (catchUpRunning) {
        await msg.reply("⚠️ فيه مراجعة شغّالة بالفعل، استنى تخلص.");
        return;
      }
      if (!pendingCatchUp) {
        await msg.reply('⚠️ مفيش قائمة جاهزة. اكتب "راجع الرسائل القديمة" الأول.');
        return;
      }
      const { rows } = pendingCatchUp;
      pendingCatchUp = null;
      await msg.reply(`▶️ بدأت الرد على ${rows.length} محادثة، هبلّغك لما أخلص.`);
      runCatchUp(rows, (t) => msg.reply(t).catch(() => {})).catch((err) =>
        console.log(`⚠️ [مراجعة قديمة] توقفت: ${err.message}`)
      );
      return;
    }

    // إضافة/حذف رقم يستقبل تقرير طلبات التوصيل اليومي (مقسّم شمال/جنوب/وسط) الساعة 10 صباحًا -
    // منفصل تمامًا عن "اضف مدير" (ده تقرير النشاط العام، ده تقرير التوصيل بس)
    const addDeliveryReportMatch = toWesternDigits(text).match(/^اضف\s*رقم\s*تقرير\s*التوصيل\s+(\d{8,15}(?:@lid)?)$/i);
    if (addDeliveryReportMatch) {
      const phone = addDeliveryReportMatch[1];
      const added = deliveryStore.addReportRecipient(phone);
      await msg.reply(added ? `✅ تمت إضافة ${phone} كمستقبل لتقرير طلبات التوصيل اليومي (الساعة 10 صباحًا).` : `ℹ️ الرقم ${phone} مضاف بالفعل.`);
      return;
    }

    const removeDeliveryReportMatch = toWesternDigits(text).match(/^احذف\s*رقم\s*تقرير\s*التوصيل\s+(\d{8,15}(?:@lid)?)$/i);
    if (removeDeliveryReportMatch) {
      const phone = removeDeliveryReportMatch[1];
      const removed = deliveryStore.removeReportRecipient(phone);
      await msg.reply(removed ? `✅ تم حذف ${phone} من مستقبلي تقرير التوصيل.` : `ℹ️ الرقم ${phone} مش موجود أصلًا.`);
      return;
    }

    // فحص فوري لتسليم الطلبات من المنصة (تاب Delivered) - نفس الفحص اللي بيتعمل بعد كل مزامنة
    if (/^(فحص|تحقق)\s*(من\s*)?(ال)?تسليم\s*(من\s*)?(ال)?منص[ةه]$/i.test(text)) {
      if (!portalSync.isConfigured()) {
        await safeReply(msg, "⚠️ نظام البطاقات مش متظبّط أصلًا.");
        return;
      }
      if (broadcastInProgress) {
        await safeReply(msg, "⏳ فيه مهمة تانية شغّالة (إرسال أو مزامنة) - جرّب بعد دقائق.");
        return;
      }
      await safeReply(msg, "⏳ بفحص تاب \"تم التسليم\" في المنصة وبطابقه مع طلبات التوصيل (ممكن ياخد دقيقة)...");
      let reply;
      broadcastInProgress = true;
      try {
        const text2 = await boundedCall("deliveries-reconcile", () => reconcileDeliveriesWithPortal(), 9 * 60 * 1000);
        const updated = reconcileDeliveriesWithPortal.lastUpdated || [];
        reply = `✅ ${text2}${updated.length ? "\n\n" + updated.map((u) => `• ${u.id} - ${u.name || u.phone}`).join("\n") : ""}`;
      } catch (err) {
        reply = `⚠️ تعذّر الفحص: ${err.message}`;
      } finally {
        broadcastInProgress = false;
      }
      await safeReply(msg, reply);
      return;
    }

    // موظف تجهيز البطاقات: إضافة/حذف/عرض أرقامه، وطلب القائمة فورًا
    const addPrepMatch = toWesternDigits(text).match(/^اضف\s*رقم\s*تجهيز\s*(?:ال)?بطاقات\s+(\d{8,15}(?:@lid)?)$/i);
    if (addPrepMatch) {
      const added = deliveryStore.addPrepRecipient(addPrepMatch[1]);
      await msg.reply(added ? `✅ تمت إضافة ${addPrepMatch[1]} كمستقبل لقائمة تجهيز البطاقات اليومية (الساعة 10 صباحًا).` : `ℹ️ الرقم ${addPrepMatch[1]} مضاف بالفعل.`);
      return;
    }
    const removePrepMatch = toWesternDigits(text).match(/^احذف\s*رقم\s*تجهيز\s*(?:ال)?بطاقات\s+(\d{8,15}(?:@lid)?)$/i);
    if (removePrepMatch) {
      const removed = deliveryStore.removePrepRecipient(removePrepMatch[1]);
      await msg.reply(removed ? `✅ تم حذف ${removePrepMatch[1]} من مستقبلي قائمة التجهيز.` : `ℹ️ الرقم ${removePrepMatch[1]} مش موجود أصلًا.`);
      return;
    }
    if (/^ارقام\s*تجهيز\s*(ال)?بطاقات$/i.test(text)) {
      const list = deliveryStore.getPrepRecipients();
      await msg.reply(`📋 مستقبلو قائمة تجهيز البطاقات (10 صباحًا):\n\n${list.length ? list.join("\n") : "لا يوجد"}`);
      return;
    }
    if (/^تجهيز\s*(ال)?بطاقات$/i.test(text)) {
      try {
        const data = buildFullReport();
        await safeReply(msg, formatPrepList(data));
        if (data.rows.some((r) => r.status === "NEW")) await sendDeliveryReportFile(msg.from, data, "prep");
      } catch (err) {
        await safeReply(msg, `⚠️ تعذّر تجهيز قائمة التجهيز: ${err.message}`);
      }
      return;
    }

    if (/^ارقام\s*تقرير\s*التوصيل$/i.test(text)) {
      const list = deliveryStore.getReportRecipients();
      await msg.reply(`📋 مستقبلو تقرير طلبات التوصيل اليومي (10 صباحًا):\n\n${list.length ? list.join("\n") : "لا يوجد"}`);
      return;
    }

    // تشغيل فوري لتقرير طلبات التوصيل (من غير استنى الساعة 10 صباحًا) - بيتبعت لنفس المحادثة
    // اللي طلبته، مش لقائمة المستقبلين المسجّلين (عشان تقدر تعاين الشكل بسرعة)
    if (/^تقرير\s*التوصيل$/i.test(text) || /^تفاصيل\s*(ال)?مستفيدين$/i.test(text)) {
      try {
        const data = buildFullReport();
        const detailsOnly = /^تفاصيل/i.test(text);
        if (!detailsOnly || data.total === 0) await safeReply(msg, formatFullReportMessage(data));
        if (data.total > 0) await sendDeliveryReportFile(msg.from, data);
      } catch (err) {
        await safeReply(msg, `⚠️ تعذّر تجهيز تقرير التوصيل: ${err.message}`);
      }
      return;
    }

    // استبعاد طلب (تجريبي مثلًا) من أرقام التقرير الكامل - الطلب نفسه بيفضل محفوظ
    const excludeMatch = toWesternDigits(text).match(/^استبعد\s*طلب\s*(?:توصيل\s*)?(D-\d+)\s*(?:من\s*التقرير)?$/i);
    if (excludeMatch) {
      const id = excludeMatch[1].toUpperCase();
      if (!deliveryStore.findRequest(id)) {
        await safeReply(msg, `⚠️ مفيش طلب توصيل بالرقم ${id}.`);
      } else {
        const added = deliveryStore.excludeFromReports(id);
        await safeReply(msg, added ? `✅ الطلب ${id} اتستبعد من تقرير التوصيل.` : `ℹ️ الطلب ${id} مستبعد بالفعل.`);
      }
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

    // "حالة البوت" - أمر إداري قراءة فقط بالكامل (بند 6): مفيش أي كتابة أو تعديل حالة هنا، ومفيش
    // استهلاك لحصة الحملات (50/ساعة و500/يوم) أبدًا - بس عرض حالة حالية
    if (/^حالة\s*البوت$/i.test(text)) {
      try {
        const rlStatus = rateLimiter.getStatus();
        const uptimeSec = Math.floor(process.uptime());
        const uptimeStr = `${Math.floor(uptimeSec / 3600)} ساعة ${Math.floor((uptimeSec % 3600) / 60)} دقيقة`;
        const knownStoreFiles = [
          path.join(__dirname, "farmer_registry.json"),
          path.join(__dirname, "farmer_state.json"),
          path.join(__dirname, "send_fingerprints.json"),
          path.join(__dirname, "sent_history.json"),
          path.join(__dirname, "send_log.json"),
          path.join(__dirname, "rate_limit_state.json"),
        ];
        const health = safeJsonStore.checkHealth(knownStoreFiles);
        const lastEntry = sendLog.getLastEntry();

        // إجمالي حالات الحملات عبر كل ملفات campaigns/*.json - قراءة فقط
        const campaignsDir = path.join(__dirname, "campaigns");
        let statusCounts = { sent: 0, pending: 0, failed: 0, not_on_whatsapp: 0, delivery_uncertain: 0, blocked_previous_contact: 0, blocked_review_required: 0 };
        let activeCampaignLine = "لا توجد حملة نشطة حاليًا";
        if (fs.existsSync(campaignsDir)) {
          const files = fs.readdirSync(campaignsDir).filter((f) => f.endsWith(".json") && !f.includes(".before-reconcile"));
          let latestCampaign = null;
          files.forEach((f) => {
            try {
              const c = JSON.parse(fs.readFileSync(path.join(campaignsDir, f), "utf8"));
              c.rows.forEach((r) => {
                if (statusCounts[r.status] !== undefined) statusCounts[r.status]++;
              });
              if (!latestCampaign || new Date(c.createdAt) > new Date(latestCampaign.createdAt)) latestCampaign = c;
            } catch {
              // ملف تالف - نتجاهله في العرض بس (قراءة فقط، مفيش أي تعديل)
            }
          });
          if (latestCampaign) {
            const pendingLeft = latestCampaign.rows.filter((r) => r.status === "pending").length;
            activeCampaignLine =
              `آخر حملة: ${latestCampaign.id} (${latestCampaign.label || "-"})` +
              (latestCampaign.pausedSafe
                ? " - ⛔ PAUSED_SAFE (موعد الاستئناف: بعد موافقة صريحة يدويًا بس)"
                : pendingLeft > 0
                ? ` - ${pendingLeft} صف لسه pending`
                : " - مكتملة");
          }
        }

        await msg.reply(
          `🤖 حالة البوت:\n\n` +
            `🔌 اتصال واتساب: ${client.info ? "متصل ✅" : "غير متصل ❌"}\n` +
            `⏱️ مدة التشغيل: ${uptimeStr}\n` +
            `🔄 Portal Sync: ${portalSync && typeof portalSync.getLastSyncInfo === "function" ? JSON.stringify(portalSync.getLastSyncInfo()) : "غير متاح"}\n` +
            `📢 ${activeCampaignLine}\n` +
            `SENT: ${statusCounts.sent} | PENDING: ${statusCounts.pending} | FAILED: ${statusCounts.failed} | NOT_ON_WHATSAPP: ${statusCounts.not_on_whatsapp} | DELIVERY_UNCERTAIN: ${statusCounts.delivery_uncertain} | BLOCKED: ${statusCounts.blocked_previous_contact + statusCounts.blocked_review_required}\n\n` +
            `📊 حصة الحملات: ${rlStatus.hourly.used}/${rlStatus.hourly.limit} في الساعة، ${rlStatus.daily.used}/${rlStatus.daily.limit} في اليوم${rlStatus.paused ? " (متوقفة مؤقتًا)" : ""}\n` +
            `📨 آخر إرسال: ${lastEntry ? `${lastEntry.name || lastEntry.phone} - ${lastEntry.status} (${lastEntry.date} ${lastEntry.time})` : "لا يوجد"}\n\n` +
            `💾 Persistence: ${health.healthy ? "HEALTHY ✅" : `FAILED ⚠️ (ملفات .tmp عالقة: ${health.orphanedTmp.join(", ")})`}`
        );
      } catch (err) {
        await msg.reply(`⚠️ تعذّر قراءة حالة البوت حاليًا: ${err.message}`);
      }
      return;
    }

    // "حالة الحملة c1789640068672" - تفاصيل حملة "رسائل مخصصة" (campaignStore) معيّنة بمعرّفها،
    // قراءة فقط، ومفيش استئناف تلقائي من هنا خالص حتى لو ظهرت pending
    const campaignStatusMatch = text.match(/^حالة\s*الحملة\s+(\S+)$/i);
    if (campaignStatusMatch) {
      try {
        const campaign = campaignStore.getCampaign(campaignStatusMatch[1]);
        if (!campaign) {
          await msg.reply("📭 مفيش حملة بهذا المعرّف.");
          return;
        }
        const counts = {};
        campaign.rows.forEach((r) => {
          counts[r.status] = (counts[r.status] || 0) + 1;
        });
        const countsLine = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" | ");
        await msg.reply(
          `📢 حالة الحملة ${campaign.id}:\n\n` +
            `التسمية: ${campaign.label || "-"}\n` +
            `تاريخ الإنشاء: ${campaign.createdAt}\n` +
            `إجمالي الصفوف: ${campaign.rows.length}\n` +
            `${countsLine}\n\n` +
            `⛔ حالة الاستئناف: ${
              campaign.pausedSafe
                ? `PAUSED_SAFE (${campaign.pausedSafeReason || "-"}) - ممنوع الاستئناف لحد موافقة صريحة`
                : "غير موقوفة PAUSED_SAFE (بس برضه الاستئناف يدوي بأمر تأكيد ارسال)"
            }`
        );
      } catch (err) {
        await msg.reply(`⚠️ تعذّر قراءة حالة الحملة حاليًا: ${err.message}`);
      }
      return;
    }

    // "سجل 966555323315" أو "سجل أحمد عبدالله" - يعرض سجل المزارع الدائم (Farmer Registry):
    // الاسم العربي الموثوق، Farmer State (بيتقرا من farmerState.js مباشرة وقت الطلب - مش
    // نسخة مخزّنة هنا، عشان يفضل دايمًا مطابق للمصدر الحقيقي)، Communication Status، وباقي البيانات
    const registryByPhoneMatch = toWesternDigits(text).match(/^سجل\s+(\d{8,15})$/i);
    const registryByNameMatch = text.match(/^سجل\s+([^\d].+)$/);
    if (registryByPhoneMatch || registryByNameMatch) {
      try {
        let entries = [];
        if (registryByPhoneMatch) {
          const phone = normalizeSaudiPhone(registryByPhoneMatch[1]);
          const found = farmerRegistry.searchByPhone(phone);
          if (found) entries = [found];
        } else {
          entries = farmerRegistry.searchByName(registryByNameMatch[1].trim());
        }

        if (entries.length === 0) {
          await msg.reply("📭 مفيش سجل مطابق في Farmer Registry.");
          return;
        }
        if (entries.length > 5) {
          await msg.reply(`🔎 فيه ${entries.length} نتيجة مطابقة - حدد رقم الجوال بالظبط عشان تشوف التفاصيل.`);
          return;
        }

        const lines = entries.map((entry) => {
          const currentState = farmerState.getState(entry.phone).state;
          return (
            `👤 اسم المزارع: ${entry.nameArabic || "غير مسجّل"}\n` +
            `📱 الجوال: ${entry.phone}\n` +
            `📍 حالة المزارع: ${farmerRegistry.FARMER_STATE_AR[currentState] || currentState}\n` +
            `💬 حالة التواصل: ${farmerRegistry.COMMUNICATION_STATUS_AR[entry.communicationStatus] || entry.communicationStatus}\n` +
            `📝 سبب آخر تواصل: ${farmerRegistry.CONTACT_REASON_AR[entry.lastContactReason] || entry.lastContactReason || "-"}\n` +
            `📡 مصدر آخر رسالة: ${farmerRegistry.MESSAGE_SOURCE_AR[entry.lastMessageSource] || entry.lastMessageSource || "-"}\n` +
            `🕒 آخر تواصل: ${entry.lastContactAt || "-"}\n` +
            `📊 إجمالي الرسائل الناجحة: ${entry.totalMessages || 0}\n` +
            `📢 الحملة: ${entry.campaignLabel || "-"}${entry.campaignId ? ` (${entry.campaignId})` : ""}`
          );
        });
        await msg.reply(lines.join("\n\n---\n\n"));
      } catch (err) {
        await msg.reply(`⚠️ تعذّر قراءة السجل حاليًا: ${err.message}`);
      }
      return;
    }

    // "تواصل 966555323315" - يعرض سجل التواصل الكامل (Communication History) لمزارع معيّن،
    // من غير محتوى حساس زيادة عن اللازم (تاريخ + مصدر + سبب + حالة الإرسال بس)
    const historyMatch = toWesternDigits(text).match(/^تواصل\s+(\d{8,15})$/i);
    if (historyMatch) {
      try {
        const phone = normalizeSaudiPhone(historyMatch[1]);
        const entry = farmerRegistry.searchByPhone(phone);
        if (!entry || !entry.communicationHistory || entry.communicationHistory.length === 0) {
          await msg.reply("📭 مفيش سجل تواصل مسجّل لهذا الرقم.");
          return;
        }
        const sorted = [...entry.communicationHistory].sort((a, b) => (a.date < b.date ? 1 : -1));
        const lines = sorted
          .slice(0, 20)
          .map((h, i) => {
            const dateOnly = (h.date || "").slice(0, 10).split("-").reverse().join("/");
            const reasonAr = farmerRegistry.CONTACT_REASON_AR[h.reason] || h.reason || "-";
            return `${i + 1}. ${dateOnly} — ${reasonAr} — ${h.status === "SENT" ? "تم الإرسال" : h.status}`;
          });
        await msg.reply(`📜 سجل التواصل - ${entry.nameArabic || phone}:\n\n${lines.join("\n")}`);
      } catch (err) {
        await msg.reply(`⚠️ تعذّر قراءة سجل التواصل حاليًا: ${err.message}`);
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
      open.forEach((t) =>
        lines.push(
          `• ${t.ticket_id} - ${t.farmer_name || "بدون اسم"} (${t.phone || "-"}${t.region ? " - " + t.region : ""}) - ${t.category} - ${t.created_at}`
        )
      );
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
  // رسالة من رقم البوت نفسه جوّه مجموعة (مالك الرقم بيربط مجموعة توصيل)
  if (msg.to && msg.to.endsWith("@g.us")) {
    await maybeRegisterDeliveryGroup(msg, msg.to, null, true);
    return;
  }
  if (!(await isTrueSelfChat(msg))) return;

  msg.isSelfChatCommand = true;
  await handleControlCommand(msg);
});

console.log("🔌 [بدء] جاري نداء client.initialize() (فتح Chrome والاتصال بواتساب ويب)...");
client.initialize().catch((err) => {
  console.log(`🚨 [فشل التهيئة] client.initialize() رفض الـpromise: ${err.message}`);
  process.exit(1);
});
