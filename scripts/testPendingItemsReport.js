process.env.RATE_LIMIT_HOURLY = process.env.RATE_LIMIT_HOURLY || "1000";
process.env.RATE_LIMIT_DAILY = process.env.RATE_LIMIT_DAILY || "1000";
// اختبار تذكير الحالات المعلّقة - قراءة فقط، صفر واتساب، بيرجّع كل ملفات البيانات الحقيقية
// زي ما كانت في الآخر (نجح أو فشل الاختبار).
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = ["tickets.json", "tickets.json.bak", "handoff_state.json", "handoff_state.json.bak", "farmer_state.json", "farmer_state.json.bak", "activity_log.csv"];

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
  const farmerState = require("../lib/farmerState");
  const { logReplyOutcome } = require("../lib/activityLog");
  const { buildPendingItemsReport, formatPendingItemsReport } = require("../lib/pendingItemsReport");

  console.log("\n=== 1) لا توجد أي حالات معلّقة ===");
  {
    const data = buildPendingItemsReport();
    check("1: مفيش تذاكر/تحويلات/فشل ردود/DRAFT", Object.keys(data.byCategory).length === 0 && data.handedOff.length === 0 && data.notReplied.length === 0 && data.draftFarmers.length === 0);
    check("1ب: الرسالة تقول مفيش معلّقات", formatPendingItemsReport(data).includes("مفيش أي حالات معلّقة"));
  }

  console.log("\n=== 2) تذكرة مفتوحة (شكوى) تظهر مجمّعة بالنوع ===");
  {
    ticketStore.createTicket({ farmerName: "أحمد سالم", phone: "0501111111", region: "العلا", category: "COMPLAINT", message: "الأرض متضررة" });
    const closed = ticketStore.createTicket({ farmerName: "خالد", phone: "0502222222", category: "INQUIRY", message: "سؤال" });
    ticketStore.updateTicket(closed.ticket_id, { status: "RESOLVED" });
    const data = buildPendingItemsReport();
    check("2: تذكرة COMPLAINT المفتوحة فقط ظهرت", data.byCategory.COMPLAINT && data.byCategory.COMPLAINT.length === 1);
    check("2ب: التذكرة المُغلقة (RESOLVED) ما ظهرتش", !data.byCategory.INQUIRY);
    const text = formatPendingItemsReport(data);
    check("2ج: النص فيه اسم المزارع ورقمه", text.includes("أحمد سالم") && text.includes("966501111111"));
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

  console.log("\n=== 4) رد فشل إرساله فعليًا (not_replied) ===");
  {
    logReplyOutcome("966504444444@c.us", false);
    let data = buildPendingItemsReport();
    check("4: ظهر كمعلّق", data.notReplied.some((n) => n.phone === "966504444444@c.us"));
    logReplyOutcome("966504444444@c.us", true); // رد ناجح لاحق يصلّح الحالة
    data = buildPendingItemsReport();
    check("4ب: اختفى بعد رد ناجح لاحق (آخر حالة بس هي المعتبرة)", !data.notReplied.some((n) => n.phone === "966504444444@c.us"));
  }

  console.log("\n=== 5) طلب تسجيل ناقص (DRAFT) ===");
  {
    farmerState.upsertState("966505555555", "DRAFT", "portal:test");
    farmerState.upsertState("966506666666", "SUBMITTED", "portal:test"); // مكتمل - مش المفروض يظهر
    const data = buildPendingItemsReport();
    check("5: DRAFT ظهر", data.draftFarmers.some((d) => d.phone === "966505555555"));
    check("5ب: SUBMITTED ما ظهرش", !data.draftFarmers.some((d) => d.phone === "966506666666"));
  }

  console.log("\n=== 6) صفر واتساب / صفر تعديل على أي منطق إرسال ===");
  {
    const src = fs.readFileSync(path.join(ROOT, "lib", "pendingItemsReport.js"), "utf8");
    check("6: الكود قراءة فقط - مفيش sendMessage ولا safeFarmerSend", !/sendMessage|safeFarmerSend/.test(src));
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
