const fs = require("fs");
const path = require("path");
const { writeJsonAtomicSync } = require("./safeJsonStore");

// Rate Limiter مخصّص لرسائل CAMPAIGN بس (راجع lib/safeFarmerSend.js - بينادى بس لو
// messageSource === "CAMPAIGN"؛ SYSTEM_NOTIFICATION وINBOUND_REPLY متعملهمش نداء هنا خالص).
// مش بديل عن التأخير العشوائي 4-9 ثانية بين كل رسالة - ده منفصل وموجود في كل Runner، والاتنين
// بيشتغلوا مع بعض. القيم قابلة للتخصيص من متغيرات البيئة (.env):
//   RATE_LIMIT_HOURLY (افتراضي 50), RATE_LIMIT_DAILY (افتراضي 500),
//   RATE_LIMIT_COOLDOWN_MS (افتراضي 0 = بدون تهدئة إضافية غير التأخير العشوائي الموجود أصلًا)
const STORE_FILE = path.join(__dirname, "..", "rate_limit_state.json");

function getConfig() {
  return {
    hourly: parseInt(process.env.RATE_LIMIT_HOURLY || "50", 10),
    daily: parseInt(process.env.RATE_LIMIT_DAILY || "500", 10),
    cooldownMs: parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || "0", 10),
  };
}

function defaultState() {
  return { hourBucket: null, hourCount: 0, dayBucket: null, dayCount: 0, lastSendAt: 0, paused: false };
}

function load() {
  if (!fs.existsSync(STORE_FILE)) return defaultState();
  try {
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) };
  } catch {
    return defaultState();
  }
}

function save(state) {
  writeJsonAtomicSync(STORE_FILE, null, state);
}

function currentHourBucket(d = new Date()) {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}
function currentDayBucket(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// بيفحص كل الحدود ويحجز فورًا لو مسموح (زيادة العدادات) - قراءة+فحص+كتابة synchronous
// من غير await في النص، عشان تبقى عملية واحدة ذرّية جوّه عملية Node الواحدة
function checkAndReserve() {
  const cfg = getConfig();
  const state = load();

  if (state.paused) return { allowed: false, reason: "paused" };

  const now = Date.now();
  const hourBucket = currentHourBucket();
  const dayBucket = currentDayBucket();

  if (state.hourBucket !== hourBucket) {
    state.hourBucket = hourBucket;
    state.hourCount = 0;
  }
  if (state.dayBucket !== dayBucket) {
    state.dayBucket = dayBucket;
    state.dayCount = 0;
  }

  if (state.hourCount >= cfg.hourly) {
    save(state);
    return { allowed: false, reason: "hourly_limit" };
  }
  if (state.dayCount >= cfg.daily) {
    save(state);
    return { allowed: false, reason: "daily_limit" };
  }
  if (cfg.cooldownMs > 0 && now - state.lastSendAt < cfg.cooldownMs) {
    return { allowed: false, reason: "cooldown" };
  }

  state.hourCount++;
  state.dayCount++;
  state.lastSendAt = now;
  save(state);
  return { allowed: true };
}

function pause() {
  const state = load();
  state.paused = true;
  save(state);
}

function resume() {
  const state = load();
  state.paused = false;
  save(state);
}

function isPaused() {
  return load().paused;
}

// حالة كاملة للعرض (Dashboard/Progress) - كام رسالة Campaign اتبعتت النهارده/الساعة دي، وإمتى
// تتصفّر (عشان "Estimated Resume Time" في تقرير التقدّم). بيقرا بس، ما بيحجزش أي حصة
function getStatus() {
  const cfg = getConfig();
  const state = load();
  const now = new Date();
  const hourBucket = currentHourBucket(now);
  const dayBucket = currentDayBucket(now);

  const hourCount = state.hourBucket === hourBucket ? state.hourCount : 0;
  const dayCount = state.dayBucket === dayBucket ? state.dayCount : 0;

  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);

  const nextDay = new Date(now);
  nextDay.setHours(0, 0, 0, 0);
  nextDay.setDate(nextDay.getDate() + 1);

  return {
    hourly: { used: hourCount, limit: cfg.hourly, remaining: Math.max(0, cfg.hourly - hourCount), resetAt: nextHour.toISOString() },
    daily: { used: dayCount, limit: cfg.daily, remaining: Math.max(0, cfg.daily - dayCount), resetAt: nextDay.toISOString() },
    paused: state.paused,
  };
}

module.exports = { checkAndReserve, getConfig, pause, resume, isPaused, getStatus };
