const fs = require("fs");
const path = require("path");
const { normalizeSaudiPhone } = require("./phoneUtil");

// حالات التذكرة المسموحة - أي قيمة تانية ترفض
const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

// نظام Ticket حقيقي بدل سطر CSV بسيط - كل شكوى/استفسار/اقتراح بياخد رقم مرجعي (ticket_id)
// وحالة (status) وممكن يتعيّن لموظف (assigned_to)
const STORE_FILE = path.join(__dirname, "..", "tickets.json");
const BACKUP_FILE = `${STORE_FILE}.bak`;

function defaultState() {
  return { nextId: 1, tickets: {} };
}

function load() {
  if (!fs.existsSync(STORE_FILE)) return defaultState();
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (err) {
    console.log(`⚠️ ملف tickets.json تالف (${err.message})، بنجرب النسخة الاحتياطية...`);
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
      } catch {
        // النسخة الاحتياطية كمان تالفة
      }
    }
    console.log("🚨 تعذّر استرجاع نسخة سليمة من tickets.json - بنبدأ بسجل فاضي (التذاكر القديمة مش هتضيع من غير رجوع للنسخة الاحتياطية يدويًا).");
    return defaultState();
  }
}

function save(state) {
  const tmp = `${STORE_FILE}.tmp`;
  if (fs.existsSync(STORE_FILE)) {
    try {
      fs.copyFileSync(STORE_FILE, BACKUP_FILE);
    } catch {
      // فشل النسخة الاحتياطية مش سبب كافي نوقف الحفظ
    }
  }
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

// category إلزامية وبتيجي من اختيار صريح للمزارع في القائمة (COMPLAINT/INQUIRY/SUGGESTION)
// - مش استنتاج من كلمات نص الرسالة خالص
function createTicket({ farmerName, phone, category, message }) {
  const state = load();
  const ticketId = `T-${state.nextId}`;
  state.nextId++;
  const now = new Date().toISOString();
  const ticket = {
    ticket_id: ticketId,
    farmer_name: farmerName || "",
    phone: phone ? normalizeSaudiPhone(phone) : "",
    category: category || "عام",
    message: message || "",
    status: "OPEN",
    assigned_to: null,
    created_at: now,
    updated_at: now,
  };
  state.tickets[ticketId] = ticket;
  save(state);
  return ticket;
}

function getTicket(ticketId) {
  return load().tickets[ticketId] || null;
}

function updateTicket(ticketId, patch) {
  const state = load();
  if (!state.tickets[ticketId]) return null;
  if (patch.status && !TICKET_STATUSES.includes(patch.status)) {
    throw new Error(`INVALID_TICKET_STATUS: ${patch.status}`);
  }
  Object.assign(state.tickets[ticketId], patch, { updated_at: new Date().toISOString() });
  save(state);
  return state.tickets[ticketId];
}

function listTickets(filter = {}) {
  const state = load();
  return Object.values(state.tickets).filter((t) => {
    if (filter.status && t.status !== filter.status) return false;
    if (filter.phone && t.phone !== filter.phone) return false;
    return true;
  });
}

module.exports = { createTicket, getTicket, updateTicket, listTickets, TICKET_STATUSES };
