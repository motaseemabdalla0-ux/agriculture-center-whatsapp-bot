// تجهيز قوائم Broadcast لـWhatsApp Business الرسمي - ملفات فقط، لا إرسال ولا اتصال بواتساب.
// الاستخدام:
//   node scripts/prepareOfficialBroadcast.js <ملف.xlsx> --pilot 3          (تجربة 3 مزارعين)
//   node scripts/prepareOfficialBroadcast.js <ملف.xlsx> --preview          (معاينة بس، من غير ملفات)
//   node scripts/prepareOfficialBroadcast.js <ملف.xlsx> [--source c123] [--out broadcast_prep]
const fs = require("fs");
const path = require("path");
const { prepareBroadcast, analyze } = require("../lib/officialBroadcastPrep");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--pilot" && args[args.indexOf(a) - 1] !== "--source" && args[args.indexOf(a) - 1] !== "--out");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (!file || !fs.existsSync(file)) {
  console.log("الاستخدام: node scripts/prepareOfficialBroadcast.js <ملف.xlsx> [--pilot 3] [--preview] [--source <campaignId>] [--out <مجلد>]");
  process.exit(1);
}

const buffer = fs.readFileSync(file);
const show = (p) =>
  console.log(
    `Total: ${p.total}\nValid: ${p.valid}\nInvalid phones: ${p.invalidPhones}\nDuplicates: ${p.duplicates}\nMissing names: ${p.missingNames}\nReady: ${p.ready}`
  );

if (args.includes("--preview")) {
  show(analyze(buffer).preview);
  process.exit(0);
}

const outDir = path.resolve(opt("--out") || path.join(__dirname, "..", "broadcast_prep"));
const result = prepareBroadcast(buffer, {
  outDir,
  sourceCampaignId: opt("--source") || null,
  pilot: parseInt(opt("--pilot") || "0", 10),
});
show(result.preview);
console.log(`\nالقوائم (${result.lists.length}):`);
result.lists.forEach((l) => console.log(`  ${l.broadcastId}: ${l.count} -> ${l.xlsxPath}`));
console.log(`\nManifest: ${result.manifestPath}\nلم يتم إرسال أي رسالة.`);
