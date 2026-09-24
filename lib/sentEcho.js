// أحيانًا واتساب ويب بيبعت للبوت حدث "رسالة واردة" (fromMe=false) هو في الحقيقة صدى (Echo) لرسالة
// البوت نفسه لسه مبعوتها للمزارع - خصوصًا مع اختلاف معرّف @lid/@c.us. من غير حماية، البوت كان
// بيعامل نص رسالته (زي إشعار الاستلام) كأنه رسالة من المزارع ويرد عليه بالقائمة الرئيسية فورًا.
// هنا بنفتكر نصوص الرسائل اللي بعتها البوت من شوية، ونتجاهل أي رسالة واردة نصها مطابق لها.
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;
const MIN_LENGTH = 8; // نص أقصر من كده (زي "1") مش بنعتبره صدى أبدًا، عشان ماناخدش ردود قصيرة حقيقية

const recent = new Map(); // نص موحّد -> وقت الإرسال

function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function prune(now) {
  for (const [key, at] of recent) {
    if (now - at > TTL_MS) recent.delete(key);
  }
  while (recent.size > MAX_ENTRIES) recent.delete(recent.keys().next().value);
}

function remember(text, now = Date.now()) {
  const key = normalize(text);
  if (key.length < MIN_LENGTH) return;
  recent.set(key, now);
  prune(now);
}

function isEcho(text, now = Date.now()) {
  const key = normalize(text);
  if (key.length < MIN_LENGTH) return false;
  const at = recent.get(key);
  return at !== undefined && now - at <= TTL_MS;
}

function clear() {
  recent.clear();
}

module.exports = { remember, isEcho, clear, TTL_MS };
