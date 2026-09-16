const path = require("path");
const { parseFarmerMessageRows } = require("../lib/fileIngest");
const { fillTemplate } = require("../lib/personalizedRunner");
const { buildCampaignRows, summarizeCampaignRows } = require("../lib/campaignBuilder");
const campaignStore = require("../lib/campaignStore");
const { sendCampaignRows } = require("../lib/campaignRunner");
const rateLimiter = require("../lib/rateLimiter");
const inboxStore = require("./inboxStore");

// حالات "متوقفة مؤقتًا بسبب حصة الحملات" - أي حملة فيها واحدة منهم لسه تعتبر شغالة منطقيًا،
// وقابلة للاستئناف التلقائي (campaign-inbox/campaignScheduler.js) أول ما الحصة تتفتح تاني
const RATE_LIMIT_PAUSE_STATUSES = ["PAUSED_HOURLY_LIMIT", "PAUSED_DAILY_LIMIT"];
function pausedStatusFor(reason) {
  if (reason === "hourly_limit") return "PAUSED_HOURLY_LIMIT";
  if (reason === "daily_limit") return "PAUSED_DAILY_LIMIT";
  return "PAUSED"; // "cooldown" أو "paused" (إيقاف يدوي عام) - إيقاف عام مش مرتبط بساعة/يوم محدد
}

// الطبقة دي بتستخدم نفس محرك الأمان الموجود فعلًا حرفيًا (campaignBuilder/campaignStore/
// campaignRunner/safeFarmerSend) - صفر تكرار لمنطق الأمان، وصفر تعديل عليه. دور inboxEngine
// هو بس تنسيق دورة حياة "حملة جاية من مصدر خارجي" (رفع ملف) قبل ما توصل لنفس المحرك ده:
// Upload -> Validate -> Preview -> DRY RUN -> Approval -> Real Send
// أي ملف يوصل هنا ما بيتبعتش تلقائيًا أبدًا - لازم يعدي على كل الخطوات دي بالترتيب.

const ALLOWED_EXTENSIONS = [".xlsx", ".csv"];
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB - كافي جدًا لملف مزارعين حتى لو آلاف الصفوف
const MAX_ROWS = 10000;

function validateFile(fileName, buffer) {
  const ext = path.extname(fileName || "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, reason: `UNSUPPORTED_FILE_TYPE: مسموح بس ${ALLOWED_EXTENSIONS.join(", ")}` };
  }
  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: "EMPTY_FILE" };
  }
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    return { ok: false, reason: `FILE_TOO_LARGE: أقصى حجم مسموح ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB` };
  }
  return { ok: true };
}

// الخطوة 1: استقبال حملة جديدة (من أي Adapter) - RECEIVED -> VALIDATING -> PREVIEW_READY أو REJECTED
async function receiveCampaign({ buffer, fileName, purpose, campaignType, message, uploadedBy, source }) {
  const meta = inboxStore.createCampaignMeta({ fileName, purpose, campaignType, message, uploadedBy, source });

  const fileCheck = validateFile(fileName, buffer);
  if (!fileCheck.ok) {
    return inboxStore.setStatus(meta.campaignId, "REJECTED", { rejectReason: fileCheck.reason });
  }

  inboxStore.saveUploadedFile(meta.campaignId, fileName, buffer);
  inboxStore.setStatus(meta.campaignId, "VALIDATING");

  if (!purpose || !inboxStore.PURPOSES.includes(purpose)) {
    return inboxStore.setStatus(meta.campaignId, "REJECTED", { rejectReason: "MISSING_CAMPAIGN_PURPOSE" });
  }

  let parsed;
  try {
    // القالب الموحّد: اسم الشخص | رقم الهاتف | الرسالة (بأي مسمّى عمود بديل عربي/إنجليزي).
    // لو الملف فيه عمود رسالة، كل صف بياخد رسالته هو بالظبط - مفيش رسالة واحدة إجبارية للحملة.
    // لو مفيش عمود رسالة (ملف قديم زي درافت/رفيو من غير عمود رسالة)، لازم campaign-level
    // "message" يكون متوفر ومتبني منه رسالة كل صف عن طريق fillTemplate (توافق مع الحملات القديمة)
    parsed = parseFarmerMessageRows(buffer);
  } catch (err) {
    return inboxStore.setStatus(meta.campaignId, "REJECTED", { rejectReason: `PARSE_ERROR: ${err.message}` });
  }

  if (parsed.rows.length === 0) {
    return inboxStore.setStatus(meta.campaignId, "REJECTED", { rejectReason: "NO_VALID_ROWS_FOUND" });
  }
  if (parsed.rows.length > MAX_ROWS) {
    return inboxStore.setStatus(meta.campaignId, "REJECTED", { rejectReason: `TOO_MANY_ROWS: أقصى عدد مسموح ${MAX_ROWS} صف` });
  }
  if (!parsed.hasMessageColumn && (!message || !message.trim())) {
    return inboxStore.setStatus(meta.campaignId, "REJECTED", { rejectReason: "MISSING_MESSAGE" });
  }

  const withMessage = parsed.rows.map((r) => ({
    name: r.name,
    phone: r.phone,
    applicationId: r.request_number || undefined,
    // القالب الجديد: رسالة كل صف كما هي حرفيًا (زي ما طُلب - مفيش رسالة موحّدة إجبارية).
    // التوافق القديم: رسالة واحدة على مستوى الحملة، مع دعم {name} داخلها لكل صف
    message: parsed.hasMessageColumn ? r.message : fillTemplate(message, r),
  }));

  const built = buildCampaignRows(withMessage, purpose);
  if (built.rejected) {
    return inboxStore.setStatus(meta.campaignId, "REJECTED", { rejectReason: built.reason });
  }

  const rowsCampaignId = campaignStore.createCampaign({
    label: `صندوق الحملات: ${fileName}`,
    createdBy: uploadedBy || source || "campaign-inbox",
    rows: built.rows,
  });

  const preview = summarizeCampaignRows(built.rows);
  // تفاصيل كل صف (Name/Phone/Message Preview/Decision/Reason) - مش بس المستبعد، كل الصفوف
  // عشان يبقى فيه صورة كاملة قبل أي DRY RUN أو Approval
  const rowDetails = built.rows.map((r) => ({
    name: r.name,
    phone: r.phone,
    messagePreview: (r.message || "").slice(0, 80),
    decision: r.status === "pending" ? "READY_TO_SEND" : r.status.toUpperCase(),
    reason: r.reason || r.state || null,
  }));

  return inboxStore.setStatus(meta.campaignId, "PREVIEW_READY", {
    rowsCampaignId,
    usedPerRowMessage: parsed.hasMessageColumn,
    preview: { ...preview, rows: rowDetails, estimatedPlan: buildEstimatedPlan(preview.valid) },
  });
}

