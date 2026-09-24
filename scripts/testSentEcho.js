// اختبار حماية صدى رسائل البوت (Echo) - صفر واتساب، صفر ملفات بيانات.
const assert = require("assert");
const echo = require("../lib/sentEcho");

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

const pickup = "عزيزي المزارع/ـة منصور،\n\nنفيدكم بجاهزية بطاقة المزرعة للاستلام من مركز الزراعة.\n\nنسعد بخدمتكم.";
const t0 = 1_000_000;

echo.clear();
check("1: قبل أي إرسال، مفيش صدى", echo.isEcho(pickup, t0) === false);
echo.remember(pickup, t0);
check("2: نفس نص رسالة الاستلام اللي بعتها البوت = صدى", echo.isEcho(pickup, t0 + 1000) === true);
check("3: نفس النص بمسافات/أسطر مختلفة = صدى برضه", echo.isEcho(pickup.replace(/\n\n/g, "\n").replace(/ /g, "  "), t0 + 1000) === true);
check("4: رد مزارع حقيقي مختلف مش صدى", echo.isEcho("أبغى أستلم بكرة", t0 + 1000) === false);
check("5: رد قصير زي 1 أو 2 عمره ما يتعتبر صدى", echo.isEcho("1", t0) === false && echo.isEcho("2", t0) === false);
echo.remember("1", t0);
check("6: حتى لو البوت بعت نص قصير، مانحفظوش (عشان ردود المزارع القصيرة)", echo.isEcho("1", t0) === false);
check("7: بعد انتهاء المهلة (5 دقايق) مابقاش صدى", echo.isEcho(pickup, t0 + echo.TTL_MS + 1) === false);
check("8: نص فاضي مش صدى", echo.isEcho("", t0) === false && echo.isEcho(undefined, t0) === false);

console.log(`\n🎉 كل اختبارات حماية الصدى نجحت (${passed} اختبار). صفر رسائل واتساب.`);
