const fs = require("fs");
const path = require("path");

// تقرير "farmer card" بنسختين: (1) أرقام المنصة الحية كما هي، (2) "مع الكشف": نفس الأرقام + إضافات يدوية
// من كشف لسه ما اترفعش على المنصة (مثلًا +136 قيد المراجعة و+13 انتظار الطباعة). الإضافات بتتحفظ هنا
// بأمر من الأدمن وتتمسح بعد ما الكشف يترفع (المنصة وقتها بتعرضها فعلًا).
const FILE = path.join(__dirname, "..", "farmer_card_adjustments.json");

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { review: Number(s.review) || 0, waitingPrint: Number(s.waitingPrint) || 0, savedAt: s.savedAt || null };
  } catch {
    return { review: 0, waitingPrint: 0, savedAt: null };
  }
}

function save(adj) {
  fs.writeFileSync(FILE, JSON.stringify({ review: adj.review || 0, waitingPrint: adj.waitingPrint || 0, savedAt: new Date().toISOString() }), "utf8");
}

function clear() {
  try {
    fs.unlinkSync(FILE);
  } catch {
    // مفيش ملف - مفيش حاجة تتمسح
  }
}

// "كشف بطاقة المزارع قيد المراجعة 136 انتظار الطباعة 13" -> { review: 136, waitingPrint: 13 } (أو null لو مفيش أرقام)
function parseAdjustmentText(text) {
  const t = String(text || "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const review = t.match(/قيد\s*(?:ال)?مراجعه?(?:ة)?\s*[:=]?\s*\+?(\d+)/);
  const waiting = t.match(/(?:انتظار|تحت|في\s*انتظار)\s*(?:ال)?طباعه?(?:ة)?\s*[:=]?\s*\+?(\d+)/);
  if (!review && !waiting) return null;
  return { review: review ? parseInt(review[1], 10) : 0, waitingPrint: waiting ? parseInt(waiting[1], 10) : 0 };
}

// بيضيف الإضافات على إحصائيات المنصة (نسخة جديدة، مش بيعدّل الأصل)
function applyAdjustments(stats, adj) {
  return {
    ...stats,
    pendingReview: (stats.pendingReview || 0) + (adj.review || 0),
    pendingPrinting: (stats.pendingPrinting || 0) + (adj.waitingPrint || 0),
  };
}

module.exports = { load, save, clear, parseAdjustmentText, applyAdjustments, FILE };
