// قواعد الحظر - نظامين متجاورين:
// 1) قواعد قديمة بـcampaignType (registration_status, card_pickup...) - بتخدم الأنواع الثابتة
//    الموجودة أصلًا (personalizedRunner/broadcastRunner) - سلوكها متغيّرش خالص.
// 2) قواعد جديدة بـPurpose (REGISTRATION, DOCUMENTS, CARD, GENERAL_NOTICE, SURVEY, EVALUATION) -
//    بتخدم "الرسائل المخصصة" (custom campaigns) اللي لازم Purpose واضح إجباري وقت الإنشاء،
//    من غير أي تخمين من نص الرسالة أو افتراض تصنيف افتراضي.

const BLOCK_RULES = {
  registration_invitation: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "CARD_ISSUED", "CARD_COLLECTED"],
  registration_status: ["CARD_ISSUED", "CARD_COLLECTED"],
  draft_reminder: ["CARD_ISSUED", "CARD_COLLECTED"],
  documents_request: ["CARD_ISSUED", "CARD_COLLECTED"],
  card_pickup: ["CARD_COLLECTED"],
  survey: [],
  evaluation: [],
  broadcast: [],
};

function isBlocked(campaignType, state) {
  const rules = BLOCK_RULES[campaignType];
  if (!rules) {
    console.log(
      `⚠️ [قواعد الحملات] نوع حملة "${campaignType}" مالوش قاعدة صريحة في campaignRules.js - ` +
        `اتطبّق افتراضي (حظر بس عند CARD_COLLECTED). ضيف قاعدة واضحة له في BLOCK_RULES.`
    );
    return state === "CARD_COLLECTED";
  }
  return rules.includes(state);
}

// القيم المسموحة الوحيدة لـPurpose - أي حاجة تانية = مالهاش قاعدة = ممنوع (MISSING_CAMPAIGN_PURPOSE)
const PURPOSES = ["REGISTRATION", "DOCUMENTS", "CARD", "GENERAL_NOTICE", "SURVEY", "EVALUATION"];

const PURPOSE_BLOCK_RULES = {
  // دعوة/متابعة تسجيل - تتوقف لو المزارع بدأ إجراء بالفعل أو خلص تمامًا
  REGISTRATION: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "CARD_ISSUED", "CARD_COLLECTED"],
  // مستندات - مالهاش معنى لو الطلب خلص فعلًا
  DOCUMENTS: ["CARD_ISSUED", "CARD_COLLECTED"],
  // بطاقة (استلام/حالة البطاقة) - صالحة لحد ما تُستلم فعليًا
  CARD: ["CARD_COLLECTED"],
  // إشعار عام - مفيهوش أي حظر بحالة البطاقة خالص
  GENERAL_NOTICE: [],
  SURVEY: [],
  EVALUATION: [],
};

// بيرجع {blocked, reason} - reason بيكون "MISSING_CAMPAIGN_PURPOSE" لو الـpurpose مش موجود
// أو مش من القيم المعروفة أصلًا (مفيش تخمين أو افتراض هنا خالص)
function isPurposeBlocked(purpose, state) {
  if (!purpose || !PURPOSE_BLOCK_RULES[purpose]) {
    return { blocked: true, reason: "MISSING_CAMPAIGN_PURPOSE" };
  }
  const rules = PURPOSE_BLOCK_RULES[purpose];
  return { blocked: rules.includes(state), reason: rules.includes(state) ? `${purpose}_BLOCKED_AT_${state}` : null };
}

module.exports = { isBlocked, BLOCK_RULES, isPurposeBlocked, PURPOSE_BLOCK_RULES, PURPOSES };
