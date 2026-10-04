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

module.exports = { parseOutcomeCommand, buildFailedNotice, platformNumberFor };
