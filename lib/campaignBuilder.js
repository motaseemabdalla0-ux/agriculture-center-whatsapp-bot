const { normalizeSaudiPhone, isValidSaudiPhone } = require("./phoneUtil");
const farmerState = require("./farmerState");
const campaignRules = require("./campaignRules");
const sendFingerprint = require("./sendFingerprint");
const farmerRegistry = require("./farmerRegistry");
const { isArabicName } = require("./arabicNameGuard");
const contactHistoryGuard = require("./contactHistoryGuard");

// بياخد صفوف خام (name, phone, message) من الملف المرفوع ويرجّع صفوف حملة جاهزة، كل صف بحالته:
// "pending" (صالح للإرسال) | "invalid_phone" | "duplicate" (تكرار داخل نفس الملف) |
// "excluded_by_state" (حالة المزارع بتمنع الـPurpose ده) | "already_received" (نفس الرسالة
// بالظبط اتبعتت له قبل كده فعلًا - بصمة موجودة كـSENT) | "blocked_non_arabic_name".
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
    const usesNamePlaceholder = !!r.usesNamePlaceholder;

    // ترتيب التحقق: الاسم -> صلاحية الجوال -> الرسالة -> أمان الاسم العربي -> التكرار داخل
    // الملف -> حالة المزارع -> Stale Application -> "اتبعتله نفس الرسالة قبل كده". أي مشكلة
    // تظهر في الـPreview ولا يُرسل شيء.
    if (!name) {
      return { name: r.name, phone: r.phone, message, status: "missing_name", usesNamePlaceholder };
    }
    if (!isValidSaudiPhone(phone)) {
      return { name, phone: r.phone, message, status: "invalid_phone", usesNamePlaceholder };
    }
    if (!message) {
      return { name, phone, message, status: "missing_message", usesNamePlaceholder };
    }

    // قاعدة أمان الاسم العربي (إلزامية): بس لو الرسالة فعلًا بتستخدم اسم المزارع (usesNamePlaceholder
    // بيتحدد من الاستدعاء - قالب فيه {name} أصلًا). لو الرسالة مش بتستخدم اسم خالص، الفحص ده
    // مايتطبقش (رسالة من غير اسم متتمنعش بسبب لغة اسم في البيانات). ممنوع أي تعريب تلقائي -
    // إما اسم عربي موثوق فعليًا (من السجل أو من نفس البيانات لو عربي)، أو حظر
    if (usesNamePlaceholder && !isArabicName(name)) {
      const trusted = farmerRegistry.resolveTrustedArabicName(phone, name);
      if (!trusted) {
        return { name, phone, message, status: "blocked_non_arabic_name", reason: "BLOCKED_NON_ARABIC_NAME", usesNamePlaceholder };
      }
    }

    const dedupeKey = `${phone}|${sendFingerprint.normalizeMessageText(message)}`;
    if (seenPhoneMessage.has(dedupeKey)) {
      return { name, phone, message, status: "duplicate", usesNamePlaceholder };
    }

    const state = farmerState.getState(phone).state;
    const { blocked, reason } = campaignRules.isPurposeBlocked(purpose, state);
    if (blocked) {
      return { name, phone, message, status: "excluded_by_state", state, purpose, reason, usesNamePlaceholder };
    }

    // Farmer Registry + Communication History - نفس الفحص بالظبط اللي هيتعاد وقت الإرسال الفعلي
    // في safeFarmerSend.js (Preview هنا + إعادة فحص أخيرة قبل الإرسال، زي ما طُلب صراحةً - الوقت
    // بين رفع الملف والتنفيذ الفعلي ممكن ساعات/أيام وحالة المزارع ممكن تتغيّر في الأثناء)
    const historyCheck = contactHistoryGuard.checkContactHistoryBlock({ phone, purpose, state });
    if (historyCheck.blocked) {
      return { name, phone, message, status: historyCheck.status, state, purpose, reason: historyCheck.reason, usesNamePlaceholder };
    }

    // فحص Stale Application - بس لو الصف فعليًا معاه applicationId (عمود request_number/applicationId
    // في الملف المرفوع). لو مفيش، نفس السلوك القديم بالظبط (مفيش فحص، مفيش كسر لأي حملة حالية)
    if (applicationId) {
      const staleResult = farmerState.isApplicationStale(phone, applicationId);
      if (staleResult.stale) {
        return { name, phone, message, status: "stale_application", applicationId, reason: staleResult.reason, usesNamePlaceholder };
      }
    }

    // "اتبعتله نفس الرسالة دي بالظبط قبل كده فعلًا" - فحص بصمة على normalizedPhone+normalizedMessage
    // (مش بس تكرار نصي داخل الملف): نفس الشخص + نفس الرسالة = يتمنع هنا. نفس الشخص + رسالة
    // مختلفة يعدي من هنا عادي (ممكن يتمنع لاحقًا في safeFarmerSend بقواعد تانية لو انطبقت)
    const fingerprint = sendFingerprint.buildFingerprint(phone, message);
    const existing = sendFingerprint.getEntry(fingerprint);
    if (existing && existing.status === "SENT") {
      return { name, phone, message, status: "already_received", purpose, usesNamePlaceholder };
    }

    seenPhoneMessage.add(dedupeKey);
    // hasAnyPriorContact: معلوماتي بس (بند "سبق التواصل معهم" في الـPreview) - مش سبب استبعاد،
    // الصف لسه "pending" وهيتبعت عادي، بس بنوريه في المعاينة كتنبيه إضافي غير حاجز
    return {
      name,
      phone,
      message,
      status: "pending",
      purpose,
      applicationId,
      usesNamePlaceholder,
      hasAnyPriorContact: !!historyCheck.hasAnyPriorContact,
    };
  });

  return { rejected: false, rows };
}

// بيرجع تفصيل كامل للمعاينة - عدد كل حالة + تقسيم "excluded_by_state" لفئات فرعية مفهومة
// (طلب نشط / بطاقة صادرة / بطاقة مُستلمة) بدل رقم واحد مجمّع + إحصاء الأسماء العربية/غير
// العربية (بس للصفوف اللي فعلًا بتستخدم اسم المزارع في رسالتها)
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
    blocked_non_arabic_name: 0,
    blocked_previous_contact: 0,
    blocked_review_required: 0,
    any_previous_contact: 0,
    arabic_names: 0,
    non_arabic_names: 0,
  };
  const ACTIVE_APPLICATION_STATES = ["INVITED", "DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"];

  rows.forEach((r) => {
    if (r.status === "pending") {
      counts.valid++;
      // معلوماتي بس - "سبق التواصل معهم" - مش سبب استبعاد، الصف لسه هيتبعت عادي
      if (r.hasAnyPriorContact) counts.any_previous_contact++;
    } else if (r.status === "excluded_by_state") {
      if (r.state === "CARD_COLLECTED") counts.excluded_card_collected++;
      else if (r.state === "CARD_ISSUED") counts.excluded_card_issued++;
      else if (ACTIVE_APPLICATION_STATES.includes(r.state)) counts.excluded_active_application++;
    } else {
      counts[r.status] = (counts[r.status] || 0) + 1;
    }

    if (r.usesNamePlaceholder && r.name) {
      if (isArabicName(r.name)) counts.arabic_names++;
      else counts.non_arabic_names++;
    }
  });

  return counts;
}

module.exports = { buildCampaignRows, summarizeCampaignRows };
