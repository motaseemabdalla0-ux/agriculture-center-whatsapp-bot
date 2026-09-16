const { join } = require("path");

module.exports = {
  // نخلي مكان تحميل Chrome ثابت جوه مجلد المشروع نفسه
  // بدل ما يعتمد على مسار حساب المستخدم في ويندوز (اللي ممكن يختلف بين الجلسات)
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
