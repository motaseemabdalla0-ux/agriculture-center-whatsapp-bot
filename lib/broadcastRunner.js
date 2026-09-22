const fs = require("fs");
const path = require("path");
const sendLog = require("./sendLog");
const { safeFarmerSend } = require("./safeFarmerSend");

const ROOT = path.join(__dirname, "..");
const NUMBERS_FILE = path.join(ROOT, "numbers.txt");
const MESSAGE_FILE = path.join(ROOT, "message.txt");
const LOG_FILE = path.join(ROOT, "broadcast-log.txt");

// اتزوّدت من 4-9 لـ20-45 ثانية بعد ما واتساب قيّد حساب البوت فعليًا (اكتشاف نمط رسائل جماعية)
// أثناء حملة حقيقية - سلوك إرسال أبطأ وأقرب للطبيعي بيقلل احتمالية اكتشاف النمط الآلي
const MIN_DELAY_SEC = 20;
const MAX_DELAY_SEC = 45;

function loadNumbers() {
  const raw = fs.readFileSync(NUMBERS_FILE, "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/[^\d]/g, ""))
    .filter((l) => l.length >= 8);
}

function loadMessage() {
  const raw = fs.readFileSync(MESSAGE_FILE, "utf8").trim();
  if (!raw) {
    throw new Error("ملف message.txt فاضي - اكتب فيه نص الرسالة الأول.");
  }
  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  const sec = MIN_DELAY_SEC + Math.random() * (MAX_DELAY_SEC - MIN_DELAY_SEC);
  return Math.round(sec * 1000);
}

// يبعت البث باستخدام نفس عميل واتساب (client) اللي البوت الرئيسي شغال بيه
async function runBroadcast(client) {
  const numbers = loadNumbers();
  const message = loadMessage();

  if (numbers.length === 0) {
    console.log("⚠️ [بث] مفيش أرقام في numbers.txt.");
    return;
  }

  console.log(`\n📢 [بث] بدء الإرسال لـ ${numbers.length} رقم...\n`);

  const log = [];

  for (let i = 0; i < numbers.length; i++) {
    const number = numbers[i];
    process.stdout.write(`[بث] [${i + 1}/${numbers.length}] ${number} ... `);

    // كل الإرسال بيعدّي على safeFarmerSend وحدها - مفيش نداء مباشر لـclient.sendMessage() هنا
    const result = await safeFarmerSend(client, {
      phone: number,
      name: number,
      message,
      campaignType: "broadcast",
      messageSource: "CAMPAIGN",
    });

    switch (result.status) {
      case "not_on_whatsapp":
        console.log("❌ غير مسجل على واتساب");
        log.push(`${number} -> غير مسجل على واتساب`);
        sendLog.logSend("بث جماعي", number, number, "not_on_whatsapp");
        break;
      case "duplicate":
        console.log("⏭️ اتجاهل - نفس الرسالة اتبعتت لنفس الرقم قبل كده");
        log.push(`${number} -> اتجاهل (مكرر)`);
        sendLog.logSend("بث جماعي", number, number, "skipped_duplicate");
        break;
      case "rate_limited":
        console.log(`⏸️ وصلنا للحد الأقصى للإرسال (${result.reason})`);
        log.push(`${number} -> إيقاف مؤقت (${result.reason})`);
        break;
      case "would_send":
        console.log("🧪 DRY RUN - كان هيتبعت فعليًا");
        log.push(`${number} -> DRY RUN`);
        break;
      case "sent":
        console.log("✅ تم الإرسال");
        log.push(`${number} -> تم الإرسال`);
        sendLog.logSend("بث جماعي", number, number, "sent");
        break;
      default:
        console.log(`❌ فشل: ${result.reason || result.status}`);
        log.push(`${number} -> فشل: ${result.reason || result.status}`);
        sendLog.logSend("بث جماعي", number, number, "failed");
    }

    if (i < numbers.length - 1) {
      await sleep(randomDelayMs());
    }
  }

  fs.writeFileSync(
    LOG_FILE,
    `تقرير الإرسال - ${new Date().toLocaleString("ar-SA")}\n\n` +
      log.join("\n") +
      "\n",
    "utf8"
  );

  console.log(`\n✅ [بث] انتهى الإرسال. التقرير محفوظ في ${LOG_FILE}\n`);
}

module.exports = { runBroadcast };
