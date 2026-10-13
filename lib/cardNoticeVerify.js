const fs = require("fs");
const path = require("path");
const { normalizeSaudiPhone } = require("./phoneUtil");

// تحقق كل مزامنة: كل بطاقة جاهزة (Printed / Pending Delivery في المنصة) لازم يكون اتبعتلها إشعار
// "جاهزة للاستلام" (campaignType "card_pickup"). أي بطاقة ما اتبعتلهاش بتتصنّف بسبب واضح (رقم مش على
// واتساب / رقم ناقص أو غلط / اسم غير عربي / حالة تمنع / فشل...) وبيتبعت تنبيه لرقم موظف التجهيز.
// فصل المنطق النقي (verify / selectToNotify) عن الملفات والواتساب عشان يتختبر بسهولة.
const ISSUE_STORE_FILE = path.join(__dirname, "..", "card_notice_issues.json");
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000; // نفس المشكلة لسه قايمة -> نفكّر بيها تاني بعد 24 ساعة

const ISSUE_LABEL = {
  NO_PHONE: "مفيش رقم جوال للمزارع في المنصة",
  INVALID_PHONE: "رقم الجوال غير صحيح",
  NOT_ON_WHATSAPP: "الرقم غير مسجّل على واتساب",
  BLOCKED_NON_ARABIC_NAME: "الاسم غير عربي في المنصة (ممنوع الإرسال بالاسم الإنجليزي)",
  BLOCKED_BY_STATE: "حالة المزارع بتمنع الإرسال",
  BLOCKED_STALE_APPLICATION: "فيه طلب أحدث لنفس المزارع",
  FAILED: "فشل الإرسال",
  DELIVERY_UNCERTAIN: "الإرسال غير مؤكّد (راجع السجل)",
  NOT_ATTEMPTED: "لم تتم محاولة الإرسال بعد",
};

// rows: صفوف المنصة [{name, phone, nationalId, formNumber}] - ctx.hasBeenSent(phone)، ctx.lastDecision(phone)
function verify(rows, ctx) {
  const problems = [];
  let sent = 0;
  const seen = new Set();
  rows.forEach((row) => {
    const phone = row.phone ? normalizeSaudiPhone(row.phone) : "";
    const key = phone || row.nationalId || row.formNumber;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);

    const base = { name: row.name || "", phone, formNumber: row.formNumber || "", nationalId: row.nationalId || "" };
    if (!phone) {
      problems.push({ ...base, code: "NO_PHONE" });
      return;
    }
    if (!/^9665\d{8}$/.test(phone)) {
      problems.push({ ...base, code: "INVALID_PHONE" });
      return;
    }
    if (ctx.hasBeenSent(phone)) {
      sent++;
      return;
    }
    const d = ctx.lastDecision(phone);
    if (!d) {
      problems.push({ ...base, code: "NOT_ATTEMPTED" });
      return;
    }
    if (d.decision === "SENT") {
      sent++;
      return;
    }
    if (d.decision === "RATE_LIMITED") {
      // وقف مؤقت بسبب الحد - هيتبعت لاحقًا، مش مشكلة في الرقم نفسه
      problems.push({ ...base, code: "NOT_ATTEMPTED", temporary: true });
      return;
    }
    if (d.decision === "FAILED") {
      problems.push({ ...base, code: /not_on_whatsapp/i.test(d.reason || "") ? "NOT_ON_WHATSAPP" : "FAILED", detail: d.reason || "" });
      return;
    }
    const code = ISSUE_LABEL[d.decision] ? d.decision : "FAILED";
    problems.push({ ...base, code, detail: d.reason || "" });
  });
  return { total: seen.size, sent, problems };
}

// أي مشكلة جديدة أو اتغيّر سببها أو عدّى عليها 24 ساعة من آخر تنبيه. temporary (حد الإرسال) مابتتبلّغش
function selectToNotify(problems, issueState, now = Date.now()) {
  return problems.filter((p) => {
    if (p.temporary) return false;
    const key = p.phone || p.nationalId || p.formNumber;
    const prev = issueState[key];
    return !prev || prev.code !== p.code || now - prev.lastNotifiedAt > REMIND_AFTER_MS;
  });
}

function markNotified(problems, issueState, now = Date.now()) {
  problems.forEach((p) => {
    const key = p.phone || p.nationalId || p.formNumber;
    issueState[key] = { code: p.code, lastNotifiedAt: now };
  });
  return issueState;
}

// مشاكل اتحلّت (البطاقة بقت اتبعتلها) بنشيلها من الحالة عشان لو رجعت تاني تتبلّغ من جديد
function pruneResolved(problems, issueState) {
  const active = new Set(problems.map((p) => p.phone || p.nationalId || p.formNumber));
  Object.keys(issueState).forEach((k) => {
    if (!active.has(k)) delete issueState[k];
  });
  return issueState;
}

function formatAlert(result, problemsToShow) {
  const fmtPhone = (p) => (p.phone ? `+${p.phone}` : "بدون رقم");
  const lines = [
    "⚠️ مشكلة في إرسال إشعار استلام البطاقة",
    "",
    `تم التأكد من ${result.total} بطاقة جاهزة: وصل الإشعار لـ ${result.sent}، ولم يصل لـ ${result.problems.filter((p) => !p.temporary).length}.`,
    "",
    "البطاقات التي لم يصلها الإشعار:",
  ];
  problemsToShow.forEach((p, i) => {
    lines.push(
      `${i + 1}. ${p.name || "بدون اسم"} - ${fmtPhone(p)}${p.formNumber ? ` (طلب ${p.formNumber})` : ""}\n   السبب: ${ISSUE_LABEL[p.code] || p.code}`
    );
  });
  lines.push("", "المطلوب: تصحيح الرقم في المنصة، أو التواصل مع المستفيد بطريقة أخرى لإبلاغه بجاهزية بطاقته.");
  return lines.join("\n");
}

function loadIssueState() {
  try {
    return JSON.parse(fs.readFileSync(ISSUE_STORE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveIssueState(state) {
  try {
    fs.writeFileSync(ISSUE_STORE_FILE, JSON.stringify(state), "utf8");
  } catch (err) {
    console.log(`⚠️ تعذّر حفظ حالة تنبيهات الإشعارات: ${err.message}`);
  }
}

module.exports = { verify, selectToNotify, markNotified, pruneResolved, formatAlert, loadIssueState, saveIssueState, ISSUE_LABEL, ISSUE_STORE_FILE };
