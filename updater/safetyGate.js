const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// بيلقط كل ملفات .js تحت مجلد (متجاهل node_modules) عشان نعمل node --check على كل واحد فيهم
function listJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, acc);
    else if (entry.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

// بيتأكد إن كل ملفات JS في الكود الجديد (staging) سليمة الصياغة - أي ملف فيه خطأ يوقف
// التحديث بالكامل فورًا (Fail-Closed لطبقة الـUpdate نفسها)
function checkSyntax(stagingDir) {
  const files = listJsFiles(stagingDir);
  const failures = [];
  files.forEach((f) => {
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe", timeout: 10000, windowsHide: true });
    } catch (err) {
      failures.push({ file: path.relative(stagingDir, f), error: (err.stderr || err.message).toString().slice(0, 300) });
    }
  });
  return { ok: failures.length === 0, failures, totalChecked: files.length };
}

// بيشغّل كل ملفات اختبارات طبقة الأمان (safeFarmerSend/farmerState/dedup...) جوّه staging نفسه -
// بما إنها بتعتمد على مسارات نسبية (__dirname/..) فهي بتشتغل تلقائيًا على بيانات staging المعزولة
// (مفيش farmer_state.json حقيقي هناك أصلًا)، مش على بيانات التشغيل الحقيقية للمشروع الحالي إطلاقًا
const SAFETY_TEST_SCRIPTS = [
  "scripts/testStateSafetyEngine.js",
  "scripts/testStateSafetyEngineV2.js",
  "scripts/testStateSafetyEngineV3.js",
];

function runSafetyTests(stagingDir) {
  const results = [];
  for (const rel of SAFETY_TEST_SCRIPTS) {
    const scriptPath = path.join(stagingDir, rel);
    if (!fs.existsSync(scriptPath)) {
      results.push({ script: rel, ok: false, output: "الملف غير موجود في الإصدار الجديد" });
      continue;
    }
    try {
      const output = execFileSync(process.execPath, [scriptPath], {
        cwd: stagingDir,
        stdio: "pipe",
        timeout: 120000,
        windowsHide: true,
      }).toString();
      results.push({ script: rel, ok: true, output });
    } catch (err) {
      results.push({ script: rel, ok: false, output: (err.stdout || "").toString() + (err.stderr || "").toString() });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

// البوابة الكاملة: صياغة سليمة + كل اختبارات الأمان ناجحة. أي فشل في أي منهم = ABORT UPDATE
function runSafetyGate(stagingDir) {
  const syntax = checkSyntax(stagingDir);
  if (!syntax.ok) {
    return { ok: false, stage: "syntax", syntax };
  }
  const tests = runSafetyTests(stagingDir);
  if (!tests.ok) {
    return { ok: false, stage: "tests", syntax, tests };
  }
  return { ok: true, syntax, tests };
}

module.exports = { runSafetyGate, checkSyntax, runSafetyTests };
