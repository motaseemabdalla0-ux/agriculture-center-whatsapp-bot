// Local Upload Endpoint - للاختبار المحلي بس دلوقتي. مربوط على 127.0.0.1 حصرًا (مش أي عنوان
// عام)، من غير أي مكتبة HTTP خارجية جديدة (http المدمجة في Node كافية للاستخدام ده).
// Real Send معطّل افتراضيًا (ALLOW_REAL_SEND!=="true") - حتى لو حد نادى /send، هيترفض بوضوح.
//
// لو النظام ده اتشغّل مستقل (زي الآن، عن طريق npm run campaign-inbox) بيستخدم عميل واتساب وهمي
// (Fake Client) - كافي تمامًا لـDRY RUN لأن DRY_RUN مابينداش sendMessage أو getNumberId أصلًا.
// لما يتقرر ربطه بالبوت الحقيقي، startLocalServer(realClient) بتاخد الـclient الحقيقي بدل كده -
// نقطة التكامل موجودة وجاهزة من غير أي تغيير في منطق الحملات نفسه.
const http = require("http");
const { URL } = require("url");
const inboxEngine = require("./inboxEngine");
const inboxStore = require("./inboxStore");
const LocalCampaignAdapter = require("./adapters/LocalCampaignAdapter");

const HOST = "127.0.0.1"; // مقصود - مش 0.0.0.0 - مفيش فتح Port للعالم أبدًا
const PORT = parseInt(process.env.CAMPAIGN_INBOX_PORT || "4010", 10);
const ALLOW_REAL_SEND = process.env.ALLOW_REAL_SEND === "true";

function fakeClient() {
  return {
    getNumberId: async (phone) => ({ _serialized: `${phone}@c.us` }),
    sendMessage: async () => {
      throw new Error("محاولة إرسال حقيقي في Local Test Mode - ده مش المفروض يحصل خالص");
    },
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleUpload(req, res, query) {
  const buffer = await readBody(req);
  const fileName = req.headers["x-file-name"] || query.get("fileName") || "upload.csv";
  const purpose = query.get("purpose") || undefined;
  const campaignType = query.get("type") || undefined;
  const message = query.get("message") || "";
  const uploadedBy = query.get("uploadedBy") || "local-upload-endpoint";

  const adapter = new LocalCampaignAdapter();
  const campaignId = await adapter.submit({ buffer, fileName, purpose, campaignType, message, uploadedBy });
  const meta = inboxStore.getMeta(campaignId);
  sendJson(res, 201, { campaignId, status: meta.status, rejectReason: meta.rejectReason || null });
}

async function handleRequest(req, res, client) {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const query = url.searchParams;
    const parts = url.pathname.split("/").filter(Boolean); // ["campaigns", ":id"?, "action"?]

    if (req.method === "POST" && parts[0] === "campaigns" && parts.length === 2 && parts[1] === "upload") {
      return await handleUpload(req, res, query);
    }

    if (parts[0] === "campaigns" && parts.length === 1 && req.method === "GET") {
      return sendJson(res, 200, { campaigns: inboxStore.listCampaigns() });
    }

    if (parts[0] === "campaigns" && parts.length >= 2) {
      const campaignId = parts[1];
      const meta = inboxStore.getMeta(campaignId);
      if (!meta) return sendJson(res, 404, { error: "CAMPAIGN_NOT_FOUND" });

      if (parts.length === 2 && req.method === "GET") {
        return sendJson(res, 200, meta);
      }
      if (parts[2] === "preview" && req.method === "GET") {
        return sendJson(res, 200, { campaignId, status: meta.status, preview: meta.preview });
      }
      if (parts[2] === "dry-run" && req.method === "GET") {
        const updated = await inboxEngine.runDryRun(campaignId, client);
        return sendJson(res, 200, { campaignId, status: updated.status, dryRun: updated.dryRun });
      }
      if (parts[2] === "approve" && req.method === "POST") {
        const bodyBuf = await readBody(req);
        let approvedBy = "";
        try {
          approvedBy = JSON.parse(bodyBuf.toString() || "{}").approvedBy || "";
        } catch {
          /* body اختياري */
        }
        const updated = inboxEngine.approveCampaign(campaignId, approvedBy);
        return sendJson(res, 200, { campaignId, status: updated.status });
      }
      if (parts[2] === "reject" && req.method === "POST") {
        const updated = inboxEngine.rejectCampaign(campaignId, "manual_via_endpoint");
        return sendJson(res, 200, { campaignId, status: updated.status });
      }
      if (parts[2] === "send" && req.method === "POST") {
        if (!ALLOW_REAL_SEND) {
          return sendJson(res, 403, {
            error: "REAL_SEND_DISABLED",
            message: "ALLOW_REAL_SEND=false (الافتراضي في وضع الاختبار المحلي) - الإرسال الحقيقي معطّل عمدًا.",
          });
        }
        const updated = await inboxEngine.sendApprovedCampaign(campaignId, client);
        return sendJson(res, 200, { campaignId, status: updated.status, summary: updated.lastSendSummary });
      }
    }

    sendJson(res, 404, { error: "NOT_FOUND" });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

function startLocalServer(realClient) {
  const client = realClient || fakeClient();
  const server = http.createServer((req, res) => handleRequest(req, res, client));
  server.listen(PORT, HOST, () => {
    console.log(`📬 [Campaign Inbox] الخادم المحلي شغّال على http://${HOST}:${PORT} (ALLOW_REAL_SEND=${ALLOW_REAL_SEND})`);
    if (!realClient) {
      console.log("ℹ️ شغّال بعميل واتساب وهمي (Local Test Mode) - مناسب لـPreview/DRY RUN بس.");
    }
  });
  return server;
}

if (require.main === module) {
  startLocalServer();
}

module.exports = { startLocalServer, HOST, PORT };
