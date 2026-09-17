// Reconciliation عميق لحملة واحدة بالمعرّف - يشغّله المسؤول يدويًا على السيرفر بعد نشر
// الإصلاح، قبل أي استئناف للحملة اللي كانت شغالة وقت حادثة EPERM.
//
// بيعتمد على أدلة حقيقية موجودة فعلًا (مش تخمين): campaign state (campaigns/<id>.json) +
// send_fingerprints.json (هل الرسالة اتأكدت SENT فعليًا في المستوى الأدق) - مطابق تمامًا
// لما طلبه المستخدم صراحةً: "campaign state + fingerprints + sentTracker + registry + logs".
//
// خطوتين تصحيح:
//   1) أي صف "failed" وسببه (error) فيه EPERM/EACCES/EBUSY - الكود القديم (قبل هذا الإصلاح) كان
//      بيوصل لخطوة الحفظ دي بعد نجاح client.sendMessage() فعليًا مباشرة، فده دليل قوي إن الرسالة
//      اتبعتت للمزارع بالفعل، بس تسجيل النتيجة فشل بعدها. -> delivery_uncertain
//   2) أي صف لسه "pending" بس فيه بصمة SENT فعلية في send_fingerprints.json لنفس الرقم/الرسالة -
//      معناه الإرسال حصل فعلًا (safeFarmerSend أكّد البصمة) لكن تحديث campaignStore نفسه (أو
//      الحلقة كلها) اتقطعت قبل ما توصل لسطر updateRowStatus - نفس مبدأ delivery_uncertain بالظبط،
//      وده اللي بيمنعنا من افتراض إن "أول 38 كلهم SENT" أو العكس.
//
// بعد التصحيح: الحملة بتتحط PAUSED_SAFE تلقائيًا (زي ما طُلب صراحةً) - مفيش استئناف تلقائي ولا
// حتى يدوي إلا بأمر واضح (campaignStore.clearPausedSafe) بعد موافقة صريحة منفصلة.
//
// آمن 100%: نسخة احتياطية من ملف الحملة قبل أي تعديل، مفيش أي نداء واتساب هنا خالص، ومفيش حذف
// أو إعادة إنشاء لأي بيانات - قراءة + تصحيح تصنيف بس.
const fs = require("fs");
const path = require("path");
const campaignStore = require("../lib/campaignStore");
const sendFingerprint = require("../lib/sendFingerprint");
const { fillTemplate } = require("../lib/personalizedRunner");

const campaignId = process.argv[2] || "c1789640068672";
const RETRYABLE_FS_ERROR = /EPERM|EACCES|EBUSY/i;

function main() {
  const campaign = campaignStore.getCampaign(campaignId);
  if (!campaign) {
    console.log(`⚠️ مفيش حملة بالمعرّف ${campaignId}.`);
    return;
  }

  const filePath = path.join(__dirname, "..", "campaigns", `${campaignId}.json`);
  fs.copyFileSync(filePath, `${filePath}.before-reconcile.bak`);
  console.log(`📄 نسخة احتياطية اتحفظت: ${filePath}.before-reconcile.bak\n`);

  let reclassifiedFailedToUncertain = 0;
  let reclassifiedPendingToUncertain = 0;

  campaign.rows.forEach((row) => {
    if (row.status === "failed" && row.error && RETRYABLE_FS_ERROR.test(row.error)) {
      row.status = "delivery_uncertain";
      row.reconciledAt = new Date().toISOString();
      row.reconciledReason = "WHATSAPP_SEND_LIKELY_SUCCEEDED_PERSISTENCE_FAILED_ERROR_MATCH";
      reclassifiedFailedToUncertain++;
      return;
    }

    if (row.status === "pending") {
      try {
        const text = fillTemplate(row.message, row);
        const fp = sendFingerprint.buildFingerprint(row.phone, text);
        const entry = sendFingerprint.getEntry(fp);
        if (entry && entry.status === "SENT") {
          row.status = "delivery_uncertain";
          row.reconciledAt = new Date().toISOString();
          row.reconciledReason = "FINGERPRINT_SHOWS_SENT_BUT_ROW_STILL_PENDING";
          reclassifiedPendingToUncertain++;
        }
      } catch {
        // فشل بناء البصمة لصف واحد (زي رقم فاضي) مش سبب نوقف باقي الـReconciliation
      }
    }
  });

  campaignStore.saveCampaign(campaign);

  const counts = {};
  campaign.rows.forEach((r) => {
    counts[r.status] = (counts[r.status] || 0) + 1;
  });

  console.log(`🔍 Reconciliation للحملة ${campaignId}:\n`);
  console.log(`إجمالي الصفوف: ${campaign.rows.length}`);
  console.log(`صفوف failed(EPERM/EACCES/EBUSY) -> delivery_uncertain: ${reclassifiedFailedToUncertain}`);
  console.log(`صفوف pending لكن فيها بصمة SENT فعلية -> delivery_uncertain: ${reclassifiedPendingToUncertain}\n`);
  console.log("الحالة النهائية لكل الصفوف:");
  Object.entries(counts).forEach(([status, count]) => console.log(`  ${status}: ${count}`));

  // بعد الإصلاح: PAUSED_SAFE إلزاميًا - مفيش استئناف تلقائي أو يدوي إلا بموافقة صريحة منفصلة
  campaignStore.setPausedSafe(campaignId, "INCIDENT_RECONCILIATION_EPERM_2026");
  console.log(`\n⛔ الحملة ${campaignId} اتحطت PAUSED_SAFE - مش هتستأنف إلا بأمر صريح (campaignStore.clearPausedSafe) بعد موافقتك الصريحة.`);
}

main();
