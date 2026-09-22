const ticketStore = require("./ticketStore");
const sessionStore = require("./sessionStore");
const { getPendingDocumentSubmissions } = require("./activityLog");

// تذكير إداري مبسّط بأهم الحالات المعلّقة اللي محتاجة متابعة بشرية - قراءة فقط من كل الـStores
// الموجودة، مفيش أي كتابة أو تغيير حالة هنا خالص. ثلاث فئات بس (بعد تبسيط صريح من الإدارة،
// شيلنا فئتي "ردود فشلت تقنيًا" و"تسجيل ناقص DRAFT" لتقليل الضوضاء):
//   1) مزارعين اتحوّلوا لموظف ولسه محدش رد عليهم (HANDED_OFF في sessionStore)
//   2) مزارعين بعتوا مستندات (صور/ملفات) ولسه محدش تفاعل معاهم بعدها (activity_log.csv)
//   3) مزارعين بعتوا شكوى أو اقتراح - تذاكر مفتوحة (COMPLAINT/SUGGESTION بس، مش استفسار)
const TICKET_CATEGORIES_SHOWN = ["COMPLAINT", "SUGGESTION"];
const CATEGORY_AR = { COMPLAINT: "شكوى", SUGGESTION: "اقتراح" };
const MAX_LISTED = 10;

function buildPendingItemsReport() {
  const openTickets = ticketStore.listTickets({ status: "OPEN" }).filter((t) => TICKET_CATEGORIES_SHOWN.includes(t.category));
  const handedOff = sessionStore.getAllHandedOff().sort((a, b) => (a.handedOffAt < b.handedOffAt ? -1 : 1));
  const pendingDocuments = getPendingDocumentSubmissions();

  return { openTickets, handedOff, pendingDocuments };
}

function formatPendingItemsReport(data) {
  const lines = [`🔔 تذكير بالحالات المعلّقة - ${new Date().toLocaleString("ar-SA")}\n`];

  lines.push(`👤 محوّلين لموظف ولم يتم الرد (${data.handedOff.length}):`);
  data.handedOff.slice(0, MAX_LISTED).forEach((h) => lines.push(`    • ${h.chatId.replace(/@.*/, "")} - منذ ${(h.handedOffAt || "").slice(0, 10)}`));
  if (data.handedOff.length > MAX_LISTED) lines.push(`    ... و${data.handedOff.length - MAX_LISTED} إضافيين`);
  if (data.handedOff.length === 0) lines.push("    لا يوجد.");
  lines.push("");

  lines.push(`📎 مزارعين أرسلوا مستندات ولم يتم الرد (${data.pendingDocuments.length}):`);
  data.pendingDocuments.slice(0, MAX_LISTED).forEach((d) => lines.push(`    • ${d.phone.replace(/@.*/, "")} - ${(d.timestamp || "").slice(0, 16).replace("T", " ")}`));
  if (data.pendingDocuments.length > MAX_LISTED) lines.push(`    ... و${data.pendingDocuments.length - MAX_LISTED} إضافيين`);
  if (data.pendingDocuments.length === 0) lines.push("    لا يوجد.");
  lines.push("");

  lines.push(`📋 مزارعين أرسلوا شكوى أو اقتراح (${data.openTickets.length}):`);
  data.openTickets.slice(0, MAX_LISTED).forEach((t) => lines.push(`    • ${t.ticket_id} - ${t.farmer_name || "بدون اسم"} (${t.phone || "-"}) - ${CATEGORY_AR[t.category] || t.category} - ${(t.created_at || "").slice(0, 10)}`));
  if (data.openTickets.length > MAX_LISTED) lines.push(`    ... و${data.openTickets.length - MAX_LISTED} إضافيين`);
  if (data.openTickets.length === 0) lines.push("    لا يوجد.");

  const totalPending = data.handedOff.length + data.pendingDocuments.length + data.openTickets.length;
  if (totalPending === 0) return "✅ مفيش أي حالات معلّقة حاليًا - كل شيء تمام.";
  return lines.join("\n");
}

module.exports = { buildPendingItemsReport, formatPendingItemsReport };
