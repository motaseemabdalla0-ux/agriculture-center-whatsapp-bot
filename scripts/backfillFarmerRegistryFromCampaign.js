// سكريبت لمرة واحدة (Backfill) - يشغّله المسؤول يدويًا على السيرفر عشان يسجّل في Farmer
// Registry كل صفوف الحملة الحالية c1789640068672 (REGISTRATION - "حملة تسجيل") اللي اترفعت
// فعلًا، حتى الصفوف اللي لسه ما اتبعتلهاش رسالة (pending) - بند 3 من طلب الإصلاح.
//
// آمن 100%: قراءة فقط لملف الحملة، مفيش أي نداء واتساب هنا خالص، ومفيش أي إرسال. بيستخدم نفس
// دالة farmerRegistry.backfillFromCampaignRow اللي دلوقتي بقت بتتنادى تلقائيًا عند رفع أي حملة
// جديدة (index.js) - هذا السكريبت بس بيغطي الحملة اللي اترفعت *قبل* إضافة هذا الربط التلقائي.
const campaignStore = require("../lib/campaignStore");
const farmerRegistry = require("../lib/farmerRegistry");

const CAMPAIGN_ID = process.argv[2] || "c1789640068672";
const CAMPAIGN_PURPOSE = "REGISTRATION";
const CAMPAIGN_LABEL = "حملة تسجيل";

function main() {
  const campaign = campaignStore.getCampaign(CAMPAIGN_ID);
  if (!campaign) {
    console.log(`⚠️ مفيش حملة بالمعرّف ${CAMPAIGN_ID}.`);
    return;
  }

  console.log(`🔍 Backfill لحملة ${CAMPAIGN_ID} (${campaign.label || "-"}) - ${campaign.rows.length} صف...\n`);

  let backfilled = 0;
  let skippedNoPhone = 0;
  campaign.rows.forEach((row, idx) => {
    if (!row.phone) {
      skippedNoPhone++;
      return;
    }
    try {
      farmerRegistry.backfillFromCampaignRow({
        phone: row.phone,
        nameArabic: row.name,
        campaignId: CAMPAIGN_ID,
        campaignPurpose: CAMPAIGN_PURPOSE,
        campaignLabel: CAMPAIGN_LABEL,
      });
      backfilled++;
    } catch (err) {
      console.log(`  ⚠️ صف ${idx + 1} (${row.phone}): فشل Backfill (${err.message})`);
    }
  });

  console.log(`\n✅ تم Backfill لـ ${backfilled} صف (بدون أي إرسال).`);
  if (skippedNoPhone > 0) console.log(`ℹ️ اتجاهل ${skippedNoPhone} صف بدون رقم جوال.`);
  console.log(`📢 campaignLabel المحفوظ لكل صف: "${CAMPAIGN_LABEL}" | campaignPurpose: ${CAMPAIGN_PURPOSE}`);
}

main();
