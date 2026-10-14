// أوقات توصيل البطاقات: من 8:00 صباحًا لحد 4:00 عصرًا. بنفهم الوقت من نص المزارع الحر (عربي/إنجليزي،
// أرقام عربية أو هندية) بأقصى جهد ممكن؛ لو مفيش وقت واضح في النص (مثلاً "الأحد" بس) بنقبله لأننا
// مش نقدر نحكم عليه، لكن أي وقت واضح برّه الفترة دي بيترفض (isOutsideDeliveryHours)
const DELIVERY_DAYS = [0, 3]; // الأحد والأربعاء
const START_MINUTES = 8 * 60;
const END_MINUTES = 16 * 60;

const PERIOD = "(صباحا|صباح|مساء|ظهرا|ظهر|عصرا|عصر|مغرب|ليلا|ليل|am|pm|ص|م)";
const NOT_ARABIC_LETTER_AFTER = "(?![\\u0621-\\u064A])";

function normalize(text) {
  return String(text || "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[ً-ٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

// بيرجّع { minutes } (دقائق من منتصف الليل) لأول وقت واضح في النص، أو null لو مفيش
function parseTimeOfDay(rawText) {
  // التواريخ (5/10/2026) مش أوقات - بنشيلها الأول
  const text = normalize(rawText).replace(/\d{1,4}\s*[/\-.]\s*\d{1,2}\s*[/\-.]\s*\d{1,4}/g, " ");

  const hasMorning = /صباح/.test(text) || /\bam\b/.test(text);
  const hasPm = /مساء|مغرب|ليل|عصر|ظهر|\bpm\b/.test(text);

  const numberRe = /(\d{1,2})(?:\s*[:.]\s*(\d{2}))?/g;
  let m;
  while ((m = numberRe.exec(text))) {
    const hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (hour > 24 || minute > 59) continue;

    const before = text.slice(Math.max(0, m.index - 12), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    const afterPeriod = new RegExp(`^\\s*${PERIOD}${NOT_ARABIC_LETTER_AFTER}`).test(after);
    const beforeHour = /(الساعه|ساعه|(?<![ء-ي])س)\s*$/.test(before);
    if (!(afterPeriod || beforeHour || m[2])) continue; // رقم مالوش علاقة بالوقت (زي "يوم 5")

    let h = hour;
    const directPm = new RegExp(`^\\s*(مساء|عصر|عصرا|مغرب|ليل|ليلا|pm|م)${NOT_ARABIC_LETTER_AFTER}`).test(after);
    const directAm = new RegExp(`^\\s*(صباح|صباحا|am|ص)${NOT_ARABIC_LETTER_AFTER}`).test(after);
    const directNoon = new RegExp(`^\\s*(ظهر|ظهرا)${NOT_ARABIC_LETTER_AFTER}`).test(after);

    if (h >= 13) {
      // 24 ساعة صريحة
    } else if (directAm || (!directPm && !directNoon && hasMorning && !hasPm)) {
      if (h === 12) h = 0;
    } else if (directPm || directNoon || hasPm) {
      if (h < 12) h += 12;
    } else if (h >= 1 && h <= 7) {
      h += 12; // من غير توضيح: 1-7 معناها بعد الظهر (أوقات العمل أصلًا صباح 8 لعصر 4)
    }
    return { minutes: (h % 24) * 60 + minute };
  }

  // رقم لوحده بعد اسم يوم ("الأحد 10"، "الثلاثاء 3") = ساعة، بس مش "يوم 5" ولا جزء من تاريخ
  const bareRe = /(?<![\d/\-.:])(\d{1,2})(?![\d/\-.:])/g;
  while ((m = bareRe.exec(text))) {
    const hour = parseInt(m[1], 10);
    if (hour < 1 || hour > 23) continue;
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (/يوم\s*$/.test(before)) continue;
    let h = hour;
    if (h >= 13) {
      // 24 ساعة صريحة
    } else if (hasMorning && !hasPm) {
      if (h === 12) h = 0;
    } else if (hasPm) {
      if (h < 12) h += 12;
    } else if (h >= 1 && h <= 7) {
      h += 12;
    }
    return { minutes: (h % 24) * 60 };
  }

  // مفيش رقم ساعة، بس ذكر صريح لفترة برّه الدوام (مساء/مغرب/ليل)
  if (/مساء|مغرب|ليل|عشاء/.test(text)) return { minutes: 20 * 60 };
  return null;
}

function isOutsideDeliveryHours(text) {
  const t = parseTimeOfDay(text);
  if (!t) return false;
  return t.minutes < START_MINUTES || t.minutes > END_MINUTES;
}

// يوم الأسبوع (0=الأحد ... 6=السبت) من النص: اسم يوم صريح أولًا، وبعده تاريخ يوم/شهر/سنة، وبعده
// "اليوم/بكرة/بعد بكرة" (بتوقيت الرياض). أيام الدوام الأحد-الخميس؛ الجمعة والسبت (5, 6) إجازة
const WEEKDAYS = [
  [0, /(?<![ء-ي])(ال)?احد(?![ء-ي])/],
  [1, /اثنين/],
  [2, /ثلاثاء/],
  [3, /اربعاء/],
  [4, /خميس/],
  [5, /جمعه/],
  [6, /سبت/],
];
function parseDayOfWeek(rawText, now = new Date()) {
  const text = normalize(rawText);
  for (const [day, re] of WEEKDAYS) if (re.test(text)) return day;

  const dm = text.match(/(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4})/);
  if (dm) {
    const d = new Date(Date.UTC(parseInt(dm[3], 10), parseInt(dm[2], 10) - 1, parseInt(dm[1], 10)));
    if (!Number.isNaN(d.getTime())) return d.getUTCDay();
  }

  const riyadhNow = now.getTime() + 3 * 60 * 60 * 1000;
  const dayAfter = (k) => new Date(riyadhNow + k * 86400000).getUTCDay();
  if (/بعد\s*(بكره|بكرا|غد)/.test(text)) return dayAfter(2);
  if (/بكره|بكرا|غدا|غدوه/.test(text)) return dayAfter(1);
  if (/اليوم/.test(text)) return dayAfter(0);
  return null;
}

// بيرجّع null لو الموعد مقبول (أو مفيش يوم/وقت واضح نحكم عليه)، "DAY" لو يوم إجازة (جمعة/سبت)،
// "TIME" لو وقت برّه 8 صباحًا - 4 عصرًا. اليوم بيتفحص الأول
function checkDeliverySlot(text, now = new Date()) {
  const day = parseDayOfWeek(text, now);
  // التوصيل متاح الأحد (0) والأربعاء (3) فقط - أي يوم تاني واضح بيترفض
  if (day !== null && !DELIVERY_DAYS.includes(day)) return "DAY";
  if (isOutsideDeliveryHours(text)) return "TIME";
  return null;
}

// هل النص حدّد يوم ووقت فعلًا؟ المزارعين بيكتبوا أي كلام ("جيب"، "الأسبوع الجاي"، "باي وقت")، فبنطلب
// الاتنين صراحة. وقت = ساعة (10 / 10 صباحًا / الساعة 3) أو فترة واضحة (الصباح/الظهر/العصر) أو "أي وقت"
function describeSlot(rawText, now = new Date()) {
  const text = normalize(rawText);
  const hasDay = parseDayOfWeek(rawText, now) !== null;
  const hasTime =
    parseTimeOfDay(rawText) !== null ||
    /صباح|ظهر|عصر/.test(text) ||
    /(ب)?اي\s*(وقت|ساعه)|(جميع|كل)\s*الاوقات|اي\s*وقت/.test(text);
  return { hasDay, hasTime };
}

module.exports = { parseTimeOfDay, parseDayOfWeek, isOutsideDeliveryHours, checkDeliverySlot, describeSlot, DELIVERY_DAYS, START_MINUTES, END_MINUTES };
