const { normalizeSaudiPhone } = require("./phoneUtil");

// فحص أرقام معيّنة: هل اتبعتلها رسالة من نوع حملة (الدرافت مثلًا)؟ ولو لأ، إيه آخر قرار سجّله النظام
// (اسم غير عربي / حالة تمنع / فشل / حدّ الإرسال...). بيقرا من سجل الإرسال (sendLog) وسجل القرارات
// (auditLog) فقط - قراءة بس، مفيش إرسال. دالة نقية بتاخد البيانات كمُدخل عشان تتختبر من غير ملفات.
const DECISION_LABEL = {
  SENT: "✅ أُرسل",
  BLOCKED_NON_ARABIC_NAME: "🚫 ممنوع - الاسم غير عربي ومفيش اسم عربي محفوظ",
  BLOCKED_BY_STATE: "🚫 ممنوع - حالة المزارع بتمنع هذه الرسالة",
  BLOCKED_STALE_APPLICATION: "🚫 ممنوع - فيه طلب أحدث لنفس المزارع",
  DUPLICATE: "↩️ مكرر - اتبعتت قبل كده",
  INVALID_PHONE: "❌ رقم غير صالح",
  FAILED: "❌ فشل الإرسال (الرقم غالبًا مش على واتساب)",
  RATE_LIMITED: "⏳ وصل حدّ الإرسال - هيتبعت لاحقًا",
};

function extractPhones(text) {
  const raw = String(text || "").match(/\+?\d[\d\s\-]{7,}\d/g) || [];
  const seen = new Set();
  const phones = [];
  raw.forEach((r) => {
    const p = normalizeSaudiPhone(r);
    if (/^9665\d{8}$/.test(p) && !seen.has(p)) {
      seen.add(p);
      phones.push(p);
    }
  });
  return phones;
}

// sentRows: [{phone, date, name}] من sendLog.getAllByLabel(label) - auditEntries: من auditLog.readAll()
function checkPhones(phones, { sentRows = [], auditEntries = [], campaignType, inCurrentFile = new Set() }) {
  return phones.map((phone) => {
    const sent = sentRows.filter((e) => normalizeSaudiPhone(e.phone) === phone).pop();
    if (sent) return { phone, sent: true, status: DECISION_LABEL.SENT, detail: sent.date || "", name: sent.name || "" };

    const decisions = auditEntries.filter((e) => e.normalizedPhone === phone && e.campaignType === campaignType);
    const last = decisions[decisions.length - 1];
    if (last) {
      const label = DECISION_LABEL[last.decision] || `ℹ️ ${last.decision}`;
      if (last.decision === "SENT") return { phone, sent: true, status: label, detail: String(last.timestamp || "").slice(0, 10) };
      return { phone, sent: false, status: label, detail: String(last.timestamp || "").slice(0, 10), reason: last.reason || "" };
    }
    return {
      phone,
      sent: false,
      status: inCurrentFile.has(phone) ? "⏳ في قائمة الإرسال لكن لسه ما جاش دوره" : "⚪ مفيش أي محاولة إرسال مسجّلة",
      detail: "",
    };
  });
}

function formatCheck(label, results) {
  const sent = results.filter((r) => r.sent).length;
  const lines = [`📋 فحص إرسال "${label}" لـ${results.length} رقم:`, `✅ أُرسل: ${sent}  |  ❌ لم يُرسل: ${results.length - sent}`, ""];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.phone}${r.name ? ` (${r.name})` : ""}\n   ${r.status}${r.detail ? ` - ${r.detail}` : ""}`);
  });
  return lines.join("\n");
}

module.exports = { extractPhones, checkPhones, formatCheck, DECISION_LABEL };
