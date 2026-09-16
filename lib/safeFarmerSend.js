const { normalizeSaudiPhone, isValidSaudiPhone } = require("./phoneUtil");
const farmerState = require("./farmerState");
const campaignRules = require("./campaignRules");
const sendFingerprint = require("./sendFingerprint");
const sentTracker = require("./sentTracker");
const rateLimiter = require("./rateLimiter");
const auditLog = require("./auditLog");

const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 3000]; // بين المحاولة 1-2، وبين 2-3

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDryRun() {
  return process.env.DRY_RUN === "true";
}

// أنواع الحملات القديمة (campaignType) اللي اتصمّمت أصلًا تتبعت "مرة واحدة بس لكل طلب"، مش "مرة
// واحدة للأبد لكل مزارع" - لو فيه applicationId مرفق، بنستخدمه كجزء من مفتاح sentTracker عشان
// طلب جديد لنفس المزارع ميتمنعش غلط بسبب إرسال قديم لطلب سابق مختلف. لو مفيش applicationId
// مرفق (الحالة القديمة)، بيرجع لنفس سلوك "تليفون بس" الأصلي كحل احتياطي آمن (مفيش كسر لأي سلوك شغال)
const SENT_TRACKER_SCOPED_BY_APPLICATION = new Set(["documents_request", "registration_status"]);

function sentTrackerKey(normalizedPhone, campaignType, applicationId) {
  if (SENT_TRACKER_SCOPED_BY_APPLICATION.has(campaignType) && applicationId) {
    return `${normalizedPhone}#${applicationId}`;
  }
  return normalizedPhone;
}

// إرسال بمحاولات متكررة مع Backoff - لو الاتنين الأولانيين فشلوا وتالته نجحت، بيرجع نجاح
// عادي. لو الثلاثة فشلوا، بيرمي آخر خطأ حصل
async function sendWithRetry(client, numberId, message) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      await client.sendMessage(numberId, message);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS[attempt - 1] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
      }
    }
  }
  throw lastErr;
}