// خطة توزيع تقديرية على الأيام - بس للعرض في الـPreview (مش تنفيذ فعلي؛ الاستئناف الحقيقي
// بيحصل تلقائيًا يوم بيوم عن طريق campaignScheduler.js حسب الحصة الفعلية وقتها). بتفترض إن
// الحملة دي هتاخد الحصة اليومية كاملة لوحدها من غير حملات تانية بتشارك - تقدير أدنى (Minimum)
function buildEstimatedPlan(readyToSend) {
  const dailyLimit = rateLimiter.getConfig().daily;
  if (readyToSend <= 0) return { dailyLimit, estimatedDays: 0, days: [] };
  const days = [];
  let remaining = readyToSend;
  let dayNum = 1;
  while (remaining > 0) {
    const sendToday = Math.min(dailyLimit, remaining);
    days.push({ day: dayNum, count: sendToday });
    remaining -= sendToday;
    dayNum++;
  }
  return { dailyLimit, estimatedDays: days.length, days };
}

// الخطوة 2: DRY RUN إلزامي قبل أي Approval - بيستخدم safeFarmerSend الحقيقي (عن طريق
// sendCampaignRows الموجودة أصلًا) مع DRY_RUN=true، فبيرجع كل الـDecisions الحقيقية
// (WOULD_SEND/BLOCKED_BY_STATE/BLOCKED_STALE_APPLICATION/DUPLICATE/RATE_LIMITED...) من غير
// أي نداء sendMessage حقيقي، ومن غير أي استهلاك لـRate Limit (تم إصلاح الترتيب في المرحلة السابقة)
async function runDryRun(campaignId, client) {
  const meta = inboxStore.getMeta(campaignId);
  if (!meta) throw new Error("CAMPAIGN_NOT_FOUND");
  if (meta.status !== "PREVIEW_READY" && meta.status !== "DRY_RUN_READY") {
    throw new Error(`CAMPAIGN_NOT_READY_FOR_DRY_RUN: الحالة الحالية ${meta.status}`);
  }

  const prevDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = "true";
  let summary;
  try {
    summary = await sendCampaignRows(client, meta.rowsCampaignId);
  } finally {
    process.env.DRY_RUN = prevDryRun; // نرجّع القيمة الأصلية بالظبط (مش نحطها false غصب)
  }

  return inboxStore.setStatus(campaignId, "AWAITING_APPROVAL", {
    dryRun: { ranAt: new Date().toISOString(), summary },
  });
}

// الخطوة 3: Approval صريح - إلزامي قبل أي إرسال حقيقي، ولازم يكون فيه DRY RUN ناجح قبله
function approveCampaign(campaignId, approvedBy) {
  const meta = inboxStore.getMeta(campaignId);
  if (!meta) throw new Error("CAMPAIGN_NOT_FOUND");
  if (meta.status !== "AWAITING_APPROVAL") {
    throw new Error(`CAMPAIGN_NOT_AWAITING_APPROVAL: الحالة الحالية ${meta.status} - لازم يعدي على Preview وDRY RUN ناجح الأول`);
  }
  if (!meta.dryRun) {
    throw new Error("APPROVAL_REQUIRES_SUCCESSFUL_DRY_RUN");
  }
  return inboxStore.setStatus(campaignId, "APPROVED", { approvedBy: approvedBy || "", approvedAt: new Date().toISOString() });
}

