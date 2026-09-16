// بيرجع تاريخ اليوم بصيغة YYYY-MM-DD بناءً على التوقيت المحلي للجهاز، مش UTC
// (Date.toISOString() بيرجع تاريخ UTC، وده كان بيسبب مشكلة إن من الساعة 12 لغاية 3 فجرًا
// بتوقيت السعودية (UTC+3) كان النظام لسه شايف إنه "امبارح" لأن الساعة عند UTC لسه ماوصلتش نص الليل)
function localDateStr(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = { localDateStr };
