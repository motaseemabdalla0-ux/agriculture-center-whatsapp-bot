// بيستقبل ملف Excel/CSV من سطر الأوامر، يحوّله لصيغة المشروع، ويطلب من البوت الشغال يبدأ الإرسال
// الاستخدام: node import_and_send.js registration|pickup|documents|invitation "C:\path\to\file.xlsx"

const fs = require("fs");
const path = require("path");
const { parseFarmerRows, farmerRowsToCsvText } = require("../lib/fileIngest");

const KIND_INFO = {
  registration: {
    needsRequestNumber: true,
    csvName: "registration_status.csv",
    triggerName: "SEND_REGISTRATION_STATUS.txt",
    label: "حالة التسجيل",
  },
  pickup: {
    needsRequestNumber: false,
    csvName: "card_pickup.csv",
    triggerName: "SEND_CARD_PICKUP.txt",
    label: "استلام البطاقة",
  },
  documents: {
    needsRequestNumber: false,
    csvName: "documents_request.csv",
    triggerName: "SEND_DOCUMENTS_REQUEST.txt",
    label: "طلب مستندات",
  },
  invitation: {
    needsRequestNumber: false,
    csvName: "registration_invitation.csv",
    triggerName: "SEND_REGISTRATION_INVITATION.txt",
    label: "دعوة للتسجيل",
  },
};

const kind = process.argv[2];
const sourceFile = process.argv[3];

if (!kind || !sourceFile) {
  console.log("الاستخدام: node import_and_send.js registration|pickup|documents|invitation <مسار الملف>");
  process.exit(1);
}

const info = KIND_INFO[kind];
if (!info) {
  console.log('❌ النوع لازم يكون "registration" أو "pickup" أو "documents" أو "invitation"');
  process.exit(1);
}

if (!fs.existsSync(sourceFile)) {
  console.log(`❌ الملف غير موجود: ${sourceFile}`);
  process.exit(1);
}

const projectRoot = path.join(__dirname, "..");
const buffer = fs.readFileSync(sourceFile);
const rows = parseFarmerRows(buffer, info.needsRequestNumber);

if (rows.length === 0) {
  console.log("❌ مفيش بيانات صحيحة في الملف (محتاج عمود فيه رقم جوال صحيح).");
  process.exit(1);
}

fs.writeFileSync(
  path.join(projectRoot, info.csvName),
  farmerRowsToCsvText(rows, info.needsRequestNumber),
  "utf8"
);
fs.writeFileSync(path.join(projectRoot, info.triggerName), "", "utf8");
console.log(`✅ تم استيراد بيانات ${rows.length} مزارع، وطُلب من البوت بدء إرسال رسائل "${info.label}".`);
console.log("تقدر تتابع التقدم بالأمر: pm2 logs agriculture-bot");
