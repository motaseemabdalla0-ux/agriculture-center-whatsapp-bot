const fs = require("fs");
const sendLog = require("./sendLog");
const { parseCsv } = require("./csvUtil");
const { safeFarmerSend } = require("./safeFarmerSend");

const MIN_DELAY_SEC = 4;
const MAX_DELAY_SEC = 9;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  const sec = MIN_DELAY_SEC + Math.random() * (MAX_DELAY_SEC - MIN_DELAY_SEC);
  return Math.round(sec * 1000);
}

// بيقرأ ملف CSV محترم الاقتباسات (RFC4180 تقريبًا) عن طريق csvUtil.parseCsv بدل التقسيم
// الساذج على الفاصلة والسطر الجديد مباشرة - القارئ القديم كان بيقطع/يزحلق الأعمدة لو الاسم
// أو الرسالة فيها فاصلة. بيتجاهل الصفوف الفاضية والصفوف اللي أول حقل فيها يبدأ بـ #
function loadCsvRows(csvPath, columns) {
  let raw = fs.readFileSync(csvPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // إزالة BOM لو موجود (بيضيفه إكسل تلقائيًا)

  const parsedRows = parseCsv(raw).filter(
    (parts) => parts.length > 1 || (parts[0] || "").trim()
  );
  const dataRows = parsedRows.filter((parts) => !(parts[0] || "").trim().startsWith("#"));

  return dataRows.map((parts) => {
    const row = {};
    columns.forEach((col, i) => {
      row[col] = (parts[i] || "").trim();
    });
    return row;
  });
}

function fillTemplate(template, row) {
  const filled = template.replace(/\{(\w+)\}/g, (match, key) =>
    row[key] !== undefined ? row[key] : match
  );
  // بيحوّل رمز "\n" النصي (مكتوب بالغلط في ملف الـCSV عشان يفضل الصف سطر واحد) لسطر جديد حقيقي
  // وقت الإرسال الفعلي بس - عشان الرسالة تظهر بفقرات ونقاط منسّقة على واتساب
  return filled.replace(/\\n/g, "\n");
}

// يبعت رسالة مخصصة لكل صف في ملف CSV (كل مزارع بياناته الخاصة)
// options: { csvPath, columns, template, logFile, logLabel, campaignType }
// campaignType: لو موجود، بيتأكد إن الرقم ما اتبعتلوش نفس النوع ده قبل كده (حتى لو اتكرر في الملف)
// بيرجع ملخص فعلي {total, sent, failed, notOnWhatsapp, invalidPhone, skippedDuplicate} - عشان
// اللي بيستدعي الدالة (زي حصة الدرافت اليومية) يعرف عدد الإرسال الناجح الحقيقي، مش بس عدد
// الصفوف اللي كانت في الملف (لو فشل نص الإرسال، معندناش داعي نستهلك الحصة كأنها اتبعتت بنجاح)
async function runPersonalizedBroadcast(client, options) {
  const { csvPath, columns, template, logFile, logLabel, campaignType, messageSource = "CAMPAIGN" } = options;
  const summary = { total: 0, sent: 0, failed: 0, notOnWhatsapp: 0, invalidPhone: 0, skippedDuplicate: 0 };

  if (!fs.existsSync(csvPath)) {
    console.log(`⚠️ [${logLabel}] الملف ${csvPath} غير موجود.`);
    return summary;
  }

  const rows = loadCsvRows(csvPath, columns);
  summary.total = rows.length;

  if (rows.length === 0) {
    console.log(`⚠️ [${logLabel}] مفيش بيانات في ${csvPath}.`);
    return summary;
  }

  console.log(`\n📢 [${logLabel}] بدء الإرسال لـ ${rows.length} مزارع...\n`);

  const log = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const phone = (row.phone || "").replace(/[^\d]/g, "");
    const label = row.name || phone;
    process.stdout.write(`[${logLabel}] [${i + 1}/${rows.length}] ${label} (${phone}) ... `);

    const message = fillTemplate(template, row);
    // request_number (لو موجود في عمود الصف) بيتبعت كـapplicationId عشان فحص Stale Application -
    // لو المزارع بقى ليه طلب أحدث من ده، الإشعار القديم ده بيتمنع حتى لو حالته نظريًا بتسمح
    const result = await safeFarmerSend(client, {
      phone,
      name: label,
      message,
      campaignType,
      applicationId: row.request_number || undefined,
      messageSource,
    });

    switch (result.status) {
      case "invalid_phone":
        console.log("❌ رقم جوال فاضي/غير صحيح");
        log.push(`${label} -> رقم جوال فاضي/غير صحيح`);
        sendLog.logSend(logLabel, label, phone, "invalid_phone");
        summary.invalidPhone++;
        break;
      case "blocked_by_state":
        console.log(`🚫 ممنوع - حالة المزارع (${result.state}) بتمنع نوع الرسالة ده`);
        log.push(`${label} (${phone}) -> ممنوع (حالة: ${result.state})`);
        sendLog.logSend(logLabel, label, phone, "skipped_duplicate");
        summary.skippedDuplicate++;
        break;
      case "blocked_stale_application":
        console.log("🚫 ممنوع - الطلب المرتبط بالرسالة دي بقى قديم (فيه طلب أحدث للمزارع ده)");
        log.push(`${label} (${phone}) -> ممنوع (طلب قديم/Stale)`);
        sendLog.logSend(logLabel, label, phone, "skipped_duplicate");
        summary.skippedDuplicate++;
        break;
      case "would_send":
        console.log("🧪 DRY RUN - كان هيتبعت فعليًا");
        break;
      case "duplicate":
        console.log("⏭️ اتجاهل - اتبعتله الرسالة دي قبل كده");
        log.push(`${label} (${phone}) -> اتجاهل (اتبعتله قبل كده)`);
        sendLog.logSend(logLabel, label, phone, "skipped_duplicate");
        summary.skippedDuplicate++;
        break;
      case "rate_limited":
        console.log(`⏸️ وصلنا للحد الأقصى للإرسال (${result.reason}) - هنكمل الباقي بعدها`);
        log.push(`${label} (${phone}) -> إيقاف مؤقت (${result.reason})`);
        summary.failed++;
        break;
      case "not_on_whatsapp":
        console.log("❌ غير مسجل على واتساب");
        log.push(`${label} (${phone}) -> غير مسجل على واتساب`);
        sendLog.logSend(logLabel, label, phone, "not_on_whatsapp");
        summary.notOnWhatsapp++;
        break;
      case "sent":
        console.log("✅ تم الإرسال");
        log.push(`${label} (${phone}) -> تم الإرسال`);
        sendLog.logSend(logLabel, label, phone, "sent");
        summary.sent++;
        break;
      default:
        console.log(`❌ فشل: ${result.reason || result.status}`);
        log.push(`${label} (${phone}) -> فشل: ${result.reason || result.status}`);
        sendLog.logSend(logLabel, label, phone, "failed");
        summary.failed++;
    }

    if (i < rows.length - 1) {
      await sleep(randomDelayMs());
    }
  }

  fs.writeFileSync(
    logFile,
    `تقرير الإرسال (${logLabel}) - ${new Date().toLocaleString("ar-SA")}\n\n` +
      log.join("\n") +
      "\n",
    "utf8"
  );

  console.log(`\n✅ [${logLabel}] انتهى الإرسال. التقرير محفوظ في ${logFile}\n`);
  return summary;
}

module.exports = { runPersonalizedBroadcast, fillTemplate, loadCsvRows };
