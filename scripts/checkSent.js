// فحص من سطر الأوامر (من غير واتساب ولا صلاحيات أدمن): هل اتبعتلت رسالة (الدرافت أو استلام البطاقة)
// لأرقام معيّنة؟ ولو لأ، إيه السبب. قراءة بس - مفيش إرسال لأي حد.
// الاستخدام (من مجلد البوت على الجهاز):
//   node scripts/checkSent.js draft numbers.txt          (ملف فيه الأرقام، رقم في كل سطر)
//   node scripts/checkSent.js draft 0559414585 966540094369 ...
//   node scripts/checkSent.js pickup numbers.txt
const fs = require("fs");
const path = require("path");
const sendLog = require("../lib/sendLog");
const auditLog = require("../lib/auditLog");
const { extractPhones, checkPhones, formatCheck } = require("../lib/campaignCheck");

const [kind, ...rest] = process.argv.slice(2);
if (!["draft", "pickup"].includes(kind) || rest.length === 0) {
  console.log("الاستخدام: node scripts/checkSent.js <draft|pickup> <ملف أرقام | أرقام...>");
  process.exit(1);
}

const isDraft = kind === "draft";
const label = isDraft ? "تذكير درافت" : "استلام البطاقة";
const campaignType = isDraft ? "draft_reminder" : "card_pickup";

const input = rest.map((a) => (fs.existsSync(a) ? fs.readFileSync(a, "utf8") : a)).join("\n");
const phones = extractPhones(input);
if (phones.length === 0) {
  console.log("⚠️ ما لقيت أي رقم جوال سعودي صالح.");
  process.exit(1);
}

const inCurrentFile = new Set();
const csvPath = path.join(__dirname, "..", isDraft ? "draft_forms.csv" : "card_pickup.csv");
if (fs.existsSync(csvPath)) {
  fs.readFileSync(csvPath, "utf8").split(/\r?\n/).forEach((l) => {
    const m = l.match(/9665\d{8}/);
    if (m) inCurrentFile.add(m[0]);
  });
}

const results = checkPhones(phones, {
  sentRows: sendLog.getAllByLabel(label),
  auditEntries: auditLog.readAll(),
  campaignType,
  inCurrentFile,
});
console.log(formatCheck(label, results));
if (isDraft && results.some((r) => !r.sent)) {
  console.log("\nℹ️ رسائل الدرافت محدودة بـ10 مزارعين في اليوم، فالباقي بيتبعت في الأيام اللي بعد كده.");
}
