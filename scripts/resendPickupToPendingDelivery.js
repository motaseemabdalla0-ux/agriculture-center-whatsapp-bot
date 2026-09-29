// إعادة إرسال إشعار جاهزية البطاقة لكل مزارع لسه واقف في حالة انتظار "استلام/توصيل" (أي خطوة:
// CHOICE/REGION/LOCATION/DATETIME) - يعني استلم الإشعار القديم وما حسمش قراره لسه. الاستخدام
// المباشر: بعد تحديث نص CARD_PICKUP_TEMPLATE الرسمي، نحب نوصّل النص الجديد لنفس المجموعة دي
// تحديدًا عشان يقدروا يختاروا "توصيل" بالتدفق الجديد (رقم منطقة + موقع إلزامي).
//
// خطوات الاستخدام:
//   1) node scripts/resendPickupToPendingDelivery.js   -> بيجهّز card_pickup.csv بس، مفيش إرسال هنا خالص
//   2) راجع card_pickup.csv (تأكد من الأسماء/الأرقام)
//   3) شغّل الإرسال الفعلي زي أي حملة عادية: node -e "require('fs').writeFileSync('SEND_CARD_PICKUP.txt','')"
//      (أو npm run send-card-pickup لو الصلاحيات تسمح)
//
// بيشيل قيد "اتبعتله قبل كده" (sentTracker) لنوع card_pickup لهؤلاء الأرقام بالتحديد بس - مفيش
// أي لمس لأي رقم تاني، ومفيش أي إرسال فعلي بيحصل من السكريبت ده نفسه.
const fs = require("fs");
const path = require("path");
const deliveryStore = require("../lib/deliveryStore");
const sentTracker = require("../lib/sentTracker");
const { normalizeSaudiPhone } = require("../lib/phoneUtil");

const CSV_PATH = path.join(__dirname, "..", "card_pickup.csv");

function run() {
  const pending = deliveryStore.getAllPending();
  if (pending.length === 0) {
    console.log("ℹ️ مفيش أي مزارع في حالة انتظار استلام/توصيل حاليًا - مفيش حاجة نعمله.");
    return;
  }

  const rows = ["name,phone"];
  let unmarkedCount = 0;
  pending.forEach(({ phone, name }) => {
    const normalized = normalizeSaudiPhone(phone);
    const wasUnmarked = sentTracker.unmarkSent("card_pickup", normalized);
    if (wasUnmarked) unmarkedCount++;
    rows.push(`${(name || "").replace(/,/g, " ")},${normalized}`);
  });

  fs.writeFileSync(CSV_PATH, rows.join("\n") + "\n", "utf8");

  console.log(`✅ جهّزنا card_pickup.csv بـ ${pending.length} مزارع (كل اللي لسه في انتظار استلام/توصيل).`);
  console.log(`🔓 اتشال قيد "اتبعتله قبل كده" لـ ${unmarkedCount} رقم منهم (عشان الإرسال الجديد ميترفضش كـduplicate).`);
  console.log(`\nراجع الملف: ${CSV_PATH}`);
  console.log(`ثم شغّل الإرسال الفعلي بـ:\nnode -e "require('fs').writeFileSync('SEND_CARD_PICKUP.txt','')"`);
}

run();
