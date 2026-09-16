// مقارنة إصدارات بسيطة (major.minor.patch) - مش محتاجين مكتبة semver كاملة لحالة استخدام
// بسيطة زي دي (Tags من نوع v1.0.0, v1.0.1...)
function parse(version) {
  const clean = String(version || "").replace(/^v/, "");
  const parts = clean.split(".").map((p) => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

// بيرجع 1 لو a أحدث من b، -1 لو أقدم، 0 لو متساويين
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function isNewer(candidate, current) {
  return compare(candidate, current) > 0;
}

module.exports = { compare, isNewer, parse };
