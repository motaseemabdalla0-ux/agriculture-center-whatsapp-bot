const store = require("./deliveryStore");

// تقرير يومي بكل طلبات التوصيل المفتوحة (لسه ما اتسلّمتش) مقسّمة على الثلاث مناطق - بيُستخدم
// في الإرسال التلقائي اليومي لأرقام مسجّلة خصيصًا لاستقبال التقرير ده (شوف deliveryStore.js:
// addReportRecipient). فصل البناء (build) عن التنسيق (format) زي pendingItemsReport.js بالظبط -
// عشان يتختبر من غير أي واتساب حقيقي
function buildDeliveryDailyReport() {
  const open = store.listOpenRequests();
  const byRegion = { NORTH: [], SOUTH: [], CENTER: [] };
  open.forEach((r) => {
    if (byRegion[r.regionKey]) byRegion[r.regionKey].push(r);
  });
  return { byRegion, total: open.length };
}

function formatRequestLine(request) {
  const when = request.preferredDateTime || "غير محدَّد";
  const place = request.district ? ` (${request.district})` : "";
  return `• ${request.name || "بدون اسم"} - ${store.formatContact(request.phone)}${place} - 🕒 ${when} - ${request.id}`;
}

function formatDeliveryDailyReport(data) {
  const dateLabel = new Date().toLocaleDateString("ar-SA", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  if (data.total === 0) {
    return `🚚 تقرير طلبات التوصيل اليومي - ${dateLabel}\n\nلا يوجد طلبات توصيل مفتوحة حاليًا.`;
  }

  const sections = Object.values(store.REGIONS).map((region) => {
    const requests = data.byRegion[region.key] || [];
    const lines = requests.length ? requests.map(formatRequestLine).join("\n") : "لا يوجد.";
    return `📍 *${region.ar}* (${requests.length}):\n${lines}`;
  });

  return `🚚 تقرير طلبات التوصيل اليومي - ${dateLabel}\n\n${sections.join("\n\n")}\n\nإجمالي الطلبات المفتوحة: ${data.total}`;
}

module.exports = { buildDeliveryDailyReport, formatDeliveryDailyReport };
