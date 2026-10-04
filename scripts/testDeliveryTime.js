// اختبارات فهم الوقت من نص المزارع الحر + أوقات التوصيل (8 صباحًا - 4 عصرًا). صفر واتساب ولا ملفات.
const assert = require("assert");
const { parseTimeOfDay, isOutsideDeliveryHours, parseDayOfWeek, checkDeliverySlot } = require("../lib/deliveryTime");

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

const inside = [
  "الأحد الساعة 10 صباحًا", "الساعة 8 صباحا", "9 ص", "10:30", "الساعة ١٠ صباحاً", "12 ظهرا",
  "الساعة 1 ظهرا", "الساعة 3 عصرا", "الساعة 4 عصرا", "3 م", "الاثنين الساعة 2", "الساعة 9",
  "يوم الاثنين الموافق 5/10/2026", "الأحد", "غدًا صباحًا", "بعد الظهر", "الخميس بعد العصر", "الساعة 16:00",
];
const outside = [
  "الساعة 5 مساء", "غدا 6 مساءً", "الساعة 7 صباحا", "7 ص", "الساعة 5", "الساعة 9 مساء",
  "بعد المغرب", "الليل", "الساعة 17:30", "الاثنين الساعة ٦ م", "الساعة 4:30 عصرا", "الساعة 11 ليلا",
  "يوم الاثنين الموافق 5/10/2026 الساعة 5 مساء",
];

console.log("\n=== أوقات داخل الدوام (8:00 - 16:00) أو من غير وقت واضح: مقبولة ===");
inside.forEach((t) => check(`مقبول: "${t}"`, isOutsideDeliveryHours(t) === false));

console.log("\n=== أوقات برّه الدوام: مرفوضة ===");
outside.forEach((t) => check(`مرفوض: "${t}"`, isOutsideDeliveryHours(t) === true));

console.log("\n=== تحليل الوقت ===");
check("10 صباحًا = 600 دقيقة", parseTimeOfDay("الساعة 10 صباحا").minutes === 600);
check("3 عصرًا = 15:00", parseTimeOfDay("3 عصرا").minutes === 15 * 60);
check("التاريخ لوحده مش وقت", parseTimeOfDay("5/10/2026") === null);

console.log("\n=== أيام الدوام: الأحد-الخميس. الجمعة والسبت مرفوضين ===");
const THURSDAY = new Date("2026-10-01T09:00:00Z"); // الخميس، فبكرة = الجمعة وبعد بكرة = السبت
check("الجمعة مرفوض", checkDeliverySlot("يوم الجمعة الساعة 10 صباحا", THURSDAY) === "DAY");
check("السبت مرفوض", checkDeliverySlot("السبت 9 ص", THURSDAY) === "DAY");
check("الأحد مقبول", checkDeliverySlot("الأحد الساعة 10 صباحا", THURSDAY) === null);
check("الخميس مقبول", checkDeliverySlot("الخميس الساعة 9", THURSDAY) === null);
check("بكرة (الجمعة) مرفوض", checkDeliverySlot("بكرة الساعة 10 صباحا", THURSDAY) === "DAY");
check("بعد بكرة (السبت) مرفوض", checkDeliverySlot("بعد بكرة", THURSDAY) === "DAY");
check("اليوم (الخميس) مقبول", checkDeliverySlot("اليوم الساعة 10 صباحا", THURSDAY) === null);
check("تاريخ 2/10/2026 (جمعة) مرفوض", checkDeliverySlot("2/10/2026", THURSDAY) === "DAY");
check("تاريخ 3/10/2026 (سبت) مرفوض", checkDeliverySlot("3/10/2026 الساعة 10 ص", THURSDAY) === "DAY");
check("تاريخ 5/10/2026 (اثنين) مقبول", checkDeliverySlot("يوم الاثنين الموافق 5/10/2026", THURSDAY) === null);
check("يوم مقبول بس وقت برّه الدوام -> TIME", checkDeliverySlot("الأحد الساعة 5 مساء", THURSDAY) === "TIME");
check("جمعة + وقت برّه -> DAY الأول", checkDeliverySlot("الجمعة 6 مساء", THURSDAY) === "DAY");
check("من غير يوم ولا وقت -> مقبول", checkDeliverySlot("أي وقت مناسب", THURSDAY) === null);
check("parseDayOfWeek الأحد = 0", parseDayOfWeek("الأحد القادم", THURSDAY) === 0);

console.log(`\n🎉 كل اختبارات أوقات التوصيل نجحت (${passed} اختبار).`);
