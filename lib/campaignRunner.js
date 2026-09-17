const campaignStore = require("./campaignStore");
const sendLog = require("./sendLog");
const { fillTemplate } = require("./personalizedRunner");
const { safeFarmerSend } = require("./safeFarmerSend");
const farmerRegistry = require("./farmerRegistry");
const { resolveContactMeta } = require("./contactReasonMap");
const { trySetContactName } = require("./whatsappContactName");

const MIN_DELAY_SEC = 4;
const MAX_DELAY_SEC = 9;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  const sec = MIN_DELAY_SEC + Math.random() * (MAX_DELAY_SEC - MIN_DELAY_SEC);
  return Math.round(sec * 1000);
}

// بيبعت كل صفوف حملة "رسائل مخصصة" اللي حالتها "pending" بس (اللي لسه ما اتبعتلهاش رسالة).
// بيحدّث حالة كل صف فور ما يخلص (مش كلهم في الآخر) عشان لو البوت اتقفل فجأة نص الحملة،
// نقدر نكمل بعد إعادة التشغيل من غير ما نبعت تاني للي خلص فعلًا. بيرجع ملخص {total, sent, failed, notOnWhatsapp}
async function sendCampaignRows(client, campaignId) {
  // حماية على مستوى الكود (مش بس اتفاق/تعليمات): لو الحملة اتحطت PAUSED_SAFE (بعد حادثة/إصلاح)،
  // ممنوع تمامًا أي استئناف تلقائي أو يدوي لحد ما حد يشيل العلامة دي صراحةً (clearPausedSafe)
  // بعد مراجعة يدوية وموافقة صريحة - "تأكيد ارسال" أو أي استدعاء تاني لازم يتوقف هنا فورًا
  if (campaignStore.isPausedSafe(campaignId)) {
    console.log(`⛔ الحملة ${campaignId} في وضع PAUSED_SAFE - ممنوع الاستئناف لحد ما تُشال العلامة دي صراحةً.`);
    return { total: 0, sent: 0, failed: 0, notOnWhatsapp: 0, wouldSend: 0, deliveryUncertain: 0, blockedPreviousContact: 0, blockedReviewRequired: 0, pausedReason: "paused_safe" };
  }

  const rows = campaignStore.getRowsByStatus(campaignId, ["pending"]);
  const summary = {
    total: rows.length,
    sent: 0,
    failed: 0,
    notOnWhatsapp: 0,
    wouldSend: 0,
    deliveryUncertain: 0,
    blockedPreviousContact: 0,
    blockedReviewRequired: 0,
    pausedReason: null,
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = row.name || row.phone;
    process.stdout.write(
      `[رسائل مخصصة ${campaignId}] [${i + 1}/${rows.length}] ${label} (${row.phone}) ... `
    );

    const text = fillTemplate(row.message, row);
    // كل الإرسال بيعدّي على safeFarmerSend وحدها - مفيش نداء مباشر لـclient.sendMessage() هنا.
    // messageSource: "CAMPAIGN" دايمًا هنا - أي حملة رفعها حد يدويًا (Excel/CSV) بتدخل تحت حصة
    // الـ500/يوم و50/ساعة، حتى لو الملف 3000 مزارع (توزيع الحصة عبر أيام بيحصل عن طريق campaign-inbox)
    const result = await safeFarmerSend(client, {
      phone: row.phone,
      name: label,
      message: text,
      purpose: row.purpose,
      applicationId: row.applicationId,
      messageSource: "CAMPAIGN",
    });

    // كل عمليات التسجيل بعد القرار (campaignStore/sendLog/farmerRegistry/اسم جهة الاتصال) اتلفّت
    // في try/catch واحد شامل - حادثة حقيقية أثبتت إن فشل واحد منهم (زي EPERM) لو ما اتلقطش كان
    // بيوقّف الحملة كلها بالكامل (كراش غير متوقع لـsendCampaignRows نفسها)، مش بس الصف الحالي.
    // Persistence مش لازم توقف تدفق الحملة أبدًا - أسوأ حالة: صف واحد يفضل "pending" ويتحاول
    // تاني لاحقًا (آمن، مش تكرار إرسال، لأن sentTracker/Fingerprint اتسجّلوا فعلًا جوّه safeFarmerSend)
    try {
      switch (result.status) {
        case "not_on_whatsapp":
          console.log("❌ غير مسجل على واتساب");
          campaignStore.updateRowStatus(campaignId, row.index, "not_on_whatsapp");
          sendLog.logSend(`رسائل مخصصة (${campaignId})`, label, row.phone, "not_on_whatsapp");
          summary.notOnWhatsapp++;
          break;
        case "blocked_by_state":
        case "blocked_stale_application":
          console.log(`🚫 ممنوع - ${result.status} (${result.state || ""})`);
          campaignStore.updateRowStatus(campaignId, row.index, result.status);
          sendLog.logSend(`رسائل مخصصة (${campaignId})`, label, row.phone, "skipped_duplicate");
          break;
        // سبق إرسال نفس الغرض له فعليًا قبل كده (Farmer Registry/Communication History) - مش
        // مجرد نفس نص الرسالة (ده fingerprint منفصل). قرار حظر واضح، بيتسجّل بحالته الخاصة
        case "blocked_previous_contact":
          console.log(`🚫 ممنوع - سبق التواصل معه لنفس الغرض (${result.reason})`);
          campaignStore.updateRowStatus(campaignId, row.index, "blocked_previous_contact", result.reason);
          sendLog.logSend(`رسائل مخصصة (${campaignId})`, label, row.phone, "skipped_duplicate");
          summary.blockedPreviousContact++;
          break;
        // تعارض بين البوابة (Farmer State) وسجل التواصل (Farmer Registry) - مش قرار تلقائي،
        // لازم مراجعة يدوية قبل أي إرسال أو استبعاد نهائي
        case "blocked_review_required":
          console.log(`🚫 يحتاج مراجعة يدوية - تعارض في الأدلة (${result.reason})`);
          campaignStore.updateRowStatus(campaignId, row.index, "blocked_review_required", result.reason);
          sendLog.logSend(`رسائل مخصصة (${campaignId})`, label, row.phone, "skipped_duplicate");
          summary.blockedReviewRequired++;
          break;
        case "duplicate":
          console.log("⏭️ اتجاهل - نفس الرسالة اتبعتت له قبل كده");
          campaignStore.updateRowStatus(campaignId, row.index, "duplicate");
          sendLog.logSend(`رسائل مخصصة (${campaignId})`, label, row.phone, "skipped_duplicate");
          break;
        case "rate_limited":
          console.log(`⏸️ وصلنا للحد الأقصى للإرسال (${result.reason}) - إيقاف مؤقت للحملة، استئناف تلقائي لاحقًا`);
          // بنسيب الصف "pending" عشان يتحاول تاني لاحقًا، وبنوقف الحلقة فورًا (مش نكمل باقي
          // الصفوف اللي هترجع rate_limited برضه أكيد - توفير وقت + وضوح سبب التوقف بالظبط)
          summary.pausedReason = result.reason; // "hourly_limit" | "daily_limit" | "cooldown" | "paused"
          return summary;
        case "would_send":
          console.log("🧪 DRY RUN - كان هيتبعت فعليًا");
          summary.wouldSend++;
          break;
        case "sent": {
          console.log("✅ تم الإرسال");
          campaignStore.updateRowStatus(campaignId, row.index, "sent");
          sendLog.logSend(`رسائل مخصصة (${campaignId})`, label, row.phone, "sent");
          summary.sent++;
          // تحديث سجل المزارع الدائم بس بعد نجاح إرسال فعلي (مش لأي حالة تانية) - Farmer Registry
          // منفصل تمامًا عن Farmer State Machine (مفيش تعديل عليها هنا خالص)
          const meta = resolveContactMeta({ purpose: row.purpose });
          const registryEntry = farmerRegistry.recordSuccessfulContact({
            phone: row.phone,
            messageSource: meta.messageSource,
            contactReason: meta.contactReason,
            nameArabic: row.usesNamePlaceholder ? row.name : null,
          });
          // Best-effort فقط - مش جزء من مسار الإرسال الآمن، فشلها لا يوقف أي حاجة
          await trySetContactName(client, row.phone, registryEntry.nameArabic);
          break;
        }
        // الإرسال الفعلي نجح بالتأكيد، لكن حفظ الحالة فشل (شوف safeFarmerSend.js) - ممنوع
        // نعتبره "فشل" عادي قابل لإعادة المحاولة التلقائية (ده بالظبط كان بيسبب تكرار إرسال
        // حقيقي). بنسجّله في حالة مستقلة تمامًا مش "pending" ومش "failed" - محتاج مراجعة يدوية
        case "delivery_uncertain":
          console.log(`⚠️ الإرسال نجح فعليًا لكن الحفظ فشل بعده (${result.reason}) - DELIVERY_UNCERTAIN`);
          campaignStore.updateRowStatus(campaignId, row.index, "delivery_uncertain", result.reason);
          sendLog.logSend(`رسائل مخصصة (${campaignId})`, label, row.phone, "delivery_uncertain");
          summary.deliveryUncertain++;
          break;
        default:
          console.log(`❌ فشل: ${result.reason || result.status}`);
          campaignStore.updateRowStatus(campaignId, row.index, "failed", result.reason || result.status);
          sendLog.logSend(`رسائل مخصصة (${campaignId})`, label, row.phone, "failed");
          summary.failed++;
      }
    } catch (persistErr) {
      console.log(`🚨 فشل تسجيل نتيجة الصف (${persistErr.message}) - الصف هيفضل بحالته المحجوزة ويتحاول تاني لاحقًا، الحملة مكملة عادي`);
    }

    // تأخير عشوائي بين كل رسالة وأخرى - بيتخطى بس وقت اختبارات الأتمتة (CAMPAIGN_TEST_FAST=true)
    // عشان اختبار حملة آلاف الصفوف ياخد ثواني بدل ساعات؛ متغيّر البيئة ده مش موجود في أي بيئة
    // إنتاج حقيقية، فمفيش أي تأثير على السلوك الفعلي وقت التشغيل الحقيقي
    if (i < rows.length - 1 && process.env.CAMPAIGN_TEST_FAST !== "true") {
      await sleep(randomDelayMs());
    }
  }

  return summary;
}

