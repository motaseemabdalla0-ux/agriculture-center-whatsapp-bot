const { syncCodePaths } = require("./codeSync");

// بيرجّع كل ملفات الكود من نسخة احتياطية سابقة (اتاخدت قبل التحديث الفاشل) - بيستخدم نفس آلية
// المزامنة (Allowlist) بالظبط، يعني برضه بيلمس كود بس، ومفيش أي احتمال يمسح بيانات تشغيلية
function rollbackFromBackup(backupDir, projectRoot) {
  return syncCodePaths(backupDir, projectRoot);
}

module.exports = { rollbackFromBackup };
