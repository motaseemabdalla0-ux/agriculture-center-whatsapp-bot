const fs = require("fs");
const path = require("path");

// كل بيانات صندوق استقبال الحملات (Metadata + الملفات الخام المرفوعة) - منفصلة تمامًا عن:
// - كود المشروع (بيتحدّث من GitHub)
// - بيانات التشغيل الأساسية (farmer_state.json, sent_history.json...) في جذر المشروع
// - صفوف الحملة الفعلية وحالتها لكل رقم (lib/campaignStore.js - مُعاد استخدامها زي ما هي)
const DATA_DIR = path.join(__dirname, "data");
const FILES_DIR = path.join(DATA_DIR, "files");
const META_FILE = path.join(DATA_DIR, "inbox.json");

// الحالات المسموحة لدورة حياة الحملة - أي انتقال لازم يمر بالترتيب ده منطقيًا (مفروضة في
// inboxEngine.js، مش هنا - هنا بس تخزين)
const STATUSES = [
  "RECEIVED",
  "VALIDATING",
  "PREVIEW_READY",
  "DRY_RUN_READY",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SENDING",
  "PAUSED", // إيقاف مؤقت يدوي عام (سبب مش hourly/daily limit - زي خطأ عام غير متوقع)
  "PAUSED_HOURLY_LIMIT", // وصلنا لحد الـCampaign الساعي (50) - استئناف تلقائي أول ما الساعة الجاية تبدأ
  "PAUSED_DAILY_LIMIT", // وصلنا لحد الـCampaign اليومي (500) - استئناف تلقائي أول ما يوم جديد يبدأ
  "COMPLETED",
  "FAILED",
  "REJECTED",
];

const PURPOSES = ["REGISTRATION", "DOCUMENTS", "CARD", "GENERAL_NOTICE", "SURVEY", "EVALUATION"];

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
}

function load() {
  ensureDirs();
  if (!fs.existsSync(META_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch {
    // الملف تالف - بنرجع فاضي (مش بيانات تشغيلية حساسة زي farmer_state، ومفيش إرسال هيحصل
    // غلط بسببه لأن أي حملة من غير Metadata سليمة أصلًا مش هتقدر توصل لمرحلة الإرسال)
    return {};
  }
}

function save(all) {
  ensureDirs();
  const tmp = `${META_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
  fs.renameSync(tmp, META_FILE);
}

// campaignId فريد ومضمون عدم التكرار - timestamp + رقم عشوائي قصير
function generateCampaignId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `inbox_${Date.now()}_${rand}`;
}

function createCampaignMeta({ fileName, purpose, campaignType, message, uploadedBy, source }) {
  ensureDirs();
  const all = load();
  let campaignId = generateCampaignId();
  while (all[campaignId]) campaignId = generateCampaignId(); // احتياط إضافي (شبه مستحيل يحصل تصادم)

  const meta = {
    campaignId,
    fileName,
    uploadedAt: new Date().toISOString(),
    campaignPurpose: purpose || null,
    campaignType: campaignType || null,
    message: message || "",
    uploadedBy: uploadedBy || "",
    source: source || "unknown",
    status: "RECEIVED",
    rowsCampaignId: null, // معرّف حملة lib/campaignStore.js المرتبط (بعد بناء الصفوف)
    preview: null,
    dryRun: null,
    history: [{ status: "RECEIVED", at: new Date().toISOString() }],
  };
  all[campaignId] = meta;
  save(all);
  return meta;
}

function getMeta(campaignId) {
  return load()[campaignId] || null;
}

function updateMeta(campaignId, patch) {
  const all = load();
  if (!all[campaignId]) return null;
  Object.assign(all[campaignId], patch);
  save(all);
  return all[campaignId];
}

function setStatus(campaignId, status, extra = {}) {
  if (!STATUSES.includes(status)) throw new Error(`INVALID_CAMPAIGN_INBOX_STATUS: ${status}`);
  const all = load();
  if (!all[campaignId]) return null;
  all[campaignId].status = status;
  all[campaignId].history.push({ status, at: new Date().toISOString(), ...extra });
  Object.assign(all[campaignId], extra);
  save(all);
  return all[campaignId];
}

function listCampaigns() {
  return Object.values(load()).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
}

function saveUploadedFile(campaignId, fileName, buffer) {
  ensureDirs();
  const dir = path.join(FILES_DIR, campaignId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = {
  STATUSES,
  PURPOSES,
  createCampaignMeta,
  getMeta,
  updateMeta,
  setStatus,
  listCampaigns,
  saveUploadedFile,
  DATA_DIR,
  FILES_DIR,
};
