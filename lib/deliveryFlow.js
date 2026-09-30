const { Location } = require("whatsapp-web.js");
const store = require("./deliveryStore");
const { classifyPoint } = require("./deliveryRegionsGeo");

// منطق حوار "استلام أم توصيل" - دوال نقية (من غير أي WhatsApp client مباشر) عشان تتختبر بسهولة.
// getText: دالة بترجّع نص رد حسب المفتاح (config.js + تعديلات الإدارة) - مفيش أي نص متكتب هنا.
//
// خطوات حالة الانتظار: CHOICE (1 استلام / 2 توصيل) -> REGION (الأساس: موقع فعلي بيتحدد منه
// المنطقة تلقائيًا من حدود العلا الرسمية (KMZ)؛ رقم منطقة يدوي 1/2/3 متاح كبديل/fallback -
// سواء المزارع فضّله من الأول، أو الموقع طلع برّه كل المناطق المعروفة) -> DATETIME (اليوم
// والوقت المفضّل - نص حر) -> إنشاء الطلب فعليًا وتوجيهه للمجموعة

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
    // رقم منطقة يدوي - بديل/fallback لو المزارع مابعتش موقع (أو الموقع طلع برّه المناطق المعروفة)
    const region = store.REGIONS[text];
    if (!region) return { handled: true, reply: getText("DELIVERY_REMINDER_REGION") };
    return moveToDateTime(phone, { regionKey: region.key, district: null, autoDetected: false }, getText);
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
      latitude: pending.latitude,
      longitude: pending.longitude,
    });
    store.clearPending(phone);
    return { handled: true, reply: getText("DELIVERY_THANKS").replace("{region}", region.ar), request };
  }

  return { handled: false };
}

// المزارع بعت موقعه الفعلي - الطريقة الأساسية لتحديد المنطقة، بتتفعّل في خطوة REGION (الحالة
// العادية) وكمان في خطوة DATETIME (لو المزارع كان اختار رقم منطقة يدوي - أو حتى موقع سابق -
// وبعدين بعت موقعه الفعلي؛ الموقع الحقيقي هو المرجع الأدق دايمًا، فبيصحح المنطقة المسجّلة لو
// مختلفة عن اللي اتحددت قبل كده، ده مهم عشان الطلب يوصل لمجموعة المنطقة الصح فعليًا مش اللي
// المزارع خمّنها غلط). بنطابق الإحداثيات مع حدود الـ14 منطقة الزراعية الرسمية (KMZ). لو الموقع
// طلع برّه كل المناطق المعروفة، ممنوع نخمّن لطلب توصيل حقيقي - بنسيب المنطقة المسجّلة زي ما هي
// (لو REGION، بنرجع نطلب رقم منطقة يدوي بدل كده)
function handleLocation(phone, latitude, longitude, getText) {
  const pending = store.getPending(phone);
  if (!pending) return { handled: false };

  if (pending.step === "REGION") {
    const match = classifyPoint(latitude, longitude);
    if (!match) return { handled: true, reply: getText("DELIVERY_LOCATION_UNKNOWN") };
    return moveToDateTime(phone, { regionKey: match.zone, district: match.district, autoDetected: true, latitude, longitude }, getText);
  }

  if (pending.step === "DATETIME") {
    const match = classifyPoint(latitude, longitude);
    if (!match) return { handled: true, reply: getText("DELIVERY_LOCATION_UNKNOWN") };
    const previousRegionKey = pending.regionKey;
    store.setPendingStep(phone, "DATETIME", { regionKey: match.zone, district: match.district, autoDetected: true, latitude, longitude });
    if (match.zone !== previousRegionKey) {
      const region = store.REGION_BY_KEY[match.zone];
      return { handled: true, reply: getText("DELIVERY_REGION_CORRECTED").replace("{region}", region.ar) };
    }
    return { handled: true, reply: getText("DELIVERY_ASK_DATETIME") };
  }

  return { handled: false };
}

// بعد ما المنطقة تتحدد (تلقائيًا من الموقع أو يدويًا كـfallback)، بننتقل لخطوة اليوم/الوقت
// المفضّل - مفيش إنشاء طلب لسه في الخطوة دي
function moveToDateTime(phone, regionInfo, getText) {
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
    // لو المنطقة اتحددت من موقع فعلي (autoDetected)، نبعت الـpin نفسه كمان للمجموعة عشان فريق
    // التوصيل يقدر يفتحه مباشرة على الخريطة بدل ما يعتمد بس على اسم المنطقة
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
