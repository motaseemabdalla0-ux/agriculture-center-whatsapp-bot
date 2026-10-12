// إضافة مدير مباشرة من الجهاز (من غير ما تحتاج تبعت أمر من رقم أدمن) - مفيد لو رقمك ما اتعرّفش كأدمن.
// الاستخدام (من مجلد البوت على الجهاز):
//   node scripts/addAdmin.js 966506339460
//   node scripts/addAdmin.js 190498996232420@lid     (معرّف @lid الكامل لو رقمك بيوصل بالصيغة دي)
// بيتحفظ في admin_settings.json والبوت بيقراه تلقائيًا (من غير إعادة تشغيل).
const adminStore = require("../lib/adminStore");

const args = process.argv.slice(2).map((a) => a.trim()).filter(Boolean);
if (args.length === 0) {
  console.log("الاستخدام: node scripts/addAdmin.js <رقم 966... أو معرّف ...@lid> [أرقام تانية]");
  console.log("المديرين الحاليين:", adminStore.getAdmins().join(", ") || "لا يوجد");
  process.exit(0);
}
for (const a of args) {
  const value = /@/.test(a) ? a : a.replace(/[^\d]/g, "");
  if (!/^\d{8,20}(@lid)?$/.test(value)) {
    console.log(`⚠️ تجاهلت "${a}" - صيغة غير صالحة`);
    continue;
  }
  console.log(adminStore.addAdmin(value) ? `✅ اتضاف: ${value}` : `ℹ️ موجود بالفعل: ${value}`);
}
console.log("المديرين الحاليين:", adminStore.getAdmins().join(", "));
