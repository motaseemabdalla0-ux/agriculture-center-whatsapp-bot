const path = require("path");
const fs = require("fs");
const { writeJsonAtomicSync } = require("./safeJsonStore");

// مكتبة رسائل جاهزة (عنوان + نص) تُدار من لوحة التحكم، لنسخها واستخدامها كرسالة في حملة "رسائل مخصصة".
// منفصلة عن نصوص البوت الأساسية (textStore) فإضافة/حذف رسالة هنا لا يغيّر أي رد تلقائي.
const STORE_FILE = path.join(__dirname, "..", "message_library.json");
const MAX_ITEMS = 200;
const MAX_TEXT = 4000;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function save(items) {
  writeJsonAtomicSync(STORE_FILE, null, { items });
}

function clean(input) {
  const title = String(input.title || "").trim();
  const text = String(input.text || "").replace(/\r\n/g, "\n").trim();
  if (!title) throw new Error("العنوان مطلوب");
  if (!text) throw new Error("نص الرسالة مطلوب");
  if (title.length > 80) throw new Error("العنوان أطول من 80 حرفًا");
  if (text.length > MAX_TEXT) throw new Error(`النص أطول من ${MAX_TEXT} حرف`);
  return { title, text };
}

function list() {
  return load();
}

function add(input) {
  const items = load();
  if (items.length >= MAX_ITEMS) throw new Error("وصلت للحد الأقصى لعدد الرسائل في المكتبة");
  const item = { id: `m${Date.now()}`, ...clean(input), updatedAt: new Date().toISOString() };
  items.push(item);
  save(items);
  return item;
}

function update(id, input) {
  const items = load();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...clean(input), updatedAt: new Date().toISOString() };
  save(items);
  return items[idx];
}

function remove(id) {
  const items = load();
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return false;
  save(next);
  return true;
}

module.exports = { list, add, update, remove, STORE_FILE };
