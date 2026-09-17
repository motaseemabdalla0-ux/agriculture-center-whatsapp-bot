// تحديث اسم جهة الاتصال الظاهر في واتساب (Desktop/الويب) للاسم العربي الموثوق بس. تم التأكد
// (بقراءة node_modules/whatsapp-web.js/src/Client.js مباشرة، مش تخمين) إن
// client.saveOrEditAddressbookContact(phone, firstName, lastName, syncToAddressbook) دالة
// عامة موثّقة في المكتبة نفسها - بتنادي WAWebSaveContactAction.saveContactAction() الداخلية
// بتاعة واتساب ويب نفسها. يعني ده مش Hack أو تلاعب بـDOM، دالة رسمية موجودة في المكتبة.
//
// syncToAddressbook=false عمدًا: بيغيّر الاسم الظاهر في جلسة واتساب ويب الحالية بس، من غير ما
// يزرعه في دفتر عناوين الهاتف الحقيقي (تغيير أكبر من المطلوب وغير قابل للتراجع بسهولة).
//
// اسم جهة الاتصال = الاسم العربي الموثوق بس - ممنوع نهائيًا إن "حملة تسجيل" أو أي campaignLabel
// يدخل جوّه الاسم الظاهر؛ campaignLabel بيتسجّل في Farmer Registry بس (حقل منفصل تمامًا).
//
// Best-effort دائمًا: فشل هذه الخطوة لا يوقف أو يفشّل الإرسال أبدًا - مجرد تحسين عرض إضافي.
// لو المكتبة/النسخة الحالية ما فيهاش الدالة دي أصلًا (نسخة أقدم مثلًا)، بنرجّع not_supported
// ومنعملش أي محاولة بديلة (Hack) خالص.
async function trySetContactName(client, phone, nameArabic) {
  if (!nameArabic) return { attempted: false, reason: "no_name" };
  if (!client || typeof client.saveOrEditAddressbookContact !== "function") {
    return { attempted: false, reason: "not_supported" };
  }
  try {
    // firstName بس = الاسم العربي الكامل، lastName فاضي - ممنوع أي نص تاني (زي اسم الحملة)
    // يتحط جوّه اسم جهة الاتصال إطلاقًا
    await client.saveOrEditAddressbookContact(phone, nameArabic, "", false);
    return { attempted: true, ok: true };
  } catch (err) {
    console.log(`⚠️ فشل تحديث اسم جهة الاتصال في واتساب لـ${phone} (مش خطر - مجرد تحسين عرض): ${err.message}`);
    return { attempted: true, ok: false, error: err.message };
  }
}

module.exports = { trySetContactName };
