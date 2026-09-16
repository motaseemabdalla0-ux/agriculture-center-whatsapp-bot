const fs = require("fs");
const path = require("path");
const CampaignSourceAdapter = require("./CampaignSourceAdapter");
const inboxEngine = require("../inboxEngine");

// Adapter محلي للاختبار - إما بتناديه مباشرة (submit) من الـLocal Upload Endpoint، أو بتستخدم
// scanIncomingFolder() لمعالجة أي ملف اتحط يدويًا في campaign-inbox/data/incoming/ (زي "حط ملف
// في مجلد" اللي طلبه المستخدم). الاتنين بينتهوا بنفس مكان واحد: inboxEngine.receiveCampaign
class LocalCampaignAdapter extends CampaignSourceAdapter {
  get name() {
    return "local";
  }

  async submit({ buffer, fileName, purpose, campaignType, message, uploadedBy }) {
    const meta = await inboxEngine.receiveCampaign({
      buffer,
      fileName,
      purpose,
      campaignType,
      message,
      uploadedBy,
      source: this.name,
    });
    return meta.campaignId;
  }

  // بديل لطريقة الرفع: حط ملف .xlsx/.csv في campaign-inbox/data/incoming/, ومعاه ملف
  // <نفس الاسم>.json فيه {purpose, campaignType, message, uploadedBy} - النظام هيلتقطه ويعامله
  // بالظبط زي لو وصل من رفع مباشر. مفيش إرسال تلقائي هنا برضه - نفس التدفق الكامل.
  incomingDir() {
    return path.join(__dirname, "..", "data", "incoming");
  }

  async scanIncomingFolder() {
    const dir = this.incomingDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).filter((f) => /\.(xlsx|csv)$/i.test(f));
    const processed = [];
    for (const fileName of files) {
      const filePath = path.join(dir, fileName);
      const metaPath = filePath.replace(/\.(xlsx|csv)$/i, ".json");
      let metaInput = {};
      if (fs.existsSync(metaPath)) {
        try {
          metaInput = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        } catch {
          // Metadata تالفة - هتترفض في inboxEngine بسبب MISSING_CAMPAIGN_PURPOSE أصلًا
        }
      }
      const buffer = fs.readFileSync(filePath);
      const campaignId = await this.submit({
        buffer,
        fileName,
        purpose: metaInput.purpose,
        campaignType: metaInput.campaignType,
        message: metaInput.message,
        uploadedBy: metaInput.uploadedBy || "local-folder",
      });
      processed.push({ fileName, campaignId });
      fs.unlinkSync(filePath);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    }
    return processed;
  }
}

module.exports = LocalCampaignAdapter;
