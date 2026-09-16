const fs = require("fs");
const path = require("path");

// تخزين دائم لحالة "تم التحويل لموظف" (HANDED_OFF) بس - باقي حالات الجلسة (MENU/AWAITING_COMPLAINT)
// فضلت في الذاكرة (sessions Map في index.js) لأنها قصيرة العمر وقليلة الخطورة لو اتصفرت بعد
// إعادة تشغيل. لكن HANDED_OFF لازم يفضل محفوظ عشان إعادة تشغيل البوت متردّش المحادثة تلقائيًا
// لقائمة المزارع الرئيسية وسط تحويلها لموظف بشري.
const STORE_FILE = path.join(__dirname, "..", "handoff_state.json");
const BACKUP_FILE = `${STORE_FILE}.bak`;

function load() {
  if (!fs.existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
      } catch {
        // النسخة الاحتياطية كمان تالفة
      }
    }
    return {};
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
  fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

function isHandedOff(chatId) {
  return !!load()[chatId];
}

function setHandedOff(chatId, meta = {}) {
  const state = load();
  state[chatId] = { handedOffAt: new Date().toISOString(), ...meta };
  save(state);
}

// بيستخدمها موظف الخدمة عشان يرجّع البوت يرد تلقائيًا تاني على مزارع معيّن بعد ما خلص معاه
function resumeBot(chatId) {
  const state = load();
  if (!state[chatId]) return false;
  delete state[chatId];
  save(state);
  return true;
}

module.exports = { isHandedOff, setHandedOff, resumeBot };
