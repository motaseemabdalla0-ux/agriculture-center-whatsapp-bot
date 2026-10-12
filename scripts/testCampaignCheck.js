// اختبارات فحص إرسال أرقام معيّنة (campaignCheck). صفر واتساب، صفر ملفات حقيقية - دوال نقية بس
const assert = require("assert");
const { extractPhones, checkPhones, formatCheck } = require("../lib/campaignCheck");

let passed = 0;
const check = (label, cond) => {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
};

const pasted = `+966559414585
+966540094369
+966543925454 
+966541588080
+966542042002
+966504557270
+966505371958
+966509111197
+966504354204
+966553985583
+966555499963
+966599424177
+966553963458
+966559414585`;

const phones = extractPhones(pasted);
check("1: بيستخرج 13 رقم (بدون تكرار)", phones.length === 13 && phones[0] === "966559414585");
check("1ب: بيقبل 05xxxxxxxx وبالمسافات", extractPhones("0559414585 و 966 54 009 4369").join() === "966559414585,966540094369");
check("1ج: بيتجاهل أرقام مش جوال سعودي", extractPhones("12345678 و 0112345678").length === 0);

const sentRows = [{ phone: "966559414585", date: "2026-10-05", name: "أحمد" }];
const auditEntries = [
  { normalizedPhone: "966540094369", campaignType: "draft_reminder", decision: "BLOCKED_NON_ARABIC_NAME", reason: "BLOCKED_NON_ARABIC_NAME", timestamp: "2026-10-05T10:00:00Z" },
  { normalizedPhone: "966543925454", campaignType: "draft_reminder", decision: "FAILED", reason: "not on whatsapp", timestamp: "2026-10-06T10:00:00Z" },
  { normalizedPhone: "966541588080", campaignType: "card_pickup", decision: "SENT", timestamp: "2026-10-06T10:00:00Z" }, // نوع تاني - مايتحسبش
];
const results = checkPhones(phones, { sentRows, auditEntries, campaignType: "draft_reminder", inCurrentFile: new Set(["966542042002"]) });
const by = Object.fromEntries(results.map((r) => [r.phone, r]));
check("2: المبعوت من sendLog ✅ بتاريخه", by["966559414585"].sent === true && by["966559414585"].detail === "2026-10-05");
check("2ب: الاسم غير العربي ممنوع وبسببه", by["966540094369"].sent === false && by["966540094369"].status.includes("الاسم غير عربي"));
check("2ج: فشل الإرسال ظاهر", by["966543925454"].status.includes("فشل"));
check("2د: قرار من نوع حملة تانية ما بيتحسبش", by["966541588080"].sent === false && by["966541588080"].status.includes("مفيش أي محاولة"));
check("2هـ: اللي في الملف الحالي لسه ما جاش دوره", by["966542042002"].status.includes("لسه ما جاش دوره"));
check("2و: الباقي بدون أي سجل -> مفيش محاولة", by["966553963458"].status.includes("مفيش أي محاولة"));
const text = formatCheck("تذكير درافت", results);
check("3: الملخص: 1 أُرسل / 12 لم يُرسل", text.includes("✅ أُرسل: 1") && text.includes("❌ لم يُرسل: 12"));

console.log(`\n🎉 كل اختبارات فحص الإرسال نجحت (${passed} اختبار). صفر واتساب حقيقي.`);
