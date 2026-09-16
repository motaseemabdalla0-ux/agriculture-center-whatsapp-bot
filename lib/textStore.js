const fs = require("fs");
const path = require("path");

const STORE_FILE = path.join(__dirname, "..", "text_overrides.json");

// الأسماء اللي المستخدم بيكتبها في واتساب، ومقابلها المفتاح الحقيقي في config.js
const LABELS = {
  "القائمة": "MAIN_MENU",
  "القائمة الرئيسية": "MAIN_MENU",
  "رسالة الموظف": "HUMAN_HANDOFF",
  "رسالة التحويل": "HUMAN_HANDOFF",
  "رسالة خارج الدوام": "HUMAN_HANDOFF_OUT_OF_HOURS",
  "رسالة الشكاوى": "COMPLAINT_INTRO",
  "رسالة الشكر": "COMPLAINT_THANKS",
  "رابط التسجيل": "REGISTRATION_LINK",
};

function load() {
  if (!fs.existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(overrides) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(overrides, null, 2), "utf8");
}

// بيرجع النص المُعدَّل لو موجود، وإلا النص الافتراضي من config.js
function getText(cfg, key) {
  const overrides = load();
  return overrides[key] !== undefined ? overrides[key] : cfg[key];
}

function setOverride(key, value) {
  const overrides = load();
  overrides[key] = value;
  save(overrides);
}

function clearOverride(key) {
  const overrides = load();
  delete overrides[key];
  save(overrides);
}

function keyFromLabel(label) {
  return LABELS[label.trim()] || null;
}

function labelsList() {
  return [...new Set(Object.keys(LABELS))];
}

module.exports = { getText, setOverride, clearOverride, keyFromLabel, labelsList, load };
