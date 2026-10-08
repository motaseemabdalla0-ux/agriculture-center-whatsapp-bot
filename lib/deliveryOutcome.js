// نتيجة التوصيل من موظف التوصيل (جوّه مجموعة المنطقة أو للأدمن): "تم التوصيل D-5" أو
// "تعذر التوصيل D-5 <السبب>" (التسليم/الاستلام بنفس المعنى). دوال نقية للاختبار بدون واتساب
function normalizeText(text) {
  return String(text || "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[ً-ٟـ]/g, "")
    .trim();
}

// بيرجّع { kind: "FAILED"|"DELIVERED", id, reason } أو null لو النص مش أمر نتيجة توصيل
function parseOutcomeCommand(rawText) {
  const text = normalizeText(rawText);
  const delivered = text.match(/^تم\s*(?:ال)?توصيل\s+(D-\d+)\s*$/i);
  if (delivered) return { kind: "DELIVERED", id: delivered[1].toUpperCase(), reason: "" };
  const failed = text.match(/^تعذر\s*(?:ال)?(?:توصيل|تسليم|استلام)\s+(D-\d+)\s*([\s\S]*)$/i);
  if (failed) return { kind: "FAILED", id: failed[1].toUpperCase(), reason: failed[2].trim() };
  return null;
}

// رقم الطلب في المنصة (Form Number) لمزارع معيّن - البوت بيحفظه كـapplicationId في Farmer State لما
// المزامنة تقرا صفه من المنصة. بيرجّع null لو مش معروف
function platformNumberFor(phone) {
  try {
    const id = require("./farmerState").getState(phone).applicationId;
    return id ? String(id).trim() : null;
  } catch {
    return null;
  }
}

// رسالة المزارع بتعذّر الاستلام - بتاخد النص من config (DELIVERY_FAILED_NOTICE) والمتاح: {name} {id} {reason}.
// {id} = رقم الطلب في المنصة لو معروف (platformNumber)، وإلا رقم طلب التوصيل الداخلي (D-n)
function buildFailedNotice(template, request, reason, platformNumber) {
  const finalReason = reason || "تعذّر الوصول إليكم أو تسليم البطاقة في الموعد المحدد";
  return template
    .replace("{name}", request.name || "المستفيد")
    .replace("{id}", platformNumber || request.id)
    .replace("{reason}", finalReason);
}

// رد موظف التوصيل بجملة حرة على رسالة الطلب (Reply) بدون رقم الطلب في نصه ("تم التسليم"، "لم يتم
// الرد"...) - رقم الطلب بييجي من الرسالة المقتبسة. بيرجّع "DELIVERED" | "FAILED" | null، وnull
// معناها نسيب الطلب زي ما هو (مفيش كلمة واضحة، أو كلمات متعارضة، أو تغيير موعد)
const RESCHEDULE_WORDS = /تغيير\s*(ال)?موعد|تعديل\s*(ال)?موعد|تاجيل|تأجيل|موعد\s*جديد|(?<![ء-ي])اجل(ت|نا)?(?![ء-ي])|تم\s*تغيير/;
const FAILED_WORDS = /لم\s*يتم|ما\s*تم|تعذر|لا\s*يرد|لايرد|لم\s*يرد|ما\s*رد|لا\s*يجاوب|لم\s*يجب|رفض|مغلق|خارج\s*الخدمة|لم\s*(اتمكن|نتمكن|استطع|نستطع)/;
const DELIVERED_WORDS = /(?<![ء-ي])تم\s*(ال)?(تسليم|توصيل|استلام)|(?<![ء-ي])(سلمت|سلمنا|تسلم|استلم)/;

function classifyFreeText(rawText) {
  const text = normalizeText(rawText).replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
  if (!text) return null;
  const norm = (re) => new RegExp(re.source.replace(/ة/g, "ه").replace(/[أإآ]/g, "ا"), re.flags);
  if (norm(RESCHEDULE_WORDS).test(text)) return null;
  const failed = norm(FAILED_WORDS).test(text);
  const delivered = norm(DELIVERED_WORDS).test(text);
  if (failed && delivered) return null;
  if (failed) return "FAILED";
  if (delivered) return "DELIVERED";
  return null;
}

// رقم الطلب (D-n) من نص رسالة طلب توصيل مقتبسة
function extractRequestId(quotedBody) {
  const m = String(quotedBody || "").match(/\(?(D-\d+)\)?/i);
  return m ? m[1].toUpperCase() : null;
}

module.exports = { parseOutcomeCommand, buildFailedNotice, platformNumberFor, classifyFreeText, extractRequestId };
