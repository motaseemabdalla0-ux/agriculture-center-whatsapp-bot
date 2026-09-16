const path = require("path");

// كل الإعدادات من متغيرات البيئة (.env) - مفيش أي Secret أو رمز وصول مكتوب في الكود أبدًا.
// GITHUB_TOKEN مطلوب بس لو الـRepository خاص (Private) - لو الريبو عام مش لازم توكن خالص.
function getConfig() {
  return {
    owner: process.env.GITHUB_OWNER || "",
    repo: process.env.GITHUB_REPO || "",
    token: process.env.GITHUB_TOKEN || "",
    pm2ProcessName: process.env.PM2_PROCESS_NAME || "agriculture-bot",
    projectRoot: path.join(__dirname, ".."),
    workDir: path.join(__dirname, "..", "updater_workdir"), // downloads/staging - مؤقت، برّه Git تمامًا
    backupsDir: path.join(__dirname, "..", "updater_backups"),
  };
}

function isConfigured() {
  const cfg = getConfig();
  return !!(cfg.owner && cfg.repo);
}

module.exports = { getConfig, isConfigured };
