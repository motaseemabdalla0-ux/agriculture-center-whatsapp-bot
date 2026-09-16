const auditLog = require("./auditLog");
const rateLimiter = require("./rateLimiter");

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// عدّاد CAMPAIGN بييجي من rateLimiter مباشرة (هو مصدر الحقيقة لحصة الحملات). SYSTEM_NOTIFICATION
// وINBOUND_REPLY (لو حبينا نحسبها لاحقًا) بتتحسب من Audit Log - مفيش عداد منفصل مخزّن ليهم
// (مفيش حاجة نمنعها أصلًا، فمفيش داعي "حصة" - بس عدد للعرض والمتابعة بس)
function getDashboard() {
  const rateStatus = rateLimiter.getStatus();
  const today = todayStr();
  const sentToday = auditLog.readAll().filter((e) => e.decision === "SENT" && e.timestamp.startsWith(today));

  const systemNotificationsToday = sentToday.filter((e) => e.messageSource === "SYSTEM_NOTIFICATION").length;
  const campaignSentToday = sentToday.filter((e) => e.messageSource === "CAMPAIGN").length;

  return {
    campaigns: {
      today: rateStatus.daily.used,
      dailyLimit: rateStatus.daily.limit,
      thisHour: rateStatus.hourly.used,
      hourlyLimit: rateStatus.hourly.limit,
      remaining: rateStatus.daily.remaining,
      sentTodayFromAudit: campaignSentToday, // للتقاطع/التأكيد بس - المصدر الرسمي هو rateStatus فوق
    },
    systemNotifications: {
      sentToday: systemNotificationsToday,
      note: "لا تدخل ضمن حصة الحملات (500/يوم، 50/ساعة)",
    },
    inboundReplies: {
      note: "الردود التلقائية على المزارعين بتستخدم msg.reply() مباشرة (مسار منفصل تمامًا عن safeFarmerSend وrateLimiter) - لا تدخل ضمن حصة الحملات ولا تُحسب هنا",
    },
  };
}

module.exports = { getDashboard };
