const store = require("./deliveryStore");

// منطق حوار "استلام أم توصيل" - دوال نقية (من غير أي WhatsApp client مباشر) عشان تتختبر بسهولة.
// getText: دالة بترجّع نص رد حسب المفتاح (config.js + تعديلات الإدارة) - مفيش أي نص متكتب هنا.

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
    const request = store.createRequest({ phone, name: pending.name, regionKey: region.key });
    store.clearPending(phone);
    return { handled: true, reply: getText("DELIVERY_THANKS").replace("{region}", region.ar), request };
  }

  return { handled: false };
}

function formatGroupMessage(request) {
  const region = store.REGION_BY_KEY[request.regionKey];
  return (
    `🚚 طلب توصيل بطاقة جديد (${request.id})\n\n` +
    `👤 الاسم: ${request.name || "غير معروف"}\n` +
    `📱 الجوال: ${store.formatContact(request.phone)}\n` +
    `📍 المنطقة: ${region ? region.ar : request.regionKey}\n` +
    `🕒 الوقت: ${new Date(request.createdAt).toLocaleString("ar-SA")}\n\n` +
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

module.exports = { handleReply, formatGroupMessage, forwardRequest };