function formatSummaryText(campaignId, summary) {
  if (summary.pausedReason === "paused_safe") {
    return `⛔ الحملة ${campaignId} متوقفة PAUSED_SAFE (مراجعة أمان يدوية) - مش هتكمل تلقائيًا ولا بأمر "تأكيد ارسال" لحد موافقة صريحة.`;
  }
  const remaining = campaignStore.getRowsByStatus(campaignId, ["pending"]).length;
  const failedCount = campaignStore.getRowsByStatus(campaignId, ["failed", "not_on_whatsapp"]).length;
  const lines = [
    `📬 نتيجة إرسال الحملة ${campaignId}:`,
    `✅ تم الإرسال: ${summary.sent}`,
    `❌ فشل: ${summary.failed}`,
    `📵 غير مسجل على واتساب: ${summary.notOnWhatsapp}`,
  ];
  if (summary.deliveryUncertain > 0) {
    lines.push(`⚠️ حالة غير مؤكدة (اتبعتت لواتساب بس فشل حفظها - محتاجة مراجعة يدوية): ${summary.deliveryUncertain}`);
  }
  if (summary.blockedPreviousContact > 0) {
    lines.push(`🚫 سبق التواصل معهم لنفس الغرض: ${summary.blockedPreviousContact}`);
  }
  if (summary.blockedReviewRequired > 0) {
    lines.push(`🚫 يحتاج مراجعة يدوية (تعارض أدلة): ${summary.blockedReviewRequired}`);
  }
  if (remaining > 0) {
    lines.push(`\n⏳ لسه متبقي ${remaining} صف (البوت اتوقف أو حصل خطأ عام) - ابعت "تأكيد ارسال ${campaignId}" تاني عشان يكمل.`);
  } else if (failedCount > 0) {
    lines.push(`\nلإعادة محاولة الفاشل بس: اعادة محاولة ${campaignId}`);
  }
  return lines.join("\n");
}

module.exports = { sendCampaignRows, formatSummaryText };
