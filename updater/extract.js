const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// بيفك ضغط ملف zip لمجلد معيّن. بنعتمد على أدوات النظام المتوفرة أصلًا (بدون مكتبة npm جديدة):
// PowerShell's Expand-Archive على ويندوز (السيرفر الحالي والجهاز المحلي كلاهما ويندوز)،
// و unzip على أنظمة Unix/Linux كخيار احتياطي لو المشروع اشتغل على سيرفر لينكس مستقبلًا
function extractZip(zipPath, destDir) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "pipe", windowsHide: true, timeout: 60000 }
    );
  } else {
    execFileSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "pipe", timeout: 60000 });
  }
}

// GitHub بيغلّف كود المصدر (zipball_url) جوّه مجلد واحد بالاسم owner-repo-<sha قصير> - بنكتشفه
// ونرجّع مساره عشان نتعامل معاه كجذر الكود الفعلي (مش الـzip نفسه)
function findExtractedRoot(destDir) {
  const entries = fs.readdirSync(destDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 1) return path.join(destDir, entries[0].name);
  return destDir; // احتياطي: لو الشكل مختلف (zip مش من GitHub)، نتعامل مع destDir نفسه كجذر
}

module.exports = { extractZip, findExtractedRoot };
