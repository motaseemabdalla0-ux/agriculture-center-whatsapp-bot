const farmerRegistry = require("./farmerRegistry");
const { resolveContactMeta } = require("./contactReasonMap");

// فحص إضافي - بس لحملات "رسائل مخصصة" الجديدة اللي معاها purpose صريح (custom campaigns).
// الحملات القديمة بـcampaignType (registration_status/card_pickup/...) ليها مسارها وحمايتها
// الخاصة أصلًا (sentTracker + campaignRules.isBlocked) ومبتلمسهاش الدالة دي خالص - عشان نحافظ
// تمامًا على سلوكهم القديم زي ما طُلب صراحةً.
//
// الترتيب المطلوب: Portal State -> Farmer State (بالفعل بيتفحص قبل هنا في safeFarmerSend) ->
// Farmer Registry -> Communication History -> ...  الدالة دي بتغطي جزء "Farmer Registry +
// Communication History" - بتتنادى من مكانين بالظبط: 1) campaignBuilder.js وقت الـPreview
// (قبل أي إرسال خالص) 2) safeFarmerSend.js مباشرة قبل أي إرسال حقيقي (إعادة فحص أخيرة، لأن
// الوقت بين الـPreview والتنفيذ الفعلي ممكن ساعات/أيام والحالة ممكن تتغيّر في الأثناء).
//
// حالتين حظر مختلفتين:
//   - blocked_previous_contact: سبق إرسال نفس الغرض (contactReason) فعليًا لنفس المزارع قبل
//     كده، بغض النظر عن نص الرسالة بالظبط (مش بس فحص البصمة الحرفية زي fingerprint.js).
//   - blocked_review_required: تعارض واضح بين Communication Status (Farmer Registry) وFarmer
//     State (البوابة) - زي إن السجل يقول "اتبعت إشعار جاهزية بطاقة" بس البوابة (المصدر الأساسي)
//     لسه بتقول "لسه درافت/UNKNOWN" - تعارض حقيقي محتاج مراجعة يدوية، مش قرار تلقائي.
//
// ملحوظة صريحة: مفيش أي منع لمجرد إن المزارع بعت رسالة للبوت، استخدم القائمة، استفسر عن خدمة،
// أو استلم رد آلي عام - الفحص هنا مقصور على contactReason المطابق تمامًا لنفس الـpurpose الحالي
// وعلى تعارض حالة موثّق فقط، مش على أي تفاعل عام سابق.
const CONFLICT_AHEAD_STATES = {
  // communicationStatus (Registry) : قائمة Farmer State (البوابة) اللي تعتبر تعارض لو موجودة
  CARD_READY_NOTIFIED: ["UNKNOWN", "INVITED", "DRAFT"],
  HANDED_OFF: ["UNKNOWN"],
};

// "سبق إرسال نفس الغرض" كسبب حظر مستقل مطلوب صراحةً لحملات REGISTRATION بس (نص الطلب: "بالنسبة
// لحملة REGISTRATION امنع الإرسال إذا... سبق إرسال دعوة تسجيل له... سبق إرسال نفس الغرض"). باقي
// الأغراض (GENERAL_NOTICE/SURVEY/EVALUATION/DOCUMENTS/CARD) طبيعتها تسمح بتكرار التواصل بمرور
// الوقت (إشعار عام جديد، استبيان تاني، تحديث حالة بطاقة...) - فمفيش حظر عام هنا غير REGISTRATION
const PURPOSES_BLOCK_ON_PREVIOUS_SAME_REASON = new Set(["REGISTRATION"]);

function checkContactHistoryBlock({ phone, purpose, state }) {
  if (!purpose) return { blocked: false };

  const { contactReason } = resolveContactMeta({ purpose });
  const entry = farmerRegistry.getEntry(phone);

  // 1) سبق إرسال نفس الغرض فعليًا (SENT حقيقي) - عبر كل تاريخ التواصل، مش بس نفس الحملة الحالية
  if (PURPOSES_BLOCK_ON_PREVIOUS_SAME_REASON.has(purpose)) {
    const alreadySentSameReason = (entry.communicationHistory || []).some(
      (h) => h.reason === contactReason && h.status === "SENT"
    );
    if (alreadySentSameReason) {
      return {
        blocked: true,
        status: "blocked_previous_contact",
        reason: `PREVIOUS_CONTACT_SAME_PURPOSE_${contactReason}`,
      };
    }
  }

  // 2) تعارض بين Communication Status المسجّل وFarmer State الحالي - البوابة (Farmer State)
  // لها الأولوية دايمًا، لكن التعارض نفسه لازم يظهر لمراجعة يدوية بدل ما نفترض مين صح تلقائيًا
  const aheadStates = CONFLICT_AHEAD_STATES[entry.communicationStatus];
  if (aheadStates && aheadStates.includes(state)) {
    return {
      blocked: true,
      status: "blocked_review_required",
      reason: `CONFLICTING_EVIDENCE_REGISTRY_${entry.communicationStatus}_VS_FARMER_STATE_${state}`,
    };
  }

  return {
    blocked: false,
    contactReason,
    hasAnyPriorContact: (entry.communicationHistory || []).length > 0,
  };
}

module.exports = { checkContactHistoryBlock };
