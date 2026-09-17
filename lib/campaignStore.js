const fs = require("fs");
const path = require("path");
const { writeJsonAtomicSync } = require("./safeJsonStore");

// كل حملة "رسائل مخصصة" بتتحفظ كملف JSON مستقل ليها معرّف ثابت، فيه كل صف وحالته
// (pending/sent/failed/not_on_whatsapp/invalid_phone/duplicate). ده بيسمح بـ:
// - استكمال الحملة من مكانها بعد إعادة تشغيل البوت (الصفوف اللي خلصت فعلًا متسجّلة على طول)
// - منع تكرار التنفيذ (لو مفيش صفوف "pending" باقية، الحملة خلصت ومتتكررش)
// - إعادة محاولة الفاشل بس، من غير ما نلمس اللي اتبعت بنجاح
const CAMPAIGNS_DIR = path.join(__dirname, "..", "campaigns");

function ensureDir() {
  if (!fs.existsSync(CAMPAIGNS_DIR)) fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
}

function filePathFor(id) {
  return path.join(CAMPAIGNS_DIR, `${id}.json`);
}

// كتابة ذرّية (ملف مؤقت + rename) عشان لو العملية اتقفلت فجأة نص كتابة حالة صف،
// الملف يفضل سليم بآخر حالة محفوظة بدل ما يتلف بالكامل
function saveCampaign(campaign) {
  ensureDir();
  const file = filePathFor(campaign.id);
  writeJsonAtomicSync(file, null, campaign);
}

function createCampaign({ label, createdBy, rows }) {
  ensureDir();
  const id = `c${Date.now()}`;
  const campaign = {
    id,
    label: label || "حملة",
    createdBy: createdBy || "",
    createdAt: new Date().toISOString(),
    rows, // كل صف: {name, phone, message, status, error?}
  };
  saveCampaign(campaign);
  return id;
}

function getCampaign(id) {
  const file = filePathFor(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// بيحدّث حالة صف واحد وبيحفظ فورًا (مش في آخر الحملة) - عشان لو البوت اتوقف فجأة نص الإرسال،
// الصفوف اللي خلصت فعلًا (sent/failed) متسجّلة أول بأول ومش هتتبعت تاني لما الحملة تكمل بعدها
function updateRowStatus(id, rowIndex, status, error) {
  const campaign = getCampaign(id);
  if (!campaign || !campaign.rows[rowIndex]) return;
  campaign.rows[rowIndex].status = status;
  if (error) campaign.rows[rowIndex].error = error;
  else delete campaign.rows[rowIndex].error;
  saveCampaign(campaign);
}

function getSummary(id) {
  const campaign = getCampaign(id);
  if (!campaign) return null;
  const counts = {};
  campaign.rows.forEach((r) => {
    counts[r.status] = (counts[r.status] || 0) + 1;
  });
  return { id, label: campaign.label, total: campaign.rows.length, counts };
}

// بيرجع صفوف الحملة اللي حالتها من ضمن الحالات المطلوبة، كل صف معاه index بتاعه الأصلي
// في مصفوفة rows (مهم عشان updateRowStatus يحدّث الصف الصح بالظبط)
function getRowsByStatus(id, statuses) {
  const campaign = getCampaign(id);
  if (!campaign) return [];
  return campaign.rows
    .map((row, index) => ({ ...row, index }))
    .filter((row) => statuses.includes(row.status));
}

// بيصفّر حالة الصفوف الفاشلة (failed/not_on_whatsapp) لـ"pending" تاني عشان "اعادة محاولة"
// تقدر تعيد إرسالها من غير ما تلمس الصفوف اللي اتبعتت بنجاح أو المستبعدة أصلًا (مكرر/جوال غلط)
function resetFailedRows(id) {
  const campaign = getCampaign(id);
  if (!campaign) return 0;
  let count = 0;
  campaign.rows.forEach((r) => {
    if (r.status === "failed" || r.status === "not_on_whatsapp") {
      r.status = "pending";
      delete r.error;
      count++;
    }
  });
  if (count > 0) saveCampaign(campaign);
  return count;
}

// PAUSED_SAFE: علامة أمان مستقلة (مش status صف) بتمنع أي استئناف تلقائي أو يدوي للحملة كلها،
// حتى لو فيه صفوف "pending" باقية. بتتحط يدويًا بعد حادثة/إصلاح، وبتتشال بس بأمر واضح
// (clearPausedSafe) بعد مراجعة يدوية وموافقة صريحة - مش تلقائيًا خالص.
function setPausedSafe(id, reason) {
  const campaign = getCampaign(id);
  if (!campaign) return false;
  campaign.pausedSafe = true;
  campaign.pausedSafeReason = reason || "MANUAL_SAFETY_PAUSE";
  campaign.pausedSafeAt = new Date().toISOString();
  saveCampaign(campaign);
  return true;
}

function isPausedSafe(id) {
  const campaign = getCampaign(id);
  return !!(campaign && campaign.pausedSafe);
}

function clearPausedSafe(id) {
  const campaign = getCampaign(id);
  if (!campaign) return false;
  delete campaign.pausedSafe;
  delete campaign.pausedSafeReason;
  campaign.pausedSafeClearedAt = new Date().toISOString();
  saveCampaign(campaign);
  return true;
}

module.exports = {
  createCampaign,
  getCampaign,
  saveCampaign,
  updateRowStatus,
  getSummary,
  getRowsByStatus,
  resetFailedRows,
  setPausedSafe,
  isPausedSafe,
  clearPausedSafe,
};
