const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalizeSaudiPhone } = require("./phoneUtil");

// منع تكرار عام (Global Anti-Duplicate): البصمة = SHA256(رقم موحّد + "|" + نص الرسالة الموحّد)
// - بتمنع إرسال نفس النص لنفس الرقم حتى لو اختلف اسم الحملة، أو كانت رسالة مخصصة، أو اتعمل
// رفع ملف جديد، أو اتعاد تشغيل البرنامج. مش معتمدة على campaignType خالص.
const STORE_FILE = path.join(__dirname, "..", "send_fingerprints.json");
const BACKUP_FILE = `${STORE_FILE}.bak`;
const DEFAULT_TTL_MS = 2 * 60 * 1000; // مهلة الحجز المؤقت (PENDING) - لو البرنامج وقع في نص الإرسال

function normalizeMessageText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildFingerprint(phone, message) {
  const normalizedPhone = normalizeSaudiPhone(phone);
  const normalizedText = normalizeMessageText(message);
  return crypto.createHash("sha256").update(`${normalizedPhone}|${normalizedText}`).digest("hex");
}

function load() {
  if (!fs.existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (err) {
    console.log(`⚠️ ملف send_fingerprints.json تالف (${err.message})، بنجرب النسخة الاحتياطية...`);
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
      } catch {
        // النسخة الاحتياطية كمان تالفة
      }
    }
    console.log(
      "🚨 تعذّر استرجاع نسخة سليمة من send_fingerprints.json - بنبدأ بسجل فاضي (ممكن يسمح بتكرار إرسال مؤقتًا لحد ما تتصلح المشكلة يدويًا)."
    );
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

// حجز ذرّي: قراءة + فحص + كتابة كلهم synchronous من غير أي await في النص - كافي يمنع تداخل
// عمليتين إرسال في نفس اللحظة على نفس البصمة جوّه نفس عملية Node الواحدة (fork mode، مش cluster)
// لأن الـevent loop مش هيدي فرصة لأي كود جافاسكريبت تاني ينفذ بين القراءة والكتابة دول.
function reserve(fingerprint, meta = {}) {
  const state = load();
  const existing = state[fingerprint];
  const now = Date.now();

  if (existing) {
    if (existing.status === "SENT") return { ok: false, reason: "already_sent" };
    if (existing.status === "PENDING" && existing.ttlExpiresAt > now) {
      return { ok: false, reason: "pending" };
    }
    // PENDING منتهي الصلاحية (البرنامج وقع في نص الإرسال قبل كده) - مسموح نحجز تاني
  }

  state[fingerprint] = {
    status: "PENDING",
    ...meta,
    reservedAt: now,
    ttlExpiresAt: now + DEFAULT_TTL_MS,
  };
  save(state);
  return { ok: true };
}

// بعد نجاح client.sendMessage فعليًا بس - مش قبل كده أبدًا
function confirmSent(fingerprint) {
  const state = load();
  if (!state[fingerprint]) return;
  state[fingerprint].status = "SENT";
  state[fingerprint].sentAt = Date.now();
  save(state);
}

// عند فشل الإرسال: بنشيل الحجز فورًا (مش نستنى انتهاء الـTTL) عشان تقدر إعادة المحاولة
// تحصل على طول لو سياسة الـretry سمحت بيها
function release(fingerprint) {
  const state = load();
  if (state[fingerprint] && state[fingerprint].status === "PENDING") {
    delete state[fingerprint];
    save(state);
  }
}

function getEntry(fingerprint) {
  return load()[fingerprint] || null;
}

module.exports = {
  buildFingerprint,
  normalizeMessageText,
  reserve,
  confirmSent,
  release,
  getEntry,
  DEFAULT_TTL_MS,
};
