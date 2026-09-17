// سكريبت تصحيح لمرة واحدة (Reconciliation) - يشغّله المسؤول يدويًا على السيرفر بعد نشر
// الإصلاح، قبل أي استئناف لأي حملة كانت شغالة وقت الحادثة (EPERM على rename).
//
// القاعدة المستخدمة (مبنية على دليل حقيقي من الكود القديم، مش تخمين):
// في الكود *قبل* هذا الإصلاح، كان safeFarmerSend.js بيغلّف "الإرسال الفعلي" و"حفظ الحالة
// بعده" (confirmSent/markSent) في try/catch واحد مشترك. فأي صف اتسجّل status="failed" وسببه
// (error) بيحتوي EPERM/EACCES/EBUSY، معناه بالتأكيد إن العملية وصلت لمرحلة الحفظ - وده مستحيل
// يحصل غير لو client.sendMessage() نجح فعليًا الأول. يعني: الرسالة **اتبعتت فعليًا للمزارع**،
// بس تسجيل الحالة فشل بعدها.
//
// هذا السكريبت بيدوّر على كل ملفات campaigns/*.json، وبيحوّل أي صف status="failed" وerror فيه
// EPERM/EACCES/EBUSY إلى status="delivery_uncertain" (حالة مستقلة، مش قابلة لإعادة المحاولة
// التلقائية عبر أمر "اعادة محاولة" - محتاجة مراجعة يدوية بس، ولا تُرسل تلقائيًا أبدًا).
//
// آمن 100%: نسخة احتياطية قبل أي تعديل، مفيش أي نداء واتساب هنا خالص، ومفيش تغيير على أي صف
// تاني غير اللي بينطبق عليه الشرط بالظبط. لا يحذف أو يعيد إنشاء أي بيانات موجودة.
const fs = require("fs");
const path = require("path");

const CAMPAIGNS_DIR = path.join(__dirname, "..", "campaigns");
const RETRYABLE_FS_ERROR = /EPERM|EACCES|EBUSY/i;

function reconcileFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  let campaign;
  try {
    campaign = JSON.parse(raw);
  } catch (err) {
    console.log(`⚠️ تخطّي ${path.basename(filePath)} (JSON تالف: ${err.message})`);
    return { changed: 0 };
  }

  let changed = 0;
  campaign.rows.forEach((row, idx) => {
    if (row.status === "failed" && row.error && RETRYABLE_FS_ERROR.test(row.error)) {
      console.log(
        `  ↪ صف ${idx + 1} (${row.name || row.phone}, ${row.phone}): failed[${row.error.slice(0, 60)}...] -> delivery_uncertain`
      );
      row.status = "delivery_uncertain";
      row.reconciledAt = new Date().toISOString();
      row.reconciledReason = "WHATSAPP_SEND_LIKELY_SUCCEEDED_PERSISTENCE_FAILED";
      changed++;
    }
  });

  if (changed > 0) {
    fs.copyFileSync(filePath, `${filePath}.before-reconcile.bak`);
    fs.writeFileSync(filePath, JSON.stringify(campaign, null, 2), "utf8");
  }
  return { changed, total: campaign.rows.length };
}

function main() {
  if (!fs.existsSync(CAMPAIGNS_DIR)) {
    console.log("مفيش مجلد campaigns/ أصلًا - مفيش حاجة نصلّحها.");
    return;
  }
  const files = fs.readdirSync(CAMPAIGNS_DIR).filter((f) => f.endsWith(".json") && !f.includes(".before-reconcile"));
  console.log(`🔍 فحص ${files.length} ملف حملة...\n`);

  let totalChanged = 0;
  files.forEach((f) => {
    const filePath = path.join(CAMPAIGNS_DIR, f);
    console.log(`📄 ${f}:`);
    const { changed, total } = reconcileFile(filePath);
    if (changed === 0) {
      console.log("  (مفيش صفوف محتاجة تصحيح)");
    } else {
      console.log(`  ✅ تم تصحيح ${changed} صف من أصل ${total}`);
    }
    totalChanged += changed;
  });

  console.log(`\n🎉 انتهى. إجمالي الصفوف اللي اتصحّحت: ${totalChanged}`);
  if (totalChanged > 0) {
    console.log("ℹ️ نسخة احتياطية من كل ملف اتعدّل محفوظة بجانبه بامتداد .before-reconcile.bak");
  }
}

main();
