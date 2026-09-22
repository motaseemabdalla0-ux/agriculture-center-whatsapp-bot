process.env.RATE_LIMIT_HOURLY = process.env.RATE_LIMIT_HOURLY || "1000";
process.env.RATE_LIMIT_DAILY = process.env.RATE_LIMIT_DAILY || "1000";
// اختبار تذكير الحالات المعلّقة (مبسّط: تحويل لموظف / مستندات معلّقة / شكوى-اقتراح) - قراءة
// فقط، صفر واتساب، بيرجّع كل ملفات البيانات الحقيقية زي ما كانت في الآخر (نجح أو فشل الاختبار).
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = ["tickets.json", "tickets.json.bak", "handoff_state.json", "handoff_state.json.bak", "activity_log.csv"];

function snapshot() {
  const s = {};
  DATA_FILES.forEach((n) => {
    const p = path.join(ROOT, n);
    s[n] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  });
  return s;
}
function restore(s) {
  DATA_FILES.forEach((n) => {
    const p = path.join(ROOT, n);
    if (s[n] === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else fs.writeFileSync(p, s[n]);
  });
}
function wipe() {
  DATA_FILES.forEach((n) => {
    const p = path.join(ROOT, n);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
}

let passed = 0;
function check(label, cond) {
  assert(cond, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
}

const snap = snapshot();
wipe();

try {
  const ticketStore = require("../lib/ticketStore");
  const sessionStore = require("../lib/sessionStore");
  const { logEvent } = require("../lib/activityLog");
  const { buildPendingItemsReport, formatPendingItemsReport } = require("../lib/pendingItemsReport");

  console.log("\n=== 1) لا توجد أي حالات معلّقة ===");
  {
    const data = buildPendingItemsReport();
    check("1: مفيش تذاكر/تحويلات/مستندات معلّقة", data.openTickets.length === 0 && data.handedOff.length === 0 && data.pendingDocuments.length === 0);
    check("1ب: الرسالة تقول مفيش معلّقات", formatPendingItemsReport(data).includes("مفيش أي حالات معلّقة"));
  }

  console.log("\n=== 2) تذكرة شكوى/اقتراح مفتوحة، والاستفسار مش ظاهر ===");
  {
    ticketStore.createTicket({ farmerName: "أحمد سالم", phone: "0501111111", region: "العلا", category: "COMPLAINT", message: "الأرض متضررة فعلًا" });
    ticketStore.createTicket({ farmerName: "سارة", phone: "0507777777", category: "SUGGESTION", message: "اقتراح لتحسين الخدمة" });
    const inquiry = ticketStore.createTicket({ farmerName: "خالد", phone: "0502222222", category: "INQUIRY", message: "سؤال عن الموعد" });
    const closed = ticketStore.createTicket({ farmerName: "منيف", phone: "0508888888", category: "COMPLAINT", message: "تم حلها بالفعل" });
    ticketStore.updateTicket(closed.ticket_id, { status: "RESOLVED" });
    const data = buildPendingItemsReport();
    check("2: شكوى + اقتراح المفتوحين ظهروا (2)", data.openTickets.length === 2);
    check("2ب: الاستفسار (INQUIRY) ما ظهرش", !data.openTickets.some((t) => t.ticket_id === inquiry.ticket_id));
    check("2ج: الشكوى المُغلقة (RESOLVED) ما ظهرتش", !data.openTickets.some((t) => t.ticket_id === closed.ticket_id));
    const text = formatPendingItemsReport(data);
    check("2د: النص فيه اسم المزارع ونوع الطلب بالعربي", text.includes("أحمد سالم") && text.includes("اقتراح"));
  }

  console.log("\n=== 3) محوّل لموظف ولسه ما اتقفلش ===");
  {
    sessionStore.setHandedOff("966503333333@c.us");
    const data = buildPendingItemsReport();
    check("3: ظهر في القائمة", data.handedOff.length === 1 && data.handedOff[0].chatId === "966503333333@c.us");
    sessionStore.resumeBot("966503333333@c.us");
    const data2 = buildPendingItemsReport();
    check("3ب: اختفى بعد resumeBot (اتقفل)", data2.handedOff.length === 0);
  }

  console.log("\n=== 4) مزارع بعت مستند ولسه محدش تفاعل معاه ===");
  {
    logEvent("message_in", "966504444444@c.us");
    logEvent("document_received", "966504444444@c.us");
    let data = buildPendingItemsReport();
    check("4: ظهر كمعلّق (آخر حدث ليه document_received)", data.pendingDocuments.some((d) => d.phone === "966504444444@c.us"));
    logEvent("replied", "966504444444@c.us"); // تفاعل لاحق (رد/اختيار) يصلّح الحالة
    data = buildPendingItemsReport();
    check("4ب: اختفى بعد أي حدث لاحق لنفس الرقم", !data.pendingDocuments.some((d) => d.phone === "966504444444@c.us"));
  }

  console.log("\n=== 5) صفر واتساب / صفر تعديل على أي منطق إرسال ===");
  {
    const src = fs.readFileSync(path.join(ROOT, "lib", "pendingItemsReport.js"), "utf8");
    check("5: الكود قراءة فقط - مفيش sendMessage ولا safeFarmerSend", !/sendMessage|safeFarmerSend/.test(src));
  }

  console.log(`\n🎉 كل اختبارات تذكير المعلّقات نجحت (${passed} اختبار). صفر رسائل واتساب.`);
  wipe();
  restore(snap);
  console.log("♻️ تم استرجاع كل ملفات البيانات الحقيقية زي ما كانت قبل الاختبار.");
} catch (err) {
  console.error("💥 فشل الاختبار:", err.message);
  wipe();
  restore(snap);
  console.log("♻️ تم استرجاع كل ملفات البيانات الحقيقية (بعد فشل).");
  process.exit(1);
}
