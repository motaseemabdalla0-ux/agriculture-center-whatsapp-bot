const campaignStore = require("./campaignStore");
const sendLog = require("./sendLog");
const { fillTemplate } = require("./personalizedRunner");
const { safeFarmerSend } = require("./safeFarmerSend");
const farmerRegistry = require("./farmerRegistry");
const { resolveContactMeta } = require("./contactReasonMap");

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
  const rows = campaignStore.getRowsByStatus(campaignId, ["pending"]);
  const summary = { total: rows.length, sent: 0, failed: 0, notOnWhatsapp: 0, wouldSend: 0, pausedReason: null };

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
        farmerRegistry.recordSuccessfulContact({
          phone: row.phone,
          messageSource: meta.messageSource,
          contactReason: meta.contactReason,
          nameArabic: row.usesNamePlaceholder ? row.name : null,
        });
        break;
      }
      default:
        console.log(`❌ فشل: ${result.reason || result.status}`);
        campaignStore.updateRowStatus(campaignId, row.index, "failed", result.reason || result.status);
        sendLog.logSend(`رسائل مخصصة (${campaignId})`, label, row.phone, "failed");
        summary.failed++;
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
  const remaining = campaignStore.getRowsByStatus(campaignId, ["pending"]).length;
  const failedCount = campaignStore.getRowsByStatus(campaignId, ["failed", "not_on_whatsapp"]).length;
  const lines = [
    `📬 نتيجة إرسال الحملة ${campaignId}:`,
    `✅ تم الإرسال: ${summary.sent}`,
    `❌ فشل: ${summary.failed}`,
    `📵 غير مسجل على واتساب: ${summary.notOnWhatsapp}`,
  ];
  if (remaining > 0) {
    lines.push(`\n⏳ لسه متبقي ${remaining} صف (البوت اتوقف أو حصل خطأ عام) - ابعت "تأكيد ارسال ${campaignId}" تاني عشان يكمل.`);
  } else if (failedCount > 0) {
    lines.push(`\nلإعادة محاولة الفاشل بس: اعادة محاولة ${campaignId}`);
  }
  return lines.join("\n");
}

module.exports = { sendCampaignRows, formatSummaryText };
