// خريطة صريحة (مش استنتاج من نص الرسالة) بين نوع الحملة القديم (campaignType) أو الغرض
// الجديد (purpose) وبين messageSource/contactReason/communicationStatus الناتجة عن نجاح
// الإرسال. القيم كلها من القوائم الثابتة اللي حُددت صراحةً - مفيش تخمين لحالة أدق من اللي
// عندنا دليل حقيقي عليها.
//
// ملحوظة صريحة عن حد معروف: campaignType "registration_status" بيغطي أكتر من حالة بوابة
// فعلية (الطلب اتقبل/تحت المراجعة) من غير ما نقدر نميّز بينهم من البيانات المتاحة حاليًا (نفس
// القيد الموثّق سابقًا بخصوص التفريق بين SUBMITTED وUNDER_REVIEW) - فبنستخدم أعم سبب متاح
// (APPLICATION_UNDER_REVIEW) بدل تخمين حالة أدق مش عندنا دليل عليها.
const CAMPAIGN_TYPE_MAP = {
  registration_status: { messageSource: "SYSTEM_NOTIFICATION", contactReason: "APPLICATION_UNDER_REVIEW" },
  card_pickup: { messageSource: "SYSTEM_NOTIFICATION", contactReason: "CARD_READY" },
  documents_request: { messageSource: "SYSTEM_NOTIFICATION", contactReason: "DOCUMENTS_REQUIRED" },
  registration_invitation: { messageSource: "CAMPAIGN", contactReason: "REGISTRATION_INVITATION" },
  draft_reminder: { messageSource: "CAMPAIGN", contactReason: "DRAFT_REMINDER" },
  broadcast: { messageSource: "CAMPAIGN", contactReason: "GENERAL_NOTICE" },
  custom_message: { messageSource: "CAMPAIGN", contactReason: "CUSTOM_MESSAGE" },
};

// Purpose الجديد (صندوق الحملات) - نفس فكرة PURPOSES في campaignRules.js
const PURPOSE_MAP = {
  REGISTRATION: { messageSource: "CAMPAIGN", contactReason: "REGISTRATION_INVITATION" },
  DOCUMENTS: { messageSource: "CAMPAIGN", contactReason: "DOCUMENTS_REQUIRED" },
  CARD: { messageSource: "CAMPAIGN", contactReason: "CARD_READY" },
  GENERAL_NOTICE: { messageSource: "CAMPAIGN", contactReason: "GENERAL_NOTICE" },
  SURVEY: { messageSource: "CAMPAIGN", contactReason: "SURVEY" },
  EVALUATION: { messageSource: "CAMPAIGN", contactReason: "EVALUATION" },
};

// contactReason -> communicationStatus (بعد نجاح الإرسال بس). أي reason مالوش حالة تواصل
// مخصصة (زي SURVEY/EVALUATION/GENERAL_NOTICE/CUSTOM_MESSAGE) بيرجع الحالة العامة MESSAGE_SENT
const REASON_TO_STATUS = {
  CARD_READY: "CARD_READY_NOTIFIED",
  CARD_ISSUED: "CARD_READY_NOTIFIED",
  DOCUMENTS_REQUIRED: "DOCUMENTS_REQUESTED",
  REGISTRATION_INVITATION: "REGISTRATION_INVITATION_SENT",
  DRAFT_REMINDER: "DRAFT_REMINDER_SENT",
};

function resolveContactMeta({ campaignType, purpose }) {
  if (purpose && PURPOSE_MAP[purpose]) return PURPOSE_MAP[purpose];
  if (campaignType && CAMPAIGN_TYPE_MAP[campaignType]) return CAMPAIGN_TYPE_MAP[campaignType];
  return { messageSource: "CAMPAIGN", contactReason: "CUSTOM_MESSAGE" }; // احتياط عام - أي نوع مش معروف
}

function statusForReason(reason) {
  return REASON_TO_STATUS[reason] || "MESSAGE_SENT";
}

module.exports = { CAMPAIGN_TYPE_MAP, PURPOSE_MAP, REASON_TO_STATUS, resolveContactMeta, statusForReason };