// نقطة العبور الوحيدة لأي رسالة واتساب لمزارع. كل الـRunners لازم تنادي هنا بدل ما تنادي
// client.sendMessage() مباشرة.
//
// options:
//   phone, name, message
//   campaignType: نوع قديم ثابت (registration_status, card_pickup...) - نظام القواعد القديم
//   purpose: نوع Purpose جديد (REGISTRATION/DOCUMENTS/CARD/GENERAL_NOTICE/SURVEY/EVALUATION) -
//            لو موجود، بيتفحص بقواعد Purpose بدل/بالإضافة لـcampaignType
//   applicationId: رقم الطلب المرتبط بالإشعار ده (لو موجود) - بيتفحص ضد Stale Application
//   skipStateCheck: تخطي فحص الحالة تمامًا (نادرًا، مش مستخدم حاليًا في أي Runner)
//   messageSource: تصنيف صريح إلزامي منطقيًا - "CAMPAIGN" | "SYSTEM_NOTIFICATION" (افتراضي لو
//     اتنسي: "CAMPAIGN" - الأكثر تحفّظًا لأنه بيدخل تحت حدود Rate Limiter بدل ما يتخطاها بالغلط).
//     Rate Limiter (500/يوم و50/ساعة) بيتطبّق بس على CAMPAIGN - أي إشعار نظام تلقائي
//     (SYSTEM_NOTIFICATION، زي تغيّر حالة طلب أو جاهزية بطاقة) بيتخطى خطوة الـRate Limit بالكامل،
//     لكن بيفضل يعدي على كل فحوصات الأمان التانية (الحالة/Stale/Dedup/Fingerprint) زي أي رسالة
//     تانية بالظبط - مفيش أي تخفيف حماية، بس استثناء من حصة الحملات فقط.
//     INBOUND_REPLY مش بتعدي من هنا خالص أصلًا (بتستخدم msg.reply() في index.js مباشرة، مسار
//     منفصل تمامًا عن أي إرسال حملات/إشعارات لمزارع - مفيش داعي تتصنّف هنا).
//
// الترتيب النهائي: تطبيع -> فحص Purpose/الحالة (state، وFail-Closed لو Farmer State معطوب) ->
// فحص الطلب القديم (stale application) -> فحص sentTracker/History -> حجز بصمة (dedup) ->
// DRY_RUN check -> Rate Limit (بس CAMPAIGN وبس للي هيتبعت فعلًا) -> إرسال حقيقي -> تأكيد/تحرير.
// DRY_RUN بيتفحص *قبل* Rate Limiter عمدًا عشان تجربة DRY RUN متستهلكش من الحصة خالص، والبصمة
// والحالة بيتفحصوا *قبل* الاتنين عشان الرسائل الممنوعة أو المكررة متستهلكش من حصة الإرسال.
//
// بيرجع: { status, reason?, state? } حيث status واحدة من:
// "sent" | "would_send" | "invalid_phone" | "blocked_by_state" | "blocked_stale_application" |
// "duplicate" | "rate_limited" | "not_on_whatsapp" | "failed"
async function safeFarmerSend(client, options) {
  const { phone, message, campaignType, purpose, applicationId, skipStateCheck = false, messageSource = "CAMPAIGN" } = options;
  const normalizedPhone = normalizeSaudiPhone(phone);

  const auditBase = {
    normalizedPhone,
    campaignType: campaignType || null,
    campaignPurpose: purpose || null,
    applicationId: applicationId || null,
    messageSource,
  };

  if (!isValidSaudiPhone(normalizedPhone)) {
    auditLog.record({ ...auditBase, decision: "INVALID_PHONE" });
    return { status: "invalid_phone" };
  }

  // 1) فحص حالة المزارع (Farmer State Machine) - بحسب Purpose (لو موجود) أو campaignType القديم.
  // Fail-Closed: لو farmer_state.json (والنسخة الاحتياطية) تالفين، farmerState.getState بترمي
  // استثناء FARMER_STATE_UNAVAILABLE - هنا بنلقطه ونمنع الإرسال فورًا (status: blocked_by_state)
  // بدل ما نسيب الاستثناء يهرب لفوق أو (الأخطر) نتعامل معاه كإنه "UNKNOWN" ونسمح بإرسال غلط
  let state = null;
  if (!skipStateCheck) {
    try {
      state = farmerState.getState(normalizedPhone).state;
    } catch (err) {
      auditLog.record({ ...auditBase, decision: "BLOCKED_BY_STATE", reason: "FARMER_STATE_UNAVAILABLE" });
      return { status: "blocked_by_state", reason: "FARMER_STATE_UNAVAILABLE" };
    }
    if (purpose) {
      const { blocked, reason } = campaignRules.isPurposeBlocked(purpose, state);
      if (blocked) {
        auditLog.record({ ...auditBase, farmerState: state, decision: "BLOCKED_BY_STATE", reason });
        return { status: "blocked_by_state", state, reason };
      }
    } else if (campaignType && campaignRules.isBlocked(campaignType, state)) {
      const reason = `${campaignType} ممنوعة عند حالة ${state}`;
      auditLog.record({ ...auditBase, farmerState: state, decision: "BLOCKED_BY_STATE", reason });
      return { status: "blocked_by_state", state, reason };
    }
  }

  // 2) فحص Stale Application: الإشعار ده بيخص طلب معيّن (applicationId) - لو ظهر طلب أحدث
  // بعده لنفس المزارع، الإشعار القديم ده بقى Stale ومينفعش يتبعت حتى لو الحالة نظريًا بتسمح.
  // isApplicationStale برجع أيضًا كمان تحت Fail-Closed (بتستخدم farmerState.getState داخليًا)
  if (applicationId) {
    let staleResult;
    try {
      staleResult = farmerState.isApplicationStale(normalizedPhone, applicationId);
    } catch (err) {
      auditLog.record({ ...auditBase, decision: "BLOCKED_BY_STATE", reason: "FARMER_STATE_UNAVAILABLE" });
      return { status: "blocked_by_state", reason: "FARMER_STATE_UNAVAILABLE" };
    }
    if (staleResult.stale) {
      auditLog.record({ ...auditBase, farmerState: state, decision: "BLOCKED_STALE_APPLICATION", reason: staleResult.reason });
      return { status: "blocked_stale_application", state, reason: staleResult.reason };
    }
  }

  // 3) فحص sentTracker القديم (لو النوع محدّد) - "اتبعتله نفس نوع الحملة ده قبل كده". لبعض
  // الأنواع (documents_request/registration_status) المفتاح بيتحدد على applicationId كمان لو
  // متوفر، عشان طلب جديد لنفس المزارع ميتمنعش غلط بسبب إرسال قديم لطلب سابق مختلف (راجع
  // sentTrackerKey فوق للتفاصيل والقواعد النهائية)
  if (campaignType) {
    const trackerKey = sentTrackerKey(normalizedPhone, campaignType, applicationId);
    if (sentTracker.hasBeenSent(campaignType, trackerKey)) {
      auditLog.record({ ...auditBase, farmerState: state, decision: "DUPLICATE", reason: "sent_tracker" });
      return { status: "duplicate", reason: "sent_tracker" };
    }
  }

  // 4) حجز بصمة عامة (Global Anti-Duplicate) - "نفس الرقم + نفس نص الرسالة المطبّع" بالضبط
  const fingerprint = sendFingerprint.buildFingerprint(normalizedPhone, message);
  const reservation = sendFingerprint.reserve(fingerprint, { phone: normalizedPhone, campaignType: campaignType || null, purpose: purpose || null });
  if (!reservation.ok) {
    auditLog.record({ ...auditBase, farmerState: state, messageFingerprint: fingerprint, decision: "DUPLICATE", reason: reservation.reason });
    return { status: "duplicate", reason: reservation.reason };
  }

  // 5) DRY RUN: كل فحوصات الأمان فوق (الحالة/Stale/History/البصمة) حصلت فعليًا، بس قبل استهلاك
  // أي Rate Limit quota وقبل أي نداء client.sendMessage خالص، ومينفعش نسجّل الرسالة كـSENT -
  // بنحرّر حجز البصمة فورًا عشان الـDry Run متأثرش على أي إرسال حقيقي بعده لنفس الرسالة
  if (isDryRun()) {
    sendFingerprint.release(fingerprint);
    auditLog.record({ ...auditBase, farmerState: state, messageFingerprint: fingerprint, decision: "WOULD_SEND" });
    return { status: "would_send", state };
  }

  // 6) Rate Limiting - بس لرسائل CAMPAIGN، وبعد كل فحوصات الحظر/التكرار/DRY_RUN عمدًا، عشان
  // الرسائل الممنوعة أو المكررة أو تجارب DRY RUN متستهلكش من الحصة الساعية/اليومية.
  // SYSTEM_NOTIFICATION (إشعارات النظام التلقائية) بتتخطى الخطوة دي بالكامل - مش بتستهلك ولا
  // بتتأثر بحصة الـ500/يوم و50/ساعة الخاصة بالحملات، وبالتالي مبتوقفش أبدًا بسبب Campaign Queue
  if (messageSource === "CAMPAIGN") {
    const rl = rateLimiter.checkAndReserve();
    if (!rl.allowed) {
      sendFingerprint.release(fingerprint); // بنحرّر الحجز عشان محاولة لاحقة تقدر تحصل
      auditLog.record({ ...auditBase, farmerState: state, messageFingerprint: fingerprint, decision: "RATE_LIMITED", reason: rl.reason });
      return { status: "rate_limited", reason: rl.reason };
    }
  }

  // 7) الإرسال الفعلي (بمحاولات متكررة مع backoff)
  try {
    const numberId = await client.getNumberId(normalizedPhone);
    if (!numberId) {
      sendFingerprint.release(fingerprint);
      auditLog.record({ ...auditBase, farmerState: state, messageFingerprint: fingerprint, decision: "FAILED", reason: "not_on_whatsapp" });
      return { status: "not_on_whatsapp" };
    }

    await sendWithRetry(client, numberId._serialized, message);

    // التأكيد بعد النجاح الفعلي بس
    sendFingerprint.confirmSent(fingerprint);
    if (campaignType) sentTracker.markSent(campaignType, sentTrackerKey(normalizedPhone, campaignType, applicationId));
    auditLog.record({ ...auditBase, farmerState: state, messageFingerprint: fingerprint, decision: "SENT" });

    return { status: "sent", state };
  } catch (err) {
    sendFingerprint.release(fingerprint);
    auditLog.record({ ...auditBase, farmerState: state, messageFingerprint: fingerprint, decision: "FAILED", reason: err.message });
    return { status: "failed", reason: err.message };
  }
}

module.exports = { safeFarmerSend, isDryRun };
