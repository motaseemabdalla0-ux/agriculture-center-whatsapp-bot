const fs = require("fs");
const path = require("path");

// سجل مركزي (Audit Log) لكل قرار إرسال - مش بس الرسائل الناجحة. ملف JSONL (سطر = JSON واحد)
// بدل مصفوفة JSON كاملة، عشان الإضافة (append) سريعة ومتزايدة من غير إعادة كتابة الملف كله
// في كل مرة (الملف ده متوقع يكبر بسرعة مع الوقت مع كل قرار إرسال/منع)
const LOG_FILE = path.join(__dirname, "..", "audit_log.jsonl");

// decision: "SENT" | "WOULD_SEND" | "FAILED" | "BLOCKED_BY_STATE" | "BLOCKED_STALE_APPLICATION" |
// "DUPLICATE" | "INVALID_PHONE" | "RATE_LIMITED" | "MANUAL_STATE_CHANGE"
function record({
  normalizedPhone,
  campaignType,
  campaignPurpose,
  farmerState,
  applicationId,
  messageFingerprint,
  decision,
  reason,
  messageSource,
  extra,
}) {
  const entry = {
    timestamp: new Date().toISOString(),
    normalizedPhone: normalizedPhone || null,
    campaignType: campaignType || null,
    campaignPurpose: campaignPurpose || null,
    farmerState: farmerState || null,
    applicationId: applicationId || null,
    messageFingerprint: messageFingerprint || null,
    decision,
    reason: reason || null,
    messageSource: messageSource || null, // "CAMPAIGN" | "SYSTEM_NOTIFICATION" - لعدّ رسائل كل نوع في لوحة العرض (Dashboard)
    ...(extra ? { extra } : {}),
  };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // فشل تسجيل الـaudit مش لازم يوقف عملية الإرسال نفسها - بس نلوج تحذير
    console.log(`⚠️ فشل الكتابة في audit_log.jsonl: ${err.message}`);
  }
}

// بيقرا آخر N سجل (مفيد للتقارير) - بيقرا الملف كامل، مقبول لحجم معقول، لو كبر جدًا محتاج
// تحسين لاحقًا (streaming) بس مش مطلوب دلوقتي
function readAll() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { record, readAll, LOG_FILE };
