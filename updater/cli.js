#!/usr/bin/env node
// نظام تحديث الكود عن طريق GitHub - مستقل تمامًا عن منطق البوت (safeFarmerSend/farmerState/
// Dedup/Campaign Rules غير متأثرين إطلاقًا، ومش بيشتغل إلا لما تشغّله يدويًا بالأوامر دي):
//   npm run update:check   -> يعرض بس الإصدار الحالي/الأحدث ولو فيه تحديث متاح - صفر تغيير في أي ملف
//   npm run update:test    -> يحمّل الإصدار الأحدث، يفكّه في مجلد staging معزول، يشغّل عليه
//                              node --check + كل اختبارات طبقة الأمان - لكن ما يستبدلش أي حاجة
//   npm run update:apply   -> بعد نجاح update:test بس: نسخة احتياطية من الكود الحالي، تثبيت
//                              الكود الجديد (كود فقط - كل بيانات التشغيل محمية)، إعادة تشغيل
//                              PM2 (لو متاح)، فحص صحة، ولو فشلت الصحة يرجع تلقائيًا للنسخة القديمة
const fs = require("fs");
const path = require("path");
const { getConfig, isConfigured } = require("./config");
const versionState = require("./versionState");
const github = require("./githubClient");
const semver = require("./semver");
const { extractZip, findExtractedRoot } = require("./extract");
const { syncCodePaths, backupCurrentCode } = require("./codeSync");
const { installIfNeeded } = require("./npmInstall");
const { runSafetyGate } = require("./safetyGate");
const { restartViaPm2, isPm2Available } = require("./restart");
const { waitForHealthy } = require("./healthCheck");
const { rollbackFromBackup } = require("./rollback");

function log(msg) {
  console.log(msg);
}

async function cmdCheck() {
  if (!isConfigured()) {
    log("⚠️ GITHUB_OWNER/GITHUB_REPO غير مضبوطين في .env - مفيش حاجة نفحصها.");
    process.exitCode = 1;
    return;
  }
  const state = versionState.load();
  const latest = await github.getLatestRelease();
  const updateAvailable = semver.isNewer(latest.version, state.installedVersion);
  versionState.recordCheck({ latestVersion: latest.version, latestTag: latest.tagName, updateAvailable });

  log(`📦 الإصدار الحالي المثبَّت: ${state.installedVersion}`);
  log(`🌐 أحدث إصدار على GitHub: ${latest.version} (${latest.tagName})`);
  log(`🔄 يوجد تحديث متاح؟ ${updateAvailable ? "YES" : "NO"}`);
  log(`🕒 وقت هذا الفحص: ${new Date().toISOString()}`);
  return { current: state.installedVersion, latest: latest.version, updateAvailable, latestRelease: latest };
}

// بيحمّل ويفكّ ويختبر بس - من غير أي استبدال للكود الحالي. بيرجع مسار staging لو نجح الاختبار
// عشان update:apply يقدر يستخدمه من غير ما يعيد التحميل تاني
async function downloadAndValidate() {
  const cfg = getConfig();
  fs.mkdirSync(cfg.workDir, { recursive: true });

  const latest = await github.getLatestRelease();
  log(`⬇️ تحميل ${latest.tagName} (${latest.version})...`);
  const zipPath = path.join(cfg.workDir, `${latest.tagName}.zip`);
  await github.downloadZip(latest.zipballUrl, zipPath);

  const extractDir = path.join(cfg.workDir, `extract_${latest.tagName}_${Date.now()}`);
  log("📂 فك الضغط...");
  extractZip(zipPath, extractDir);
  const sourceRoot = findExtractedRoot(extractDir);

  const stagingDir = path.join(cfg.workDir, `staging_${latest.tagName}_${Date.now()}`);
  log("📋 نسخ ملفات الكود لمجلد الاختبار المعزول (staging)...");
  const syncResult = syncCodePaths(sourceRoot, stagingDir);

  log("📦 التأكد من الاعتماديات (npm install لو لزم الأمر)...");
  const installResult = installIfNeeded(cfg.projectRoot, stagingDir);

  log("🧪 فحص الصياغة + تشغيل كل اختبارات طبقة الأمان (بدون أي رسالة واتساب حقيقية)...");
  const gate = runSafetyGate(stagingDir);

  return { latest, stagingDir, syncResult, installResult, gate };
}

