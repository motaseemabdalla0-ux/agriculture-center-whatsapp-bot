// اختبارات اختيار مستلمي استبيان الإنتاج + نص الرسالة. منطق نقي - صفر واتساب وصفر منصة
const assert = require("assert");
const { selectSurveyRecipients } = require("../lib/surveyRecipients");
const { fillTemplate } = require("../lib/personalizedRunner");
const { TEXT } = (() => {
  try {
    const c = require("../config");
    return { TEXT: c.TEXT || c.texts || c };
  } catch {
    return { TEXT: {} };
  }
})();

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

const rows = [
  { name: "أحمد عبدالله", phone: "966501111111" },
  { name: "AHMAD SALEH", phone: "966502222222" }, // اسم إنجليزي ومفيش عربي موثوق
  { name: "خالد سعد", phone: "+966 50 333 3333" },
  { name: "منى", phone: "966504444444" }, // اتبعتلها قبل كده
  { name: "بدون جوال", phone: "" },
  { name: "مكرر", phone: "966501111111" },
  { name: "عمر", phone: "0505555555" },
];
const ctx = {
  hasBeenSent: (p) => p === "966504444444",
  resolveName: (p, c) => (/^[ء-ي\s]+$/.test(c || "") ? c : p === "966502222222" ? null : null),
};
const r = selectSurveyRecipients(rows, ctx);
check("1: اللي هيتبعتلهم 3 (أحمد وخالد وعمر - 0505555555 اتحوّل لصيغة 966)", r.send.length === 3 && r.send.map((x) => x.phone).join() === "966501111111,966503333333,966505555555");
check("1ب: اللي اتبعتلهم قبل كده بيتحسب ومش بيتكرر", r.alreadySent === 1);
check("1ج: الاسم الإنجليزي من غير اسم عربي موثوق = ممنوع", r.blocked.length === 1 && r.blocked[0].phone === "966502222222");
check("1د: بدون جوال صالح = مستبعد", r.noPhone === 1);
check("1هـ: المكرر مش بيتبعت مرتين", r.send.filter((x) => x.phone === "966501111111").length === 1);
check("2: limit بيحدّ عدد المرسل", selectSurveyRecipients(rows, ctx, 2).send.length === 2);

console.log("\n=== نص الرسالة ===");
const config = require("../config");
const tpl = (config.TEXT && config.TEXT.PRODUCTION_SURVEY_TEMPLATE) || config.PRODUCTION_SURVEY_TEMPLATE || (config.defaults && config.defaults.PRODUCTION_SURVEY_TEMPLATE);
check("3: القالب موجود في config", typeof tpl === "string" && tpl.length > 100);
if (typeof tpl === "string") {
  const msg = fillTemplate(tpl, { name: "أحمد عبدالله" });
  check("3ب: الرسالة فيها الاسم والرابط والتحية", msg.includes("عزيزي المزارع / أحمد عبدالله") && msg.includes("https://agriculture.rcu.gov.sa/farm-production-survey") && msg.startsWith("السلام عليكم ورحمة الله وبركاته"));
  check("3ج: مفيش {name} متبقي", !msg.includes("{name}"));
}

console.log(`\n🎉 كل اختبارات استبيان المستلمين نجحت (${passed} اختبار). صفر واتساب حقيقي.`);

// الإرسال التلقائي مفعّل افتراضيًا (بدون ملف حالة)
{
  const fs = require("fs");
  const { loadState, STATE_FILE } = require("../lib/surveyRecipients");
  if (!fs.existsSync(STATE_FILE)) {
    assert(loadState().autoEnabled === true, "autoEnabled default");
    console.log("✅ 4: الإرسال التلقائي مفعّل افتراضيًا من غير ملف حالة");
  }
}
