const fs = require("fs");
const path = require("path");
const { readJsonSync, writeJsonAtomicSync } = require("./safeJsonStore");
const { isValidSaudiPhone } = require("./phoneUtil");

// خيار "توصيل البطاقة": مزارع وصله إشعار جاهزية البطاقة (فيه خيارين: 1 استلام من المركز، 2 توصيل)،
// ورده بيتفسّر حسب حالة انتظار محفوظة هنا (مش قائمة البوت الرئيسية - عشان "2" مثلًا مايتحولش لموظف
// بالغلط). المنطقة (شمال/جنوب/وسط) بتحدد أنهي مجموعة واتساب تتبعتلها بيانات التوصيل.
const STORE_FILE = path.join(__dirname, "..", "delivery_state.json");
const BACKUP_FILE = `${STORE_FILE}.bak`;
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // حالة الانتظار بتنتهي بعد 7 أيام (عشان "1"/"2" بعد مدة طويلة ترجع لقائمة البوت العادية)

const REGIONS = {
  1: { key: "NORTH", ar: "الشمال" },
  2: { key: "SOUTH", ar: "الجنوب" },
  3: { key: "CENTER", ar: "الوسط" },
};
const REGION_BY_KEY = Object.fromEntries(Object.values(REGIONS).map((r) => [r.key, r]));
const REGION_BY_WORD = { الشمال: "NORTH", الجنوب: "SOUTH", الوسط: "CENTER" };

function defaultState() {
  return { groups: {}, pending: {}, lidMap: {}, requests: [], nextId: 1 };
}

function load() {
  if (!fs.existsSync(STORE_FILE) && !fs.existsSync(BACKUP_FILE)) return defaultState();
  return { ...defaultState(), ...readJsonSync(STORE_FILE, BACKUP_FILE, defaultState) };
}

function save(state) {
  writeJsonAtomicSync(STORE_FILE, BACKUP_FILE, state);
}

// حالة الانتظار بتتفعّل بس لو نص الرسالة المُرسلة فعلًا بيعرض خيار التوصيل - غير كده رد المزارع
// "1"/"2" على رسالة استلام قديمة (من غير خيارات) هيتعامل زي أي رد عادي على القائمة الرئيسية
function templateOffersDelivery(template) {
  return /توصيل/.test(String(template || ""));
}

function markAwaitingChoice(phone, name) {
  const state = load();
  state.pending[phone] = { name: name || "", sentAt: Date.now(), step: "CHOICE" };
  save(state);
}

function hasAnyPending() {
  return Object.keys(load().pending).length > 0;
}

function getPending(phone) {
  const entry = load().pending[phone];
  if (!entry) return null;
  if (Date.now() - entry.sentAt > PENDING_TTL_MS) return null;
  return entry;
}

function setPendingStep(phone, step) {
  const state = load();
  if (!state.pending[phone]) return;
  state.pending[phone].step = step;
  save(state);
}

function clearPending(phone) {
  const state = load();
  if (!state.pending[phone]) return;
  delete state.pending[phone];
  save(state);
}

function setGroup(regionKey, groupId) {
  if (!REGION_BY_KEY[regionKey]) throw new Error(`منطقة غير معروفة: ${regionKey}`);
  const state = load();
  state.groups[regionKey] = groupId;
  save(state);
}

function getGroups() {
  return load().groups;
}

// ذاكرة صغيرة لمعرّفات @lid اللي اتترجمت بنجاح لرقم جوال حقيقي (عشان منسألش واتساب كل مرة)
function cacheLid(lid, phone) {
  const state = load();
  state.lidMap[lid] = phone;
  save(state);
}

function lookupLid(lid) {
  return load().lidMap[lid] || null;
}

function createRequest({ phone, name, regionKey }) {
  const state = load();
  const request = {
    id: `D-${state.nextId}`,
    phone,
    name: name || "",
    regionKey,
    status: "NEW",
    createdAt: new Date().toISOString(),
    forwarded: false,
    forwardError: null,
  };
  state.nextId++;
  state.requests.push(request);
  save(state);
  return request;
}

function markForwarded(id, ok, error) {
  const state = load();
  const r = state.requests.find((x) => x.id === id);
  if (!r) return;
  r.forwarded = !!ok;
  r.forwardError = ok ? null : error || "unknown";
  save(state);
}

function listOpenRequests() {
  return load().requests.filter((r) => r.status === "NEW");
}

function markDelivered(id) {
  const state = load();
  const r = state.requests.find((x) => x.id === String(id).toUpperCase());
  if (!r || r.status === "DELIVERED") return null;
  r.status = "DELIVERED";
  r.deliveredAt = new Date().toISOString();
  save(state);
  return r;
}

function formatContact(phone) {
  return isValidSaudiPhone(phone) ? `https://wa.me/${phone}` : phone;
}

module.exports = {
  REGIONS,
  REGION_BY_KEY,
  REGION_BY_WORD,
  STORE_FILE,
  templateOffersDelivery,
  markAwaitingChoice,
  hasAnyPending,
  getPending,
  setPendingStep,
  clearPending,
  setGroup,
  getGroups,
  cacheLid,
  lookupLid,
  createRequest,
  markForwarded,
  listOpenRequests,
  markDelivered,
  formatContact,
};
