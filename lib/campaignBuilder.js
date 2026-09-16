const { normalizeSaudiPhone, isValidSaudiPhone } = require("./phoneUtil");
const farmerState = require("./farmerState");
const campaignRules = require("./campaignRules");
const sendFingerprint = require("./sendFingerprint");

// بياخد صفوف خام (name, phone, message) من الملف المرفوع ويرجّع صفوف حملة جاهزة، كل صف بحالته:
// "pending" (صالح للإرسال) | "invalid_phone" | "duplicate" (تكرار داخل نفس الملف) |
// "excluded_by_state" (حالة المزارع بتمنع الـPurpose ده) | "already_received" (نفس الرسالة
// بالظبط اتبعتت له قبل كده فعلًا - بصمة موجودة كـSENT).
//
// purpose إلزامي - واحدة من: REGISTRATION, DOCUMENTS, CARD, GENERAL_NOTICE, SURVEY, EVALUATION.
// لو مفقود أو مش من القيم دي، الحملة كلها بترفض من الأساس (مفيش تخمين Purpose من نص الرسالة
// أو من أي حاجة تانية) - بيرجع { rejected: true, reason: "MISSING_CAMPAIGN_PURPOSE" }
function buildCampaignRows(rawRows, purpose) {
  if (!purpose || !campaignRules.PURPOSES.includes(purpose)) {
    return { rejected: true, reason: "MISSING_CAMPAIGN_PURPOSE", rows: [] };
  }

  // التكرار داخل نفس الملف بيتحدد بـ"نفس الرقم + نفس الرسالة المطبّعة" (زي البصمة العامة بالظبط) -
  // مش "نفس الرقم" لوحده. نفس المزارع بيظهر مرتين في نفس الملف برسالتين مختلفتين مش تكرار،
  // وبيعدي هنا عادي (ممكن لسه يتمنع لاحقًا في safeFarmerSend بقواعد تانية لو انطبقت)
  const seenPhoneMessage = new Set();
  const rows = rawRows.map((r) => {
    const applicationId = r.applicationId || r.request_number || undefined;
    const name = (r.name || "").trim();
    const message = (r.message || "").trim();
    const phone = normalizeSaudiPhone(r.phone);

    // ترتيب التحقق: الاسم -> صلاحية الجوال -> الرسالة -> التكرار داخل الملف -> حالة المزارع ->
    // Stale Application -> "اتبعتله نفس الرسالة قبل كده". أي مشكلة تظهر في الـPreview ولا يُرسل شيء.
    if (!name) {
      return { name: r.name, phone: r.phone, message, status: "missing_name" };
    }
    if (!isValidSaudiPhone(phone)) {
      return { name, phone: r.phone, message, status: "invalid_phone" };
    }
    if (!message) {
      return { name, phone, message, status: "missing_message" };
    }
    const dedupeKey = `${phone}|${sendFingerprint.normalizeMessageText(message)}`;
    if (seenPhoneMessage.has(dedupeKey)) {
      return { name, phone, message, status: "duplicate" };
    }

    const state = farmerState.getState(phone).state;
    const { blocked, reason } = campaignRules.isPurposeBlocked(purpose, state);
    if (blocked) {
      return { name, phone, message, status: "excluded_by_state", state, purpose, reason };
    }

    // فحص Stale Application - بس لو الصف فعليًا معاه applicationId (عمود request_number/applicationId
    // في الملف المرفوع). لو مفيش، نفس السلوك القديم بالظبط (مفيش فحص، مفيش كسر لأي حملة حالية)
    if (applicationId) {
      const staleResult = farmerState.isApplicationStale(phone, applicationId);
      if (staleResult.stale) {
        return { name, phone, message, status: "stale_application", applicationId, reason: staleResult.reason };
      }
    }

    // "اتبعتله نفس الرسالة دي بالظبط قبل كده فعلًا" - فحص بصمة على normalizedPhone+normalizedMessage
    // (مش بس تكرار نصي داخل الملف): نفس الشخص + نفس الرسالة = يتمنع هنا. نفس الشخص + رسالة
    // مختلفة يعدي من هنا عادي (ممكن يتمنع لاحقًا في safeFarmerSend بقواعد تانية لو انطبقت)
    const fingerprint = sendFingerprint.buildFingerprint(phone, message);
    const existing = sendFingerprint.getEntry(fingerprint);
    if (existing && existing.status === "SENT") {
      return { name, phone, message, status: "already_received", purpose };
    }

    seenPhoneMessage.add(dedupeKey);
    return { name, phone, message, status: "pending", purpose, applicationId };
  });

  return { rejected: false, rows };
}

// بيرجع تفصيل كامل للمعاينة - عدد كل حالة + تقسيم "excluded_by_state" لفئات فرعية مفهومة
// (طلب نشط / بطاقة صادرة / بطاقة مُستلمة) بدل رقم واحد مجمّع
function summarizeCampaignRows(rows) {
  const counts = {
    total: rows.length,
    valid: 0,
    invalid_phone: 0,
    missing_name: 0,
    missing_message: 0,
    duplicate: 0,
    already_received: 0,
    excluded_active_application: 0,
    excluded_card_issued: 0,
    excluded_card_collected: 0,
    stale_application: 0,
  };
  const ACTIVE_APPLICATION_STATES = ["INVITED", "DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"];

  rows.forEach((r) => {
    if (r.status === "pending") {
      counts.valid++;
    } else if (r.status === "excluded_by_state") {
      if (r.state === "CARD_COLLECTED") counts.excluded_card_collected++;
      else if (r.state === "CARD_ISSUED") counts.excluded_card_issued++;
      else if (ACTIVE_APPLICATION_STATES.includes(r.state)) counts.excluded_active_application++;
    } else {
      counts[r.status] = (counts[r.status] || 0) + 1;
    }
  });

  return counts;
}

module.exports = { buildCampaignRows, summarizeCampaignRows };
