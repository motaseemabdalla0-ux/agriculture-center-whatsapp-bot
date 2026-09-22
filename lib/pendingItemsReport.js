const ticketStore = require("./ticketStore");
const sessionStore = require("./sessionStore");
const farmerState = require("./farmerState");
const { getPendingReplyFailures } = require("./activityLog");

// تذكير إداري بالحالات المعلّقة اللي محتاجة متابعة بشرية - قراءة فقط من كل الـStores الموجودة،
// مفيش أي كتابة أو تغيير حالة هنا خالص. أربع فئات (زي ما طُلب صراحةً):
//   1) تذاكر مفتوحة (شكوى/استفسار/اقتراح) - status=OPEN في lib/ticketStore.js
//   2) مزارعين اتحوّلوا لموظف (HANDED_OFF) ولسه محدش رد عليهم/قفل المحادثة
//   3) ردود فشل إرسالها فعليًا (not_replied آخر حالة له في activity_log.csv)
//   4) طلبات تسجيل ناقصة - Farmer State = DRAFT
const CATEGORY_AR = { COMPLAINT: "شكاوى", INQUIRY: "استفسارات", SUGGESTION: "اقتراحات" };
const MAX_LISTED = 10;

function buildPendingItemsReport() {
  const openTickets = ticketStore.listTickets({ status: "OPEN" });
  const byCategory = {};
  openTickets.forEach((t) => {
    const key = t.category || "عام";
    if (!byCategory[key]) byCategory[key] = [];
    byCategory[key].push(t);
  });

  const handedOff = sessionStore.getAllHandedOff().sort((a, b) => (a.handedOffAt < b.handedOffAt ? -1 : 1));
  const notReplied = getPendingReplyFailures();
  const draftFarmers = Object.entries(farmerState.getAllStates())
    .filter(([, entry]) => entry.state === "DRAFT")
    .map(([phone, entry]) => ({ phone, ...entry }));

  return { byCategory, handedOff, notReplied, draftFarmers };
}

function formatPendingItemsReport(data) {
  const lines = [`🔔 تذكير بالحالات المعلّقة - ${new Date().toLocaleString("ar-SA")}\n`];

  const ticketCategories = Object.keys(data.byCategory);
  const totalTickets = ticketCategories.reduce((sum, k) => sum + data.byCategory[k].length, 0);
  lines.push(`📋 تذاكر مفتوحة (شكوى/استفسار/اقتراح): ${totalTickets}`);
  ticketCategories.forEach((cat) => {
    const list = data.byCategory[cat];
    lines.push(`  ${CATEGORY_AR[cat] || cat} (${list.length}):`);
    list.slice(0, MAX_LISTED).forEach((t) => lines.push(`    • ${t.ticket_id} - ${t.farmer_name || "بدون اسم"} (${t.phone || "-"}) - ${(t.created_at || "").slice(0, 10)}`));
    if (list.length > MAX_LISTED) lines.push(`    ... و${list.length - MAX_LISTED} تذكرة إضافية`);
  });
  lines.push("");

  lines.push(`👤 محوّلين لموظف ولسه ما اتقفلتش (${data.handedOff.length}):`);
  data.handedOff.slice(0, MAX_LISTED).forEach((h) => lines.push(`    • ${h.chatId.replace(/@.*/, "")} - منذ ${(h.handedOffAt || "").slice(0, 10)}`));
  if (data.handedOff.length > MAX_LISTED) lines.push(`    ... و${data.handedOff.length - MAX_LISTED} إضافيين`);
  lines.push("");

  lines.push(`⚠️ ردود فشل إرسالها فعليًا (${data.notReplied.length}):`);
  data.notReplied.slice(0, MAX_LISTED).forEach((n) => lines.push(`    • ${n.phone.replace(/@.*/, "")} - ${(n.timestamp || "").slice(0, 16).replace("T", " ")}`));
  if (data.notReplied.length > MAX_LISTED) lines.push(`    ... و${data.notReplied.length - MAX_LISTED} إضافيين`);
  lines.push("");

  lines.push(`📝 طلبات تسجيل غير مكتملة (DRAFT): ${data.draftFarmers.length}`);
  data.draftFarmers.slice(0, MAX_LISTED).forEach((d) => lines.push(`    • ${d.phone}${d.lastSeenAt ? ` - آخر ظهور ${d.lastSeenAt.slice(0, 10)}` : ""}`));
  if (data.draftFarmers.length > MAX_LISTED) lines.push(`    ... و${data.draftFarmers.length - MAX_LISTED} إضافيين`);

  const totalPending = totalTickets + data.handedOff.length + data.notReplied.length + data.draftFarmers.length;
  if (totalPending === 0) return "✅ مفيش أي حالات معلّقة حاليًا - كل شيء تمام.";
  return lines.join("\n");
}

module.exports = { buildPendingItemsReport, formatPendingItemsReport };
