// انسخ الملف ده باسم portal_config.js (بدون .example) وحط بيانات حساب المشاهد الحقيقية
// ملف portal_config.js متضاف في .gitignore عشان محدش يشوف بياناتك أو ترفع بالغلط لأي مكان

module.exports = {
  LOGIN_URL: "https://agriculture.rcu.gov.sa/portal-selector",
  USERNAME: "ضع اسم المستخدم أو رقم الجوال هنا",
  PASSWORD: "ضع كلمة السر هنا",

  ISSUING_URL: "https://agriculture.rcu.gov.sa/portals/smartcard-issuing",
  REGISTRATION_REVIEW_URL: "https://agriculture.rcu.gov.sa/portals/smartcard-registeration-review",
  DRAFT_FORMS_URL: "https://agriculture.rcu.gov.sa/portals/smartcard-registration-form",

  // كل قد إيه (بالدقايق) البوت يدخل يفحص النظام ويشوف فيه بطاقات جاهزة/طلبات جديدة/درافت
  CHECK_INTERVAL_MINUTES: 60,
};
