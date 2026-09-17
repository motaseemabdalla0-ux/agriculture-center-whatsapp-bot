// حارس أمان الاسم العربي - قاعدة صارمة: ممنوع تحت أي ظرف إرسال رسالة فيها اسم مزارع بغير
// العربية أو مختلط (Arabic + Latin). ممنوع أي تعريب/تخمين تلقائي (Transliteration) - إما
// عندنا اسم عربي موثوق فعليًا، أو نمنع الإرسال.

// حروف عربية + مسافات + تطويل + تشكيل شائع + بعض علامات الأسماء المركّبة (- بين الكلمات
// المركّبة زي "عبد-الله" لو حصلت، وعلامة المد ـ). أي حرف لاتيني أو رقم غربي يفشّل الفحص فورًا
const ARABIC_NAME_RE = /^[؀-ٟٮ-ەۖ-ۭـ\s'\-]+$/;

function isArabicName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return false;
  return ARABIC_NAME_RE.test(trimmed);
}

// بيتأكد هل نص القالب (قبل استبدال {name}) بيستخدم اسم المزارع أصلًا - لو مش بيستخدمه،
// فحص الاسم العربي مايتطبقش خالص (زي ما طُلب: رسالة من غير اسم متتمنعش بسبب لغة اسم في البيانات)
function templateUsesName(template) {
  return typeof template === "string" && template.includes("{name}");
}

module.exports = { isArabicName, templateUsesName, ARABIC_NAME_RE };
