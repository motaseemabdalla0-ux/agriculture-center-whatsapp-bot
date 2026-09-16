// إرسال رسالة جماعية بشكل مستقل (بدون تشغيل البوت الرئيسي).
// استخدم ده فقط لو البوت الرئيسي (npm start) مش شغال في نفس اللحظة.
// لو البوت شغال بالفعل، استخدم بدلًا من ده: أنشئ ملف SEND_NOW.txt في مجلد المشروع
// (راجع README) وهو هيبعت البث من غير ما يوقف الرد التلقائي.

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { runBroadcast } = require("./lib/broadcastRunner");

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true },
});

client.on("qr", (qr) => {
  console.log("امسح رمز QR ده بواتساب (نفس الرقم اللي هيبعت منه):");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("✅ تم الاتصال بواتساب. بدء الإرسال...");
  await runBroadcast(client);
  process.exit(0);
});

client.initialize();
