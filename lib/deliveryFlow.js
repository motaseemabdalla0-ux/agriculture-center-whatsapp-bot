const { Location } = require("whatsapp-web.js");
const store = require("./deliveryStore");
const { classifyPoint } = require("./deliveryRegionsGeo");

// منطق حوار "استلام أم توصيل" - دوال نقية (من غير أي WhatsApp client مباشر) عشان تتختبر بسهولة.
// getText: دالة بترجّع نص رد حسب المفتاح (config.js + تعديلات الإدارة) - مفيش أي نص متكتب هنا.
//
// خطوات حالة الانتظار: CHOICE (1 استلام / 2 توصيل) -> REGION (رقم منطقة يدوي إلزامي: شمال/جنوب/
// وسط) -> LOCATION (موقع فعلي إلزامي - بيتسجّل كـpin حقيقي للمجموعة، والمنطقة الزراعية الدقيقة
// منه بتتسجّل كمعلومة إضافية بس، مفيش تأثير على المنطقة اللي المزارع اختارها يدويًا) -> DATETIME
// (اليوم والوقت المفضّل - نص حر) -> إنشاء الطلب فعليًا وتوجيهه للمجموعة

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
    const region = store.REGIONS[text];
    if (!region) return { handled: true, reply: getText("DELIVERY_REMINDER_REGION") };
    store.setPendingStep(phone, "LOCATION", { regionKey: region.key });
    return { handled: true, reply: getText("DELIVERY_ASK_LOCATION") };
  }

  if (pending.step === "LOCATION") {
    // الموقع بقى إلزامي هنا - أي رد نصي (بدل موقع فعلي) بيتذكّر بإرساله، مش بيتقبل كبديل
    return { handled: true, reply: getText("DELIVERY_REMINDER_LOCATION") };
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
      autoDetected: false, // المنطقة دايمًا اختيار يدوي في التدفق ده - الموقع مجرد معلومة إضافية/pin
      preferredDateTime: text.trim(),
      latitude: pending.latitude,
      longitude: pending.longitude,
    });
    store.clearPending(phone);
    return { handled: true, reply: getText("DELIVERY_THANKS").replace("{region}", region.ar), request };
  }

  return { handled: false };
}

// المزارع بعت موقعه الفعلي - بيتفعّل بس في خطوة LOCATION بالظبط (بعد ما يكون اختار رقم منطقته
// يدويًا فعلاً). بنحاول نطابق الإحداثيات مع حدود الـ14 منطقة الزراعية الرسمية (KMZ) بس كمعلومة
// إضافية (اسم المنطقة الزراعية الدقيقة) - مفيش أي تأثير على المنطقة اللي المزارع اختارها يدويًا،
// وحتى لو الموقع برّه كل المناطق المعروفة بنكمّل عادي (المنطقة أصلاً محسومة من رده اليدوي)
function handleLocation(phone, latitude, longitude, getText) {
  const pending = store.getPending(phone);
  if (!pending || pending.step !== "LOCATION") return { handled: false };

  const match = classifyPoint(latitude, longitude);
  store.setPendingStep(phone, "DATETIME", { district: match ? match.district : null, latitude, longitude });
  return { handled: true, reply: getText("DELIVERY_ASK_DATETIME") };
}

function formatGroupMessage(request) {
  const region = store.REGION_BY_KEY[request.regionKey];
  return (
    `🚚 طلب توصيل بطاقة جديد (${request.id})\n\n` +
    `👤 الاسم: ${request.name || "غير معروف"}\n` +
    `📱 الجوال: ${store.formatContact(request.phone)}\n` +
    `📍 المنطقة: ${region ? region.ar : request.regionKey}${request.district ? ` (${request.district})` : ""}\n` +
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
    // الموقع بقى إلزامي في التدفق الجديد، فكل طلب المفروض معاه إحداثيات - نبعتها كـpin حقيقي
    // كمان للمجموعة عشان فريق التوصيل يقدر يفتحها مباشرة على الخريطة
    if (typeof request.latitude === "number" && typeof request.longitude === "number") {
      await client.sendMessage(groupId, new Location(request.latitude, request.longitude));
    }
    store.markForwarded(request.id, true);
    return { ok: true };
  } catch (err) {
    store.markForwarded(request.id, false, err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = { handleReply, handleLocation, formatGroupMessage, forwardRequest };
