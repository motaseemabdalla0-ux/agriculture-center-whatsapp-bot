const fs = require("fs");
const path = require("path");

// البوت بيكتب bot_heartbeat.json كل فترة قصيرة طول ما هو شغّال وواصل بواتساب (تكامل بسيط
// جدًا في index.js - سطر واحد وقت "ready" + Interval صغير، من غير أي لمس لمنطق الأمان/الحالة).
// الفحص هنا بيتأكد إن الملف اتحدّث *بعد* وقت إعادة التشغيل بفترة معقولة - مش بس إنه موجود
// (ملف قديم من قبل التحديث ميعتبرش صحة سليمة)
const HEARTBEAT_FILE = path.join(__dirname, "..", "bot_heartbeat.json");

function readHeartbeat() {
  if (!fs.existsSync(HEARTBEAT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8"));
  } catch {
    return null;
  }
}

// بيستنى لحد timeoutMs أو لحد ما يلاقي heartbeat جديد بعد restartedAt (بيتفحص كل pollMs)
async function waitForHealthy(restartedAt, { timeoutMs = 90000, pollMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hb = readHeartbeat();
    if (hb && hb.updatedAt && new Date(hb.updatedAt).getTime() >= restartedAt) {
      return { healthy: true, heartbeat: hb };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { healthy: false, heartbeat: readHeartbeat() };
}

module.exports = { readHeartbeat, waitForHealthy, HEARTBEAT_FILE };
