const fs = require("fs");
const path = require("path");

const STORE_FILE = path.join(__dirname, "..", "staff_settings.json");

const DEFAULT_STATE = {
  staff: [],
  workingHours: { startMinutes: 8 * 60, endMinutes: 16 * 60 }, // 08:00 - 16:00 افتراضيًا
};

function load() {
  if (!fs.existsSync(STORE_FILE)) return { ...DEFAULT_STATE };
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      staff: Array.isArray(data.staff) ? data.staff : [],
      workingHours:
        data.workingHours && typeof data.workingHours.startMinutes === "number"
          ? data.workingHours
          : { ...DEFAULT_STATE.workingHours },
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function save(state) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function getState() {
  return load();
}

function addStaff(phone) {
  const state = load();
  if (!state.staff.includes(phone)) {
    state.staff.push(phone);
    save(state);
    return true;
  }
  return false;
}

function removeStaff(phone) {
  const state = load();
  const before = state.staff.length;
  state.staff = state.staff.filter((p) => p !== phone);
  save(state);
  return state.staff.length < before;
}

function getStaff() {
  return load().staff;
}

function minutesToHHMM(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// بيقبل صيغ زي "8-16" أو "08:00-16:00" أو "8 الى 16" أو "8 إلى 16:30"
function parseTimeRange(text) {
  const cleaned = text.replace(/إلى|الى|to/gi, "-");
  const match = cleaned.match(/(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?/);
  if (!match) return null;

  const startH = parseInt(match[1], 10);
  const startM = match[2] ? parseInt(match[2], 10) : 0;
  const endH = parseInt(match[3], 10);
  const endM = match[4] ? parseInt(match[4], 10) : 0;

  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return null;

  return { startMinutes: startH * 60 + startM, endMinutes: endH * 60 + endM };
}

function setWorkingHours(startMinutes, endMinutes) {
  const state = load();
  state.workingHours = { startMinutes, endMinutes };
  save(state);
}

// بيتأكد هل الوقت الحالي جوه ساعات الدوام (بيدعم دوام بيعدي منتصف الليل، زي 22-6)
function isWithinWorkingHours(date = new Date()) {
  const { startMinutes, endMinutes } = load().workingHours;
  const nowMinutes = date.getHours() * 60 + date.getMinutes();

  if (startMinutes === endMinutes) return true; // دوام 24 ساعة لو الوقتين متساويين
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // دوام بيعدي منتصف الليل (مثال: من 22:00 لحد 6:00)
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function formatWorkingHours() {
  const { startMinutes, endMinutes } = load().workingHours;
  return `${minutesToHHMM(startMinutes)} - ${minutesToHHMM(endMinutes)}`;
}

module.exports = {
  getState,
  addStaff,
  removeStaff,
  getStaff,
  parseTimeRange,
  setWorkingHours,
  isWithinWorkingHours,
  formatWorkingHours,
  minutesToHHMM,
};
