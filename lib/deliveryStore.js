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

// بيتأكد هل اسم مجموعة واتساب فعليًا بيذكر اسم المنطقة المفروض تكون مربوطة بيها (زي "توصيل
// بطاقات - الشمال" لمنطقة NORTH) - عشان نلاقط غلطة ربط مجموعة بمنطقة غلط بدري. بيقارن بالكلمة
// المجرّدة ("شمال" من غير "ال") عشان يشتغل مع أي صياغة اسم (مع أو من غير أداة التعريف)
function groupNameMatchesRegion(regionKey, groupName) {
  const region = REGION_BY_KEY[regionKey];
  if (!region || !groupName) return false;
  const bareWord = region.ar.replace(/^ال/, "");
  return String(groupName).includes(bareWord);
}

function defaultState() {
  return { groups: {}, pending: {}, lidMap: {}, requests: [], nextId: 1, regionStaff: {}, reportRecipients: [], reportExcluded: [] };
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

// كل الأرقام اللي لسه في حالة انتظار (أي خطوة: CHOICE/REGION/LOCATION/DATETIME) وما نتهيتش
// TTL بتاعتها - يعني استلموا إشعار جاهزية البطاقة وما حسموش استلام/توصيل لحد دلوقتي. بيُستخدم
// في إعادة إرسال إشعار الاستلام لهم تحديدًا (زي لو النص الرسمي اتحدّث)
function getAllPending() {
  const { pending } = load();
  const now = Date.now();
  return Object.entries(pending)
    .filter(([, entry]) => now - entry.sentAt <= PENDING_TTL_MS)
    .map(([phone, entry]) => ({ phone, ...entry }));
}

function getPending(phone) {
  const entry = load().pending[phone];
  if (!entry) return null;
  if (Date.now() - entry.sentAt > PENDING_TTL_MS) return null;
  return entry;
}

function setPendingStep(phone, step, extra = {}) {
  const state = load();
  if (!state.pending[phone]) return;
  Object.assign(state.pending[phone], { step }, extra);
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

// مجموعة "التوصيل" العامة: بتستلم نسخة من كل طلب توصيل جديد (أي منطقة) فور وصوله + تحديثات التسليم،
// بجانب مجموعة منطقته (مابتغيّرش مسار الطلب الأصلي). بتتربط بأمر "ربط مجموعة الكل" جوّه المجموعة نفسها
// المجموعة العامة بتستلم المناطق دي بس (الشمال والوسط) - الجنوب مابيتنسخش
const MIRROR_REGIONS = ["NORTH", "CENTER"];
const isMirrorRegion = (regionKey) => MIRROR_REGIONS.includes(regionKey);

function setMirrorGroup(groupId) {
  const state = load();
  state.mirrorGroup = groupId;
  save(state);
}

function getMirrorGroup() {
  return load().mirrorGroup || null;
}

function clearMirrorGroup() {
  const state = load();
  const had = !!state.mirrorGroup;
  delete state.mirrorGroup;
  save(state);
  return had;
}

// علامة إن نسخة الطلب اتبعتت للمجموعة العامة (عشان إعادة محاولة الإرسال لمجموعة المنطقة ماتكررهاش)
function markMirrored(id) {
  const state = load();
  const r = state.requests.find((x) => x.id === id);
  if (!r) return;
  r.mirrored = true;
  save(state);
}

// إزالة الربط بس (مش حذف المجموعات الفعلية من واتساب) - عشان "انشاء مجموعات التوصيل" يقدر
// ينشئ مجموعات جديدة تاني من غير ما يترفض بسبب وجود ربط قديم
function clearGroups() {
  const state = load();
  state.groups = {};
  save(state);
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

// موظف مخصّص لمنطقة توصيل معينة (يُستخدم كعضو في مجموعة تلك المنطقة بس عند "انشاء مجموعات
// التوصيل" - منفصل عن قائمة موظفي خدمة المزارعين العامة في staffStore)
function assignRegionStaff(regionKey, phone) {
  if (!REGION_BY_KEY[regionKey]) throw new Error(`منطقة غير معروفة: ${regionKey}`);
  const state = load();
  if (!Array.isArray(state.regionStaff[regionKey])) state.regionStaff[regionKey] = [];
  if (state.regionStaff[regionKey].includes(phone)) return false;
  state.regionStaff[regionKey].push(phone);
  save(state);
  return true;
}

function removeRegionStaff(regionKey, phone) {
  const state = load();
  const list = state.regionStaff[regionKey] || [];
  const before = list.length;
  state.regionStaff[regionKey] = list.filter((p) => p !== phone);
  save(state);
  return state.regionStaff[regionKey].length < before;
}

function getRegionStaff(regionKey) {
  return load().regionStaff[regionKey] || [];
}

function getAllRegionStaff() {
  return load().regionStaff;
}

// أرقام مسجّلة خصيصًا لاستقبال تقرير طلبات التوصيل اليومي (مقسّم شمال/جنوب/وسط) - منفصل تمامًا
// عن قائمة مديري التقرير اليومي العام (adminStore) ومستلمي "رسائلي"
function addReportRecipient(phone) {
  const state = load();
  if (!Array.isArray(state.reportRecipients)) state.reportRecipients = [];
  if (state.reportRecipients.includes(phone)) return false;
  state.reportRecipients.push(phone);
  save(state);
  return true;
}

function removeReportRecipient(phone) {
  const state = load();
  const list = state.reportRecipients || [];
  const before = list.length;
  state.reportRecipients = list.filter((p) => p !== phone);
  save(state);
  return state.reportRecipients.length < before;
}

function getReportRecipients() {
  return load().reportRecipients || [];
}

// موظف/موظفو تجهيز البطاقات لفرق التسليم - بيستلموا يوميًا قائمة البطاقات المطلوب تجهيزها لكل
// منطقة (منفصلين عن مستقبلي تقرير التوصيل)
function addPrepRecipient(phone) {
  const state = load();
  if (!Array.isArray(state.prepRecipients)) state.prepRecipients = [];
  if (state.prepRecipients.includes(phone)) return false;
  state.prepRecipients.push(phone);
  save(state);
  return true;
}

function removePrepRecipient(phone) {
  const state = load();
  const before = (state.prepRecipients || []).length;
  state.prepRecipients = (state.prepRecipients || []).filter((p) => p !== phone);
  save(state);
  return state.prepRecipients.length < before;
}

function getPrepRecipients() {
  return load().prepRecipients || [];
}

// مستقبلو "تقارير التسليم المجدولة" (الأحد والأربعاء: 8 ص كشف طلبات التوصيل، 2 م كشف البطاقات اللي اتوصّلت)
// + علامات "اتبعت" لكل (يوم + فترة + رقم) عشان ما يتكررش بعد إعادة تشغيل البوت
function addScheduleRecipient(phone) {
  const state = load();
  if (!Array.isArray(state.scheduleRecipients)) state.scheduleRecipients = [];
  if (state.scheduleRecipients.includes(phone)) return false;
  state.scheduleRecipients.push(phone);
  save(state);
  return true;
}

function removeScheduleRecipient(phone) {
  const state = load();
  const before = (state.scheduleRecipients || []).length;
  state.scheduleRecipients = (state.scheduleRecipients || []).filter((p) => p !== phone);
  save(state);
  return state.scheduleRecipients.length < before;
}

function getScheduleRecipients() {
  return load().scheduleRecipients || [];
}

function wasScheduleSent(key) {
  return !!(load().scheduleSent || {})[key];
}

function markScheduleSent(key) {
  const state = load();
  const sent = state.scheduleSent || {};
  sent[key] = new Date().toISOString();
  const keys = Object.keys(sent).sort();
  while (keys.length > 60) delete sent[keys.shift()]; // ما نكبّرش الملف
  state.scheduleSent = sent;
  save(state);
}

// طلبات مستبعدة من التقرير الكامل (طلبات تجريبية مثلًا) - مش بتتحذف، بس مابتدخلش في الأرقام
function excludeFromReports(id) {
  const state = load();
  if (!Array.isArray(state.reportExcluded)) state.reportExcluded = [];
  const key = String(id).toUpperCase();
  if (state.reportExcluded.includes(key)) return false;
  state.reportExcluded.push(key);
  save(state);
  return true;
}

function getReportExcluded() {
  return load().reportExcluded || [];
}

function getAllRequests() {
  return load().requests;
}

function createRequest({ phone, name, regionKey, district, autoDetected, preferredDateTime, latitude, longitude, platformRequestNumber }) {
  const state = load();
  const request = {
    id: `D-${state.nextId}`,
    phone,
    name: name || "",
    regionKey,
    district: district || null, // اسم المنطقة الزراعية الفعلية (لو اتحدّدت من موقع، لأغراض التدقيق)
    autoDetected: !!autoDetected, // true لو المنطقة اتحددت تلقائيًا من موقع المزارع، مش اختيار يدوي
    preferredDateTime: preferredDateTime || "",
    platformRequestNumber: platformRequestNumber || null, // رقم الطلب في المنصة (Form Number) لو معروف وقت التسجيل // اليوم/الوقت المفضّل اللي كتبه المزارع، للتنسيق معه
    latitude: typeof latitude === "number" ? latitude : null, // إحداثيات الموقع الفعلي اللي بعته المزارع (لو بعت موقع، مش رقم منطقة يدوي) - عشان نبعتها كـpin حقيقي للمجموعة
    longitude: typeof longitude === "number" ? longitude : null,
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

// كل أرقام المزارعين اللي تواصلوا مع البوت فعلًا (رسالة واردة اتترجم معرّفها لجوال، أو عندهم طلب توصيل،
// أو في حالة انتظار رد) - بيُستخدم لحصر الاستبيان على اللي سبق ردّوا
function getKnownReplierPhones() {
  const s = load();
  const out = new Set(Object.values(s.lidMap || {}));
  (s.requests || []).forEach((r) => r.phone && out.add(r.phone));
  // حالة CHOICE معناها إننا بس بعتنا إشعار الاستلام (ما ردّش لسه) - بس الخطوات اللي بعدها (REGION/DATETIME) معناها إنه ردّ
  Object.entries(s.pending || {}).forEach(([p, e]) => {
    if (e && e.step && e.step !== "CHOICE") out.add(p);
  });
  return out;
}

// أحدث طلب توصيل غير مُسلَّم (جديد أو اتسجّل تعذّر) لكل جوال في القائمة - للتحويل لموظف توصيل بعينه
function findOpenRequestsByPhones(phones) {
  const all = load().requests;
  const out = {};
  phones.forEach((phone) => {
    const mine = all.filter((r) => r.phone === phone && r.status !== "DELIVERED");
    out[phone] = mine.length ? mine[mine.length - 1] : null;
  });
  return out;
}

// تسجيل إن الطلب اتحوّل لموظف توصيل معيّن (للمتابعة فقط - مابيغيّرش حالة الطلب)
function markAssigned(id, staffPhone) {
  const state = load();
  const r = state.requests.find((x) => x.id === String(id).toUpperCase());
  if (!r) return false;
  r.assignedTo = staffPhone;
  r.assignedAt = new Date().toISOString();
  save(state);
  return true;
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

function findRequest(id) {
  return load().requests.find((x) => x.id === String(id).toUpperCase()) || null;
}

// تعذّر التسليم (موظف التوصيل بلّغ) - بيخرج الطلب من "المفتوحة" عشان ما يتكررش في التقارير
// اليومية، ومحفوظ بسبب الفشل لو الإدارة احتاجت ترجع له. بيرجّع الطلب، أو null لو مش موجود/اتقفل
function markFailed(id, reason) {
  const state = load();
  const r = state.requests.find((x) => x.id === String(id).toUpperCase());
  if (!r || r.status !== "NEW") return null;
  r.status = "FAILED_DELIVERY";
  r.failureReason = reason || "";
  r.failedAt = new Date().toISOString();
  save(state);
  return r;
}

// source: مين سجّل التسليم - "staff" (أمر/رد موظف التوصيل، الافتراضي) أو "portal" (تأكيد من المنصة)
function markDelivered(id, source = "staff") {
  const state = load();
  const r = state.requests.find((x) => x.id === String(id).toUpperCase());
  if (!r || r.status === "DELIVERED") return null;
  r.status = "DELIVERED";
  r.deliveredAt = new Date().toISOString();
  r.deliveredSource = source;
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
  groupNameMatchesRegion,
  templateOffersDelivery,
  markAwaitingChoice,
  hasAnyPending,
  getAllPending,
  getPending,
  setPendingStep,
  clearPending,
  setGroup,
  getGroups,
  clearGroups,
  cacheLid,
  lookupLid,
  assignRegionStaff,
  removeRegionStaff,
  getRegionStaff,
  getAllRegionStaff,
  addReportRecipient,
  removeReportRecipient,
  getReportRecipients,
  addPrepRecipient,
  removePrepRecipient,
  getPrepRecipients,
  MIRROR_REGIONS,
  isMirrorRegion,
  setMirrorGroup,
  getMirrorGroup,
  clearMirrorGroup,
  markMirrored,
  addScheduleRecipient,
  removeScheduleRecipient,
  getScheduleRecipients,
  wasScheduleSent,
  markScheduleSent,
  createRequest,
  findOpenRequestsByPhones,
  getKnownReplierPhones,
  markAssigned,
  excludeFromReports,
  getReportExcluded,
  getAllRequests,
  markForwarded,
  listOpenRequests,
  markDelivered,
  findRequest,
  markFailed,
  formatContact,
};
