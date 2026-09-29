// إعادة إرسال إشعار جاهزية البطاقة الرسمي الجديد لكل مزارع اتبعتله إشعار استلام قبل كده
// (النص القديم من غير خيار توصيل، أو النص الأقدم قبل ميزة التوصيل من الأساس) - عشان يوصله
// النص الجديد ويقدر يختار "توصيل" بالتدفق الجديد (رقم منطقة + موقع إلزامي). المصدر: سجل
// sentTracker (كل رقم اتبعتله card_pickup على مر الوقت)، مش بس اللي لسه واقف في حالة انتظار
// (ده كان بيستثني تلقائيًا كل اللي استلموا النص القديم الأقدم من ميزة التوصيل أصلاً - ما كانش
// بيتسجّل لهم انتظار توصيل خالص وقتها).
//
// بيستثني تلقائيًا:
//   - مزارعين استلموا بطاقتهم فعليًا (CARD_COLLECTED في Farmer State) - مفيش داعي نزعجهم تاني.
//
// خطوات الاستخدام:
//   1) node scripts/resendPickupToPendingDelivery.js   -> بيجهّز card_pickup.csv بس، مفيش إرسال هنا خالص
//   2) راجع card_pickup.csv (تأكد من الأسماء/الأرقام)
//   3) شغّل الإرسال الفعلي زي أي حملة عادية: node -e "require('fs').writeFileSync('SEND_CARD_PICKUP.txt','')"
//
// بيشيل قيد "اتبعتله قبل كده" (sentTracker) لنوع card_pickup لكل الأرقام دي - مفيش أي لمس لأي
// رقم تاني، ومفيش أي إرسال فعلي بيحصل من السكريبت ده نفسه.
const fs = require("fs");
const path = require("path");
const sentTracker = require("../lib/sentTracker");
const farmerRegistry = require("../lib/farmerRegistry");
const farmerState = require("../lib/farmerState");
const { normalizeSaudiPhone } = require("../lib/phoneUtil");

const CSV_PATH = path.join(__dirname, "..", "card_pickup.csv");

function run() {
  const allEverSent = sentTracker.getSentList("card_pickup").map(normalizeSaudiPhone);
  const uniquePhones = [...new Set(allEverSent)];

  if (uniquePhones.length === 0) {
    console.log("ℹ️ مفيش أي رقم اتبعتله إشعار استلام قبل كده أصلًا - مفيش حاجة نعمله.");
    return;
  }

  const rows = ["name,phone"];
  let skippedCollected = 0;
  let unmarkedCount = 0;

  uniquePhones.forEach((phone) => {
    const state = farmerState.getState(phone).state;
    if (state === "CARD_COLLECTED") {
      skippedCollected++;
      return;
    }
    const entry = farmerRegistry.getEntry(phone);
    const name = (entry && entry.nameArabic) || "";
    const wasUnmarked = sentTracker.unmarkSent("card_pickup", phone);
    if (wasUnmarked) unmarkedCount++;
    rows.push(`${name.replace(/,/g, " ")},${phone}`);
  });

  fs.writeFileSync(CSV_PATH, rows.join("\n") + "\n", "utf8");

  const totalQueued = rows.length - 1;
  console.log(`✅ جهّزنا card_pickup.csv بـ ${totalQueued} مزارع (كل اللي سبق واستلموا إشعار الاستلام).`);
  if (skippedCollected > 0) console.log(`⏭️ اتخطّينا ${skippedCollected} مزارع استلموا بطاقتهم فعليًا (CARD_COLLECTED) - مفيش داعي نزعجهم.`);
  console.log(`🔓 اتشال قيد "اتبعتله قبل كده" لـ ${unmarkedCount} رقم منهم (عشان الإرسال الجديد ميترفضش كـduplicate).`);
  console.log(`\nراجع الملف: ${CSV_PATH}`);
  console.log(`ثم شغّل الإرسال الفعلي بـ:\nnode -e "require('fs').writeFileSync('SEND_CARD_PICKUP.txt','')"`);
}

run();
