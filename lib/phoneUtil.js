const { toWesternDigits } = require("./fileIngest");

// بيوحّد صيغ رقم الجوال السعودي المختلفة لصيغة واحدة ثابتة: 9665xxxxxxxx (أرقام بس، من غير
// + أو مسافات أو أصفار دولية) - بيدعم: محلي (05xxxxxxxx)، دولي (+9665xxxxxxxx أو 009665xxxxxxxx)،
// وبدون صفر أو كود دولة خالص (5xxxxxxxx)
function normalizeSaudiPhone(raw) {
  let digits = toWesternDigits(String(raw || "")).replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `966${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) digits = `966${digits}`;
  return digits;
}

// بيتأكد إن الرقم (بعد التطبيع) شكله رقم جوال سعودي صحيح: 966 + 5 + 8 أرقام = 12 رقم بالظبط
function isValidSaudiPhone(digits) {
  return /^9665\d{8}$/.test(digits);
}

module.exports = { normalizeSaudiPhone, isValidSaudiPhone };
