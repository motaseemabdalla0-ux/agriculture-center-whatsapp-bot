const ticketStore = require("./ticketStore");
const sessionStore = require("./sessionStore");
const { getPendingDocumentSubmissions } = require("./activityLog");
const { isValidSaudiPhone } = require("./phoneUtil");

// بيرجع رابط wa.me جاهز للنقر لو الرقم رقم جوال سعودي صحيح فعليًا (بيفتح محادثة واتساب مباشرة
// مع المزارع - سهولة وصول حقيقية للموظف). لو المعرّف مش رقم جوال حقيقي (زي معرّف @lid داخلي
// خام لسه ما اتترجمش لرقم حقيقي - مشكلة معروفة في بعض حسابات واتساب)، بنوضّح ده صراحةً بدل
// ما نبني رابط غلط هيفشل لما الموظف يدوس عليه
function formatContactLine(rawId) {
  const digits = String(rawId || "").replace(/@.*/, "");
  if (isValidSaudiPhone(digits)) return `https://wa.me/${digits}`;
  return `${digits} (معرّف داخلي - افتح المحادثة يدويًا من واتساب، مش رقم قابل للاتصال به مباشرة)`;
}

// تذكير إداري مبسّط بأهم الحالات المعلّقة اللي محتاجة متابعة بشرية - قراءة فقط من كل الـStores
// الموجودة، مفيش أي كتابة أو تغيير حالة هنا خالص. ثلاث فئات بس (بعد تبسيط صريح من الإدارة،
// شيلنا فئتي "ردود فشلت تقنيًا" و"تسجيل ناقص DRAFT" لتقليل الضوضاء):
//   1) مزارعين اتحوّلوا لموظف ولسه محدش رد عليهم (HANDED_OFF في sessionStore)
//   2) مزارعين بعتوا مستندات (صور/ملفات) ولسه محدش تفاعل معاهم بعدها (activity_log.csv)
//   3) مزارعين بعتوا تذكرة مفتوحة - شكوى/استفسار/اقتراح، كل نوع في قسم منفصل
const TICKET_CATEGORIES_SHOWN = ["COMPLAINT", "INQUIRY", "SUGGESTION"];
const CATEGORY_AR = { COMPLAINT: "شكوى", INQUIRY: "استفسار", SUGGESTION: "اقتراح" };
const MAX_LISTED = 10;

function buildPendingItemsReport() {
  const openTickets = ticketStore.listTickets({ status: "OPEN" }).filter((t) => TICKET_CATEGORIES_SHOWN.includes(t.category));
  const handedOff = sessionStore.getAllHandedOff().sort((a, b) => (a.handedOffAt < b.handedOffAt ? -1 : 1));
  const pendingDocuments = getPendingDocumentSubmissions();
  const ticketsByCategory = {};
  TICKET_CATEGORIES_SHOWN.forEach((cat) => {
    ticketsByCategory[cat] = openTickets.filter((t) => t.category === cat);
  });

  return { openTickets, ticketsByCategory, handedOff, pendingDocuments };
}

function formatPendingItemsReport(data) {
  const lines = [`🔔 تذكير بالحالات المعلّقة - ${new Date().toLocaleString("ar-SA")}\n`];

  lines.push(`👤 محوّلين لموظف ولم يتم الرد (${data.handedOff.length}):`);
  data.handedOff.slice(0, MAX_LISTED).forEach((h) => lines.push(`    • ${formatContactLine(h.chatId)} - منذ ${(h.handedOffAt || "").slice(0, 10)}`));
  if (data.handedOff.length > MAX_LISTED) lines.push(`    ... و${data.handedOff.length - MAX_LISTED} إضافيين`);
  if (data.handedOff.length === 0) lines.push("    لا يوجد.");
  lines.push("");

  lines.push(`📎 مزارعين أرسلوا مستندات ولم يتم الرد (${data.pendingDocuments.length}):`);
  data.pendingDocuments.slice(0, MAX_LISTED).forEach((d) => lines.push(`    • ${formatContactLine(d.phone)} - ${(d.timestamp || "").slice(0, 16).replace("T", " ")}`));
  if (data.pendingDocuments.length > MAX_LISTED) lines.push(`    ... و${data.pendingDocuments.length - MAX_LISTED} إضافيين`);
  if (data.pendingDocuments.length === 0) lines.push("    لا يوجد.");
  lines.push("");

  lines.push(`📋 تذاكر مفتوحة (${data.openTickets.length}):`);
  TICKET_CATEGORIES_SHOWN.forEach((cat) => {
    const list = data.ticketsByCategory[cat];
    lines.push(`  ${CATEGORY_AR[cat]} (${list.length}):`);
    list.slice(0, MAX_LISTED).forEach((t) => lines.push(`    • ${t.ticket_id} - ${t.farmer_name || "بدون اسم"} - ${formatContactLine(t.phone)} - ${(t.created_at || "").slice(0, 10)}`));
    if (list.length > MAX_LISTED) lines.push(`    ... و${list.length - MAX_LISTED} إضافية`);
    if (list.length === 0) lines.push("    لا يوجد.");
  });

  const totalPending = data.handedOff.length + data.pendingDocuments.length + data.openTickets.length;
  if (totalPending === 0) return "✅ مفيش أي حالات معلّقة حاليًا - كل شيء تمام.";
  return lines.join("\n");
}

module.exports = { buildPendingItemsReport, formatPendingItemsReport };