async function cmdTest() {
  if (!isConfigured()) {
    log("⚠️ GITHUB_OWNER/GITHUB_REPO غير مضبوطين في .env");
    process.exitCode = 1;
    return;
  }
  const result = await downloadAndValidate();

  if (!result.gate.ok) {
    log(`\n🚨 ABORT UPDATE - فشلت بوابة الأمان في مرحلة: ${result.gate.stage}`);
    if (result.gate.stage === "syntax") {
      result.gate.syntax.failures.forEach((f) => log(`  ❌ ${f.file}: ${f.error}`));
    } else {
      result.gate.tests.results.filter((r) => !r.ok).forEach((r) => log(`  ❌ ${r.script}:\n${r.output}`));
    }
    process.exitCode = 1;
    return result;
  }

  log(`\n✅ الإصدار ${result.latest.version} نجح في كل الاختبارات (${result.gate.tests.results.length} ملف اختبار).`);
  log(`📁 مجلد الاختبار (لسه موجود، ما اتطبقش على المشروع): ${result.stagingDir}`);
  log(`للتطبيق الفعلي: npm run update:apply`);
  return result;
}

async function cmdApply() {
  if (!isConfigured()) {
    log("⚠️ GITHUB_OWNER/GITHUB_REPO غير مضبوطين في .env");
    process.exitCode = 1;
    return;
  }
  const cfg = getConfig();
  const result = await downloadAndValidate();

  if (!result.gate.ok) {
    log(`\n🚨 ABORT UPDATE - فشلت بوابة الأمان في مرحلة: ${result.gate.stage}. مفيش أي تغيير اتطبق على المشروع.`);
    process.exitCode = 1;
    return result;
  }

  log("\n💾 نسخة احتياطية من الكود الحالي قبل التطبيق...");
  const currentState = versionState.load();
  const backupDir = backupCurrentCode(cfg.projectRoot, cfg.backupsDir, currentState.installedVersion || "unknown");
  log(`   محفوظة في: ${backupDir}`);

  log("📥 تثبيت الكود الجديد (كود فقط - كل بيانات التشغيل محمية بالكامل)...");
  syncCodePaths(result.stagingDir, cfg.projectRoot);
  installIfNeeded(cfg.projectRoot, cfg.projectRoot); // تثبيت فعلي على المشروع الحقيقي لو الحزم اتغيّرت
  versionState.recordInstall({ version: result.latest.version, tag: result.latest.tagName, commitSha: result.latest.commitSha });

  if (!isPm2Available()) {
    log("\nℹ️ PM2 غير متاح على هذا الجهاز (طبيعي على جهاز التطوير المحلي) - الكود اتثبّت بس إعادة");
    log("   التشغيل والفحص الصحي محتاجين تشغيل يدوي أو تشغيل هذا الأمر على السيرفر الفعلي.");
    return { ...result, installed: true, restarted: false };
  }

  log("\n🔁 إعادة تشغيل عبر PM2...");
  const restartedAt = Date.now();
  const restart = restartViaPm2();
  if (!restart.ok) {
    log(`🚨 فشلت إعادة التشغيل: ${restart.error}. جاري الـROLLBACK...`);
    rollbackFromBackup(backupDir, cfg.projectRoot);
    versionState.recordInstall({ version: currentState.installedVersion, tag: currentState.installedTag, commitSha: currentState.installedCommitSha });
    process.exitCode = 1;
    return { ...result, installed: true, restarted: false, rolledBack: true };
  }

  log("🩺 فحص الصحة بعد إعادة التشغيل...");
  const health = await waitForHealthy(restartedAt);
  if (!health.healthy) {
    log("🚨 البوت لم يصبح 'صحي' بعد إعادة التشغيل خلال المهلة المحددة. جاري الـROLLBACK...");
    rollbackFromBackup(backupDir, cfg.projectRoot);
    versionState.recordInstall({ version: currentState.installedVersion, tag: currentState.installedTag, commitSha: currentState.installedCommitSha });
    restartViaPm2();
    process.exitCode = 1;
    return { ...result, installed: true, restarted: true, healthy: false, rolledBack: true };
  }

  log(`\n✅ التحديث تم بنجاح للإصدار ${result.latest.version}، والبوت صحي.`);
  return { ...result, installed: true, restarted: true, healthy: true };
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "check") return cmdCheck();
  if (cmd === "test") return cmdTest();
  if (cmd === "apply") return cmdApply();
  log("الاستخدام: node updater/cli.js check|test|apply");
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.log(`💥 خطأ: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { cmdCheck, cmdTest, cmdApply };
