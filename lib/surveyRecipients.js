const fs = require("fs");
const path = require("path");
const { normalizeSaudiPhone } = require("./phoneUtil");

// مستلمو استبيان الإنتاج الزراعي: المزارعين اللي استلموا بطاقاتهم (تاب "Delivered" في المنصة). منطق نقي
// (من غير واتساب ولا منصة) عشان يتختبر: اختيار اللي هيتبعتلهم، واللي اتبعتلهم قبل كده، واللي ممنوع
// لغياب اسم عربي موثوق (قاعدة الاسم العربي الإلزامية في البوت).
const STATE_FILE = path.join(__dirname, "..", "survey_state.json");

// rows: [{name, phone, nationalId, formNumber}] - ctx.hasBeenSent(phone)، ctx.resolveName(phone, candidate)
function selectSurveyRecipients(rows, ctx, limit = Infinity) {
  const send = [];
  const blocked = [];
  let alreadySent = 0;
  let noPhone = 0;
  let notReplied = 0;
  const seen = new Set();
  rows.forEach((row) => {
    const phone = row.phone ? normalizeSaudiPhone(row.phone) : "";
    if (!/^9665\d{8}$/.test(phone)) {
      noPhone++;
      return;
    }
    if (seen.has(phone)) return;
    seen.add(phone);
    if (ctx.hasBeenSent(phone)) {
      alreadySent++;
      return;
    }
    // الاستبيان بس للي سبق تواصلوا مع البوت (ردّوا) - مش لأرقام ما راسلتش (حماية الحساب من الحظر)
    if (ctx.hasReplied && !ctx.hasReplied(phone)) {
      notReplied++;
      return;
    }
    const name = ctx.resolveName(phone, row.name);
    if (!name) {
      blocked.push({ phone, name: row.name || "" });
      return;
    }
    if (send.length < limit) send.push({ name, phone });
  });
  return { total: seen.size + noPhone, send, blocked, alreadySent, noPhone, notReplied, limited: send.length >= limit };
}

// الإرسال التلقائي مفعّل افتراضيًا (بطلب الإدارة: يشتغل من غير تدخل) - بيتوقف بس لو الأدمن كتب
// "ايقاف استبيان المستلمين" (autoEnabled=false صريحة)
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { autoEnabled: s.autoEnabled !== false, pending: s.pending || null, lastNameScrapeAt: s.lastNameScrapeAt || 0 };
  } catch {
    return { autoEnabled: true, pending: null, lastNameScrapeAt: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
}

module.exports = { selectSurveyRecipients, loadState, saveState, STATE_FILE };
