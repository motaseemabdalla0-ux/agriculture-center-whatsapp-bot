// عقد (Interface) موحّد لأي "مصدر" ممكن يبعت ملف حملة للنظام - محلي، رفع ويب، مستقبلًا
// ChatGPT/Claude أو أي API. أي Adapter جديد لازم يطبّق نفس الشكل ده بالظبط، عشان
// campaign-inbox/inboxEngine.js يتعامل معاه من غير ما يعرف تفاصيل المصدر خالص.
//
// هذا الملف Contract بس (توثيق + رمي خطأ لو حد نسي يطبّق ميثود) - مفيش أي منطق فعلي هنا.
class CampaignSourceAdapter {
  // اسم قصير يميّز المصدر - بيتسجّل في campaign.uploadedBy/source
  get name() {
    throw new Error("CampaignSourceAdapter.name لازم يتحدد في الـAdapter");
  }

  // بيستقبل ملف حملة جديد ويبعته لـinboxEngine.receiveCampaign(...) عشان يتعامل معاه.
  // options: { buffer, fileName, purpose, campaignType, message, uploadedBy }
  // بيرجع الـcampaignId الناتج
  async submit(_options) {
    throw new Error("submit() لازم يتطبّق في الـAdapter");
  }
}

module.exports = CampaignSourceAdapter;
