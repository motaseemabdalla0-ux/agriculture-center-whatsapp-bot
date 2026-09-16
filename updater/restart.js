const { execFileSync } = require("child_process");
const { getConfig } = require("./config");

// إعادة تشغيل عن طريق PM2 (المستخدم فعليًا على السيرفر البعيد). لو PM2 مش متاح (زي جهاز
// التطوير المحلي)، بنرجع { attempted: false } بدل ما نفشل - القرار بعد كده (تشغيل يدوي) يرجع للمستخدم
function restartViaPm2() {
  const { pm2ProcessName } = getConfig();
  try {
    execFileSync("pm2", ["restart", pm2ProcessName], { stdio: "pipe", timeout: 30000, windowsHide: true, shell: process.platform === "win32" });
    return { attempted: true, ok: true };
  } catch (err) {
    return { attempted: true, ok: false, error: (err.stderr || err.message).toString().slice(0, 300) };
  }
}

function isPm2Available() {
  try {
    execFileSync("pm2", ["--version"], { stdio: "pipe", timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
}

module.exports = { restartViaPm2, isPm2Available };
