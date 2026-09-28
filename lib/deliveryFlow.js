const store = require("./deliveryStore");
const { classifyPoint } = require("./deliveryRegionsGeo");

// منطق حوار "استلام أم توصيل" - دوال نقية (من غير أي WhatsApp client مباشر) عشان تتختبر بسهولة.
// getText: دالة بترجّع نص رد حسب المفتاح (config.js + تعديلات الإدارة) - مفيش أي نص متكتب هنا.
//
// خطوات حالة الانتظار: CHOICE (1 استلام / 2 توصيل) -> REGION (المزارع يبعت موقعه، وبيتحدد
// المنطقة تلقائيًا من حدود العلا الرسمية؛ اختيار رقم يدوي 1/2/3 موجود كـfallback نادر بس لو
// الموقع فشل) -> DATETIME (اليوم والوقت المفضّل - نص حر) -> إنشاء الطلب فعليًا وتوجيهه للمجموعة

const MIN_DATETIME_LENGTH = 3;

// بيرجّع { handled, reply?, request? }. handled=false يعني المزارع مالوش حالة انتظار وكمّل عادي.
function handleReply(phone, text, getText) {
  const pending = store.getPending(phone);
  if (!pending) return { handled: false };

  if (pending.step === "CHOICE") {
    if (text === "1") {
      store.clearPending(phone);
      return { handled: true, reply: getText("DELIVERY_PICKUP_CONFIRM") };
    }
    if (text === "2") {
      store.setPendingStep(phone, "REGION");
      return { handled: true, reply: getText("DELIVERY_ASK_REGION") };
    }
    return { handled: true, reply: getText("DELIVERY_REMINDER_CHOICE") };
  }

  if (pending.step === "REGION") {
    // Fallback نادر بس لو موقع المزارع اتبعت وفشل تحديده (شوف handleLocation) - رقم يدوي
    const region = store.REGIONS[text];
    if (!region) return { handled: true, reply: getText("DELIVERY_REMINDER_REGION") };
    return moveToDateTime(phone, pending, { regionKey: region.key }, getText);
  }

  if (pending.step === "DATETIME") {
    if (text.trim().length < MIN_DATETIME_LENGTH) {
      return { handled: true, reply: getText("DELIVERY_REMINDER_DATETIME") };
    }
    const region = store.REGION_BY_KEY[pending.regionKey];
    const request = store.createRequest({
      phone,
      name: pending.name,
      regionKey: pending.regionKey,
      district: pending.district,
      autoDetected: pending.autoDetected,
      preferredDateTime: text.trim(),
    });
    store.clearPending(phone);
    return { handled: true, reply: getText("DELIVERY_THANKS").replace("{region}", region.ar), request };
  }

  return { handled: false };
}

// المزارع بعت موقعه الفعلي بدل ما يختار رقم منطقة - بيتفعّل بس في خطوة REGION بالظبط. بنحدد
// المنطقة تلقائيًا بمطابقة الإحداثيات مع حدود الـ14 منطقة الزراعية الرسمية (KMZ). لو الموقع
// برّه كل المناطق المعروفة، بنرجع لطلب رقم يدوي بدل ما نخمّن منطقة غلط لطلب توصيل حقيقي
function handleLocation(phone, latitude, longitude, getText) {
  const pending = store.getPending(phone);
  if (!pending || pending.step !== "REGION") return { handled: false };

  const match = classifyPoint(latitude, longitude);
  if (!match) {
    return { handled: true, reply: getText("DELIVERY_LOCATION_UNKNOWN") };
  }
  return moveToDateTime(phone, pending, { regionKey: match.zone, district: match.district, autoDetected: true }, getText);
}

// بعد ما المنطقة تتحدد (يدويًا أو من الموقع)، بنحفظها في حالة الانتظار وننتقل لخطوة اليوم/الوقت
// المفضّل - مفيش إنشاء طلب لسه في الخطوة دي
function moveToDateTime(phone, pending, regionInfo, getText) {
  store.setPendingStep(phone, "DATETIME", regionInfo);
  return { handled: true, reply: getText("DELIVERY_ASK_DATETIME") };
}

function formatGroupMessage(request) {
  const region = store.REGION_BY_KEY[request.regionKey];
  return (
    `🚚 طلب توصيل بطاقة جديد (${request.id})\n\n` +
    `👤 الاسم: ${request.name || "غير معروف"}\n` +
    `📱 الجوال: ${store.formatContact(request.phone)}\n` +
    `📍 المنطقة: ${region ? region.ar : request.regionKey}${request.district ? ` (${request.district})` : ""}${request.autoDetected ? " - محدَّدة تلقائيًا من الموقع" : ""}\n` +
    `🕒 اليوم/الوقت المفضّل: ${request.preferredDateTime || "غير محدَّد"}\n` +
    `📅 وقت الطلب: ${new Date(request.createdAt).toLocaleString("ar-SA")}\n\n` +
    `بعد التسليم أرسل للبوت: تم التوصيل ${request.id}`
  );
}

// بيبعت الطلب لمجموعة منطقته فقط. لو المجموعة مش مربوطة أو الإرسال فشل، الطلب بيتسجّل
// "لم يُرسل للمجموعة" بدل ما يضيع (وبيظهر في "المعلقات" و"طلبات التوصيل" للمتابعة اليدوية)
async function forwardRequest(client, request) {
  const groupId = store.getGroups()[request.regionKey];
  if (!groupId) {
    store.markForwarded(request.id, false, "no_group_linked");
    return { ok: false, reason: "no_group_linked" };
  }
  try {
    await client.sendMessage(groupId, formatGroupMessage(request));
    store.markForwarded(request.id, true);
    return { ok: true };
  } catch (err) {
    store.markForwarded(request.id, false, err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = { handleReply, handleLocation, formatGroupMessage, forwardRequest };