function rejectCampaign(campaignId, reason) {
  return inboxStore.setStatus(campaignId, "REJECTED", { rejectReason: reason || "manual" });
}

// الخطوة 4: الإرسال الفعلي - لازم APPROVED (أو متوقفة بسبب حصة سابقة) قبله، ولازم DRY_RUN=false
// فعليًا (safeFarmerSend هو اللي بيقرر بناءً على process.env.DRY_RUN الحقيقي وقت التشغيل).
// بتُنادى يدويًا (أول مرة بعد Approval) أو تلقائيًا من campaignScheduler.js (الاستئناف بعد
// حصة ساعية/يومية) - نفس الدالة، نفس مسار الأمان بالظبط، مفيش فرق بين النداءين
async function sendApprovedCampaign(campaignId, client) {
  const meta = inboxStore.getMeta(campaignId);
  if (!meta) throw new Error("CAMPAIGN_NOT_FOUND");
  const resumable = ["APPROVED", "PAUSED", ...RATE_LIMIT_PAUSE_STATUSES];
  if (!resumable.includes(meta.status)) {
    throw new Error(`CAMPAIGN_NOT_APPROVED: الحالة الحالية ${meta.status}`);
  }

  inboxStore.setStatus(campaignId, "SENDING");
  let summary;
  try {
    summary = await sendCampaignRows(client, meta.rowsCampaignId);
  } catch (err) {
    inboxStore.setStatus(campaignId, "FAILED", { failReason: err.message });
    throw err;
  }

  const remaining = campaignStore.getRowsByStatus(meta.rowsCampaignId, ["pending"]).length;
  let finalStatus;
  if (remaining === 0) {
    finalStatus = "COMPLETED";
  } else if (summary.pausedReason) {
    finalStatus = pausedStatusFor(summary.pausedReason);
  } else {
    // مفيش pausedReason بس لسه فيه pending؟ (زي لو الحلقة خلصت من غير سبب واضح) - إيقاف عام آمن
    finalStatus = "PAUSED";
  }
  return inboxStore.setStatus(campaignId, finalStatus, { lastSendSummary: summary });
}

// لوحة تقدّم الحملة الكاملة - محسوبة لحظيًا من campaignStore (الصفوف) + rateLimiter (الحصة)،
// من غير أي عداد مكرر مخزّن بشكل منفصل عرضة يتعارض مع المصدر الحقيقي
function getCampaignProgress(campaignId) {
  const meta = inboxStore.getMeta(campaignId);
  if (!meta) throw new Error("CAMPAIGN_NOT_FOUND");
  const rowsCampaign = meta.rowsCampaignId ? campaignStore.getCampaign(meta.rowsCampaignId) : null;
  const rows = rowsCampaign ? rowsCampaign.rows : [];

  const counts = { pending: 0, sent: 0, failed: 0, not_on_whatsapp: 0, duplicate: 0, excluded_by_state: 0, blocked_by_state: 0, blocked_stale_application: 0, stale_application: 0, invalid_phone: 0, missing_name: 0, missing_message: 0, already_received: 0 };
  rows.forEach((r) => {
    counts[r.status] = (counts[r.status] || 0) + 1;
  });
  const excluded = Object.entries(counts)
    .filter(([k]) => !["pending", "sent", "failed", "not_on_whatsapp"].includes(k))
    .reduce((sum, [, v]) => sum + v, 0);

  const rateStatus = rateLimiter.getStatus();
  const lastProcessedRow = rows.length - counts.pending; // آخر index اتعالج (تقريبي - ترتيب المعالجة تسلسلي)

  return {
    campaignId,
    campaignName: meta.fileName,
    status: meta.status,
    totalUploaded: meta.preview ? meta.preview.total : rows.length,
    readyToSend: meta.preview ? meta.preview.valid : null,
    sent: counts.sent,
    remaining: counts.pending,
    excluded,
    failed: counts.failed + counts.not_on_whatsapp,
    retryPending: 0, // لسه معتمدين على sendWithRetry الداخلي في safeFarmerSend + "اعادة محاولة" اليدوية القديمة (مفيش تمييز تلقائي منفصل حاليًا)
    campaignSentToday: rateStatus.daily.used,
    campaignDailyLimit: rateStatus.daily.limit,
    campaignSentThisHour: rateStatus.hourly.used,
    campaignHourlyLimit: rateStatus.hourly.limit,
    estimatedDaysRemaining: rateStatus.daily.limit > 0 ? Math.ceil(counts.pending / rateStatus.daily.limit) : null,
    lastProcessedRow: Math.max(0, lastProcessedRow),
    nextResumeTime: RATE_LIMIT_PAUSE_STATUSES.includes(meta.status)
      ? meta.status === "PAUSED_HOURLY_LIMIT"
        ? rateStatus.hourly.resetAt
        : rateStatus.daily.resetAt
      : null,
  };
}

module.exports = {
  receiveCampaign,
  runDryRun,
  approveCampaign,
  rejectCampaign,
  sendApprovedCampaign,
  getCampaignProgress,
  RATE_LIMIT_PAUSE_STATUSES,
  validateFile,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  MAX_ROWS,
};
