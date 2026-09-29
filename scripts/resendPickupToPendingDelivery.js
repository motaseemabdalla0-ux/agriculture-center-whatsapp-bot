// إعادة إرسال إشعار جاهزية البطاقة الرسمي الجديد لكل مزارع اتبعتله إشعار استلام قبل كده
// (النص القديم من غير خيار توصيل، أو النص الأقدم قبل ميزة التوصيل من الأساس) - عشان يوصله
// النص الجديد ويقدر يختار "توصيل" بالتدفق الجديد (رقم منطقة + موقع إلزامي). المصدر: سجل
// sentTracker (كل رقم اتبعتله card_pickup على مر الوقت)، مش بس اللي لسه واقف في حالة انتظار
// (ده كان بيستثني تلقائيًا كل اللي استلموا النص القديم الأقدم من ميزة التوصيل أصلاً - ما كانش
// بيتسجّل لهم انتظار توصيل خالص وقتها).
//
// بيستثني تلقائيًا:
//   - مزارعين استلموا بطاقتهم فعليًا (CARD_COLLECTED في Farmer State) - مفيش داعي نزعجهم تاني.
//   - أي رقم سبق واتضاف لدفعة إعادة إرسال قبل كده من السكريبت ده نفسه (مسجّل في
//     card_pickup_resend_history.json) - عشان لو شغّلته أكتر من مرة (زي لو حد ضاف مزارعين جداد
//     للسجل بعدين)، الدفعة القديمة ما تتكررش، وبس الجداد يتضافوا.
//
// خطوات الاستخدام:
//   1) node scripts/resendPickupToPendingDelivery.js   -> بيجهّز card_pickup.csv بس، مفيش إرسال هنا خالص
//   2) راجع card_pickup.csv (تأكد من الأسماء/الأرقام)
//   3) شغّل الإرسال الفعلي زي أي حملة عادية: node -e "require('fs').writeFileSync('SEND_CARD_PICKUP.txt','')"
//
// بيشيل قيد "اتبعتله قبل كده" (sentTracker) لنوع card_pickup بس للأرقام الجديدة دي - مفيش أي
// لمس لأي رقم تاني، ومفيش أي إرسال فعلي بيحصل من السكريبت ده نفسه.
const fs = require("fs");
const path = require("path");
const sentTracker = require("../lib/sentTracker");
const farmerRegistry = require("../lib/farmerRegistry");
const farmerState = require("../lib/farmerState");
const { normalizeSaudiPhone } = require("../lib/phoneUtil");

const CSV_PATH = path.join(__dirname, "..", "card_pickup.csv");
const HISTORY_PATH = path.join(__dirname, "..", "card_pickup_resend_history.json");

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(phones) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(phones, null, 2), "utf8");
}

function run() {
  const allEverSent = sentTracker.getSentList("card_pickup").map(normalizeSaudiPhone);
  const uniquePhones = [...new Set(allEverSent)];
  const alreadyResent = new Set(loadHistory());

  if (uniquePhones.length === 0) {
    console.log("ℹ️ مفيش أي رقم اتبعتله إشعار استلام قبل كده أصلًا - مفيش حاجة نعمله.");
    return;
  }

  const rows = ["name,phone"];
  let skippedCollected = 0;
  let skippedAlreadyResent = 0;
  let unmarkedCount = 0;
  const newlyResent = [];

  uniquePhones.forEach((phone) => {
    if (alreadyResent.has(phone)) {
      skippedAlreadyResent++;
      return;
    }
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
    newlyResent.push(phone);
  });

  if (newlyResent.length === 0) {
    console.log("ℹ️ كل الأرقام اتغطّت في دفعة سابقة بالفعل (أو استلموا بطاقتهم) - مفيش حاجة جديدة نبعتها.");
    return;
  }

  fs.writeFileSync(CSV_PATH, rows.join("\n") + "\n", "utf8");
  saveHistory([...alreadyResent, ...newlyResent]);

  console.log(`✅ جهّزنا card_pickup.csv بـ ${newlyResent.length} مزارع جديد (سبق واستلموا إشعار الاستلام ولسه ما اتغطّوش في دفعة سابقة).`);
  if (skippedAlreadyResent > 0) console.log(`⏭️ اتخطّينا ${skippedAlreadyResent} رقم سبق اتغطّوا في دفعة إعادة إرسال قبل كده - مش هيتبعتلهم النص الجديد مرة تانية.`);
  if (skippedCollected > 0) console.log(`⏭️ اتخطّينا ${skippedCollected} مزارع استلموا بطاقتهم فعليًا (CARD_COLLECTED) - مفيش داعي نزعجهم.`);
  console.log(`🔓 اتشال قيد "اتبعتله قبل كده" لـ ${unmarkedCount} رقم منهم (عشان الإرسال الجديد ميترفضش كـduplicate).`);
  console.log(`\nراجع الملف: ${CSV_PATH}`);
  console.log(`ثم شغّل الإرسال الفعلي بـ:\nnode -e "require('fs').writeFileSync('SEND_CARD_PICKUP.txt','')"`);
}

run();
