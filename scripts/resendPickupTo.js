// إعادة إرسال إشعار الاستلام لأرقام محددة (حتى لو اتبعتلهم قبل كده). الاستخدام:
//   node scripts/resendPickupTo.js 966569472555 0544850011 0564642544=اسم المزارع
// الاسم بيتجاب تلقائيًا من Farmer Registry أو من سجل الإرسال القديم، أو بتكتبه صراحةً بعد "=".
// بيشيل قيود التكرار (sentTracker + البصمات) للأرقام دي بس ويجهّز card_pickup.csv - الإرسال الفعلي
// خطوة منفصلة (SEND_CARD_PICKUP.txt). لو الاسم مش معروف/مش عربي، الرقم بيتخطّى مع تنبيه.
const fs = require("fs");
const path = require("path");
const sentTracker = require("../lib/sentTracker");
const sendFingerprint = require("../lib/sendFingerprint");
const sendLog = require("../lib/sendLog");
const farmerRegistry = require("../lib/farmerRegistry");
const { isArabicName } = require("../lib/arabicNameGuard");
const { normalizeSaudiPhone, isValidSaudiPhone } = require("../lib/phoneUtil");

const CSV_PATH = path.join(__dirname, "..", "card_pickup.csv");
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("الاستخدام: node scripts/resendPickupTo.js <رقم> [<رقم>=<الاسم>] ...");
  process.exit(1);
}

const pastNames = new Map();
sendLog.getAllByLabel("استلام البطاقة").forEach((e) => e.name && pastNames.set(e.phone, e.name));

const rows = ["name,phone"];
args.forEach((arg) => {
  const [rawPhone, explicitName] = arg.split("=");
  const phone = normalizeSaudiPhone(rawPhone);
  if (!isValidSaudiPhone(phone)) {
    console.log(`⚠️ ${rawPhone}: رقم جوال سعودي غير صحيح - اتخطّى.`);
    return;
  }
  const name = (explicitName || (farmerRegistry.getEntry(phone) || {}).nameArabic || pastNames.get(phone) || "").trim();
  if (!isArabicName(name)) {
    console.log(`⚠️ ${phone}: مفيش اسم عربي معروف له (اكتبه صراحةً: ${rawPhone}=الاسم) - اتخطّى.`);
    return;
  }
  const unmarked = sentTracker.unmarkSent("card_pickup", phone);
  const fps = sendFingerprint.removeByPhone(phone, "card_pickup");
  console.log(`✅ ${phone} (${name}) - اتشال قيد التكرار (sentTracker: ${unmarked ? "نعم" : "مكنش مسجّل"}، بصمات: ${fps}).`);
  rows.push(`${name.replace(/,/g, " ")},${phone}`);
});

if (rows.length === 1) {
  console.log("❌ مفيش أي رقم صالح للإرسال.");
  process.exit(1);
}
fs.writeFileSync(CSV_PATH, rows.join("\n") + "\n", "utf8");
console.log(`\nجهّزنا card_pickup.csv بـ ${rows.length - 1} مزارع. شغّل الإرسال بـ:\nnode -e "require('fs').writeFileSync('SEND_CARD_PICKUP.txt','')"`);
