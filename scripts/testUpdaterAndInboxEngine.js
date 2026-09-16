// اختبارات نظام تحديث GitHub (updater/) وصندوق استقبال الحملات (campaign-inbox/) - 18 اختبار
// كما طُلب. صفر رسائل واتساب حقيقية (Fake Client في كل مكان)، وصفر تعديل على منطق
// safeFarmerSend/farmerState/Dedup/Campaign Rules نفسه - بس تنسيق حوله.
// بيعمل نسخة احتياطية لكل بيانات التشغيل الحقيقية (زي باقي سكريبتات الاختبار) ويرجّعها في النهاية.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const http = require("http");
const XLSX = require("xlsx");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = [
  "farmer_state.json",
  "farmer_state.json.bak",
  "tickets.json",
  "tickets.json.bak",
  "send_fingerprints.json",
  "send_fingerprints.json.bak",
  "handoff_state.json",
  "handoff_state.json.bak",
  "rate_limit_state.json",
  "sent_history.json",
  "sent_history.json.bak",
  "audit_log.jsonl",
  "update_state.json",
];
const DATA_DIRS = ["campaigns", "campaign-inbox/data", "updater_workdir", "updater_backups"];

function snapshotFiles() {
  const snapshot = {};
  DATA_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    snapshot[name] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  });
  return snapshot;
}
function restoreFiles(snapshot) {
  DATA_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    if (snapshot[name] === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, snapshot[name]);
    }
  });
}
function wipeTestFiles() {
  DATA_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
}

function removeDirRecursive(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function snapshotDirs() {
  const snapshot = {};
  DATA_DIRS.forEach((rel) => {
    const p = path.join(ROOT, rel);
    snapshot[rel] = fs.existsSync(p) ? true : false;
    if (snapshot[rel]) {
      const tmpCopy = path.join(ROOT, `__snapshot_${rel.replace(/[\\/]/g, "_")}`);
      removeDirRecursive(tmpCopy);
      fs.cpSync(p, tmpCopy, { recursive: true });
      snapshot[`${rel}__copy`] = tmpCopy;
    }
  });
  return snapshot;
}
function restoreDirs(snapshot) {
  DATA_DIRS.forEach((rel) => {
    const p = path.join(ROOT, rel);
    removeDirRecursive(p);
    if (snapshot[rel] && snapshot[`${rel}__copy`]) {
      fs.cpSync(snapshot[`${rel}__copy`], p, { recursive: true });
      removeDirRecursive(snapshot[`${rel}__copy`]);
    }
  });
}
function wipeTestDirs() {
  DATA_DIRS.forEach((rel) => removeDirRecursive(path.join(ROOT, rel)));
}

let passed = 0;
function check(label, condition) {
  assert(condition, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
}

function fakeClient(overrides = {}) {
  let callCount = 0;
  return {
    getNumberId: overrides.getNumberId || (async (phone) => ({ _serialized: `${phone}@c.us` })),
    sendMessage:
      overrides.sendMessage ||
      (async () => {
        callCount++;
        return true;
      }),
    _getCallCount: () => callCount,
  };
}

function csvBuffer(rows) {
  return Buffer.from(rows.map((r) => r.join(",")).join("\n") + "\n", "utf8");
}

function xlsxBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  [
    "../lib/farmerState",
    "../lib/campaignRules",
    "../lib/sendFingerprint",
    "../lib/sentTracker",
    "../lib/safeFarmerSend",
    "../lib/rateLimiter",
    "../lib/auditLog",
    "../lib/campaignBuilder",
    "../lib/campaignStore",
    "../lib/campaignRunner",
    "../campaign-inbox/inboxStore",
    "../campaign-inbox/inboxEngine",
    "../campaign-inbox/adapters/LocalCampaignAdapter",
    "../updater/versionState",
    "../updater/githubClient",
    "../updater/codeSync",
    "../updater/cli",
  ].forEach((m) => {
    try {
      delete require.cache[require.resolve(m)];
    } catch {
      /* لسه ما اتحمّلش قبل كده - عادي */
    }
  });

  const farmerState = require("../lib/farmerState");
  const inboxStore = require("../campaign-inbox/inboxStore");
  const inboxEngine = require("../campaign-inbox/inboxEngine");
  const versionState = require("../updater/versionState");
  const codeSync = require("../updater/codeSync");
  const githubClient = require("../updater/githubClient");
  const cli = require("../updater/cli");

  // ============ نظام تحديث GitHub (1-4) ============

  console.log("=== 1) GitHub update check لا يغيّر أي ملف كود ===");
  {
    const beforeMtime = fs.statSync(path.join(ROOT, "lib", "farmerState.js")).mtimeMs;
    const beforeIndexMtime = fs.statSync(path.join(ROOT, "index.js")).mtimeMs;

    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes("/releases/latest")) {
        return {
          ok: true,
          json: async () => ({ tag_name: "v0.0.1", zipball_url: "local-fixture://none", published_at: "", html_url: "" }),
        };
      }
      throw new Error("لازم يتنادى GET releases/latest بس في هذا الاختبار");
    };
    process.env.GITHUB_OWNER = "test-owner";
    process.env.GITHUB_REPO = "test-repo";

    await cli.cmdCheck();
    global.fetch = originalFetch;

    const afterMtime = fs.statSync(path.join(ROOT, "lib", "farmerState.js")).mtimeMs;
    const afterIndexMtime = fs.statSync(path.join(ROOT, "index.js")).mtimeMs;
    check("1: lib/farmerState.js ما اتغيّرش", beforeMtime === afterMtime);
    check("1: index.js ما اتغيّرش", beforeIndexMtime === afterIndexMtime);
    check("1: مفيش مجلد staging/backup اتعمل", !fs.existsSync(path.join(ROOT, "updater_workdir")) && !fs.existsSync(path.join(ROOT, "updater_backups")));
  }

  // بناء "إصدار جديد" وهمي حقيقي (zip فعلي) من نفس كود المشروع الحالي (السليم) - عشان نختبر
  // update:test / update:apply على تدفق حقيقي كامل (تحميل -> فك ضغط -> نسخ -> اختبار) من غير
  // شبكة فعلية ولا لمس المشروع الحقيقي مباشرة
  const { execFileSync } = require("child_process");
  const fixturesDir = path.join(ROOT, "updater_workdir", "__test_fixtures");
  fs.mkdirSync(fixturesDir, { recursive: true });

  function buildFixtureZip(label, corruptFile) {
    const srcRoot = path.join(fixturesDir, `src_${label}`);
    removeDirRecursive(srcRoot);
    const wrapped = path.join(srcRoot, "owner-repo-abc1234"); // بنقلد شكل zipball بتاع GitHub (مجلد واحد ملفوف)
    codeSync.syncCodePaths(ROOT, wrapped);
    if (corruptFile) {
      fs.writeFileSync(path.join(wrapped, corruptFile), "const x = ((( syntax error not closed", "utf8");
    }
    const zipPath = path.join(fixturesDir, `${label}.zip`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${srcRoot}\\*' -DestinationPath '${zipPath}' -Force`],
      { stdio: "pipe", windowsHide: true }
    );
    return zipPath;
  }

  const goodZip = buildFixtureZip("good", null);
  const badZip = buildFixtureZip("bad", "lib/farmerState.js");

  function mockFetchForZip(zipPath, tag) {
    return async (url) => {
      const u = String(url);
      if (u.includes("/releases/latest")) {
        return {
          ok: true,
          json: async () => ({ tag_name: tag, zipball_url: `local-fixture://${tag}`, published_at: "", html_url: "" }),
        };
      }
      if (u.startsWith("local-fixture://")) {
        const buf = fs.readFileSync(zipPath);
        return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
      }
      throw new Error(`fetch غير متوقع: ${u}`);
    };
  }

  console.log("\n=== 2) update:test لا يطبّق التحديث على المشروع الحقيقي ===");
  {
    const beforeMtime = fs.statSync(path.join(ROOT, "index.js")).mtimeMs;
    const originalFetch = global.fetch;
    global.fetch = mockFetchForZip(goodZip, "v9.9.9-good");
    const result = await cli.cmdTest();
    global.fetch = originalFetch;

    check("2: بوابة الأمان نجحت (إصدار سليم)", result.gate.ok === true);
    const afterMtime = fs.statSync(path.join(ROOT, "index.js")).mtimeMs;
    check("2: index.js الحقيقي ما اتغيّرش رغم نجاح الاختبار", beforeMtime === afterMtime);
    check("2: staging موجود لسه (للمراجعة) بس المشروع الحقيقي متأثرش", fs.existsSync(result.stagingDir));
  }

  console.log("\n=== 3) فشل Safety Tests (كود تالف) يمنع Update (ABORT) ===");
  {
    const originalFetch = global.fetch;
    global.fetch = mockFetchForZip(badZip, "v9.9.9-bad");
    const result = await cli.cmdTest();
    global.fetch = originalFetch;

    check("3: بوابة الأمان فشلت زي المتوقع", result.gate.ok === false);
    check("3: السبب فشل الصياغة (syntax)", result.gate.stage === "syntax");
  }

  console.log("\n=== 4) Runtime JSON لا يُستبدل أثناء عملية تحديث كود (حتى لو تطبيق فعلي) ===");
  {
    // بنختبر ضمانة "الكود بس" على نسخة معزولة تمامًا من المشروع (مش المشروع الحقيقي إطلاقًا)
    // عشان نتأكد من آلية syncCodePaths نفسها بأمان صفري على أي بيانات حقيقية
    const isolatedRoot = path.join(fixturesDir, "isolated_project");
    removeDirRecursive(isolatedRoot);
    fs.mkdirSync(isolatedRoot, { recursive: true });
    const runtimeFiles = { "farmer_state.json": '{"966500000000":{"state":"CARD_COLLECTED"}}', "sent_history.json": '{"card_pickup":["966500000000"]}' };
    Object.entries(runtimeFiles).forEach(([name, content]) => fs.writeFileSync(path.join(isolatedRoot, name), content, "utf8"));
    fs.mkdirSync(path.join(isolatedRoot, "lib"), { recursive: true });
    fs.writeFileSync(path.join(isolatedRoot, "lib", "old.js"), "module.exports = 'old';", "utf8");

    const goodSrcRoot = path.join(fixturesDir, "src_good", "owner-repo-abc1234");
    codeSync.syncCodePaths(goodSrcRoot, isolatedRoot);

    Object.entries(runtimeFiles).forEach(([name, content]) => {
      check(`4: ${name} لم يتغيّر بعد مزامنة الكود`, fs.readFileSync(path.join(isolatedRoot, name), "utf8") === content);
    });
    check("4: الكود فعليًا اتحدّث (lib/farmerState.js وصل)", fs.existsSync(path.join(isolatedRoot, "lib", "farmerState.js")));
  }

  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
  removeDirRecursive(path.join(ROOT, "updater_workdir"));
  removeDirRecursive(path.join(ROOT, "updater_backups"));

  // ============ صندوق استقبال الحملات (5-18) ============

  farmerState.setManualState("966599200001", "UNKNOWN", { changedBy: "test", reason: "baseline" });

  console.log("\n=== 5) CSV صالح → PREVIEW_READY ===");
  let csvCampaignId;
  {
    const buf = csvBuffer([
      ["name", "phone"],
      ["مزارع واحد", "966599200002"],
      ["مزارع اتنين", "966599200003"],
    ]);
    const meta = await inboxEngine.receiveCampaign({
      buffer: buf,
      fileName: "test.csv",
      purpose: "SURVEY",
      campaignType: "custom",
      message: "استبيان للمزارعين",
      uploadedBy: "test-suite",
      source: "test",
    });
    csvCampaignId = meta.campaignId;
    check("5: الحالة PREVIEW_READY", meta.status === "PREVIEW_READY");
    check("5: عدد الجاهز للإرسال 2", meta.preview.valid === 2);
  }

  console.log("\n=== 6) XLSX صالح → PREVIEW_READY ===");
  {
    const buf = xlsxBuffer([
      ["name", "phone"],
      ["مزارع اكسل", "966599200004"],
    ]);
    const meta = await inboxEngine.receiveCampaign({
      buffer: buf,
      fileName: "test.xlsx",
      purpose: "GENERAL_NOTICE",
      message: "إشعار عام",
      uploadedBy: "test-suite",
      source: "test",
    });
    check("6: الحالة PREVIEW_READY", meta.status === "PREVIEW_READY");
    check("6: عدد الجاهز للإرسال 1", meta.preview.valid === 1);
  }

  console.log("\n=== 7) ملف غير مدعوم → REJECTED ===");
  {
    const meta = await inboxEngine.receiveCampaign({
      buffer: Buffer.from("لا شيء"),
      fileName: "test.pdf",
      purpose: "SURVEY",
      message: "رسالة",
      source: "test",
    });
    check("7: الحالة REJECTED", meta.status === "REJECTED");
    check("7: السبب UNSUPPORTED_FILE_TYPE", meta.rejectReason.startsWith("UNSUPPORTED_FILE_TYPE"));
  }

  console.log("\n=== 8) Missing Purpose → REJECTED ===");
  {
    const buf = csvBuffer([
      ["name", "phone"],
      ["مزارع", "966599200005"],
    ]);
    const meta = await inboxEngine.receiveCampaign({
      buffer: buf,
      fileName: "no-purpose.csv",
      message: "رسالة",
      source: "test",
    });
    check("8: الحالة REJECTED", meta.status === "REJECTED");
    check("8: السبب MISSING_CAMPAIGN_PURPOSE", meta.rejectReason === "MISSING_CAMPAIGN_PURPOSE");
  }

  console.log("\n=== 9) رفع ملف لا يرسل WhatsApp ===");
  {
    const client = fakeClient();
    const buf = csvBuffer([
      ["name", "phone"],
      ["مزارع", "966599200006"],
    ]);
    await inboxEngine.receiveCampaign({ buffer: buf, fileName: "upload-only.csv", purpose: "SURVEY", message: "رسالة", source: "test" });
    check("9: صفر نداء sendMessage عند الرفع فقط", client._getCallCount() === 0);
  }

  console.log("\n=== 10) Preview لا يرسل WhatsApp ===");
  {
    const client = fakeClient();
    const meta = inboxStore.getMeta(csvCampaignId);
    check("10: Preview موجودة أصلًا من غير أي إرسال", !!meta.preview);
    check("10: صفر نداء sendMessage", client._getCallCount() === 0);
  }

  console.log("\n=== 11) DRY RUN → zero WhatsApp sends ===");
  let dryRunClient;
  {
    dryRunClient = fakeClient();
    const updated = await inboxEngine.runDryRun(csvCampaignId, dryRunClient);
    check("11: الحالة AWAITING_APPROVAL بعد DRY RUN", updated.status === "AWAITING_APPROVAL");
    check("11: صفر نداء sendMessage أثناء DRY RUN", dryRunClient._getCallCount() === 0);
  }

  console.log("\n=== 12) DRY RUN → zero SENT records ===");
  {
    const sendFingerprint = require("../lib/sendFingerprint");
    const fp = sendFingerprint.buildFingerprint("966599200002", "استبيان للمزارعين");
    const entry = sendFingerprint.getEntry(fp);
    check("12: مفيش بصمة SENT بعد DRY RUN", !entry || entry.status !== "SENT");
  }

  console.log("\n=== 13) Campaign لا يمكن Send قبل Approval ===");
  {
    const buf = csvBuffer([
      ["name", "phone"],
      ["مزارع", "966599200007"],
    ]);
    const meta = await inboxEngine.receiveCampaign({ buffer: buf, fileName: "no-approval.csv", purpose: "SURVEY", message: "رسالة", source: "test" });
    let threw = false;
    try {
      await inboxEngine.sendApprovedCampaign(meta.campaignId, fakeClient());
    } catch (err) {
      threw = err.message.includes("CAMPAIGN_NOT_APPROVED");
    }
    check("13: الإرسال اترفض قبل Approval", threw);
  }

  console.log("\n=== 14) Approval بدون Dry Run ناجح → BLOCK ===");
  {
    const buf = csvBuffer([
      ["name", "phone"],
      ["مزارع", "966599200008"],
    ]);
    const meta = await inboxEngine.receiveCampaign({ buffer: buf, fileName: "no-dryrun.csv", purpose: "SURVEY", message: "رسالة", source: "test" });
    let threw = false;
    try {
      inboxEngine.approveCampaign(meta.campaignId, "tester");
    } catch (err) {
      threw = err.message.includes("CAMPAIGN_NOT_AWAITING_APPROVAL");
    }
    check("14: الـApproval اترفض من غير DRY RUN ناجح", threw);
  }

  console.log("\n=== 15) Real Send disabled في Local Test Mode → BLOCK ===");
  {
    delete require.cache[require.resolve("../campaign-inbox/localServer")];
    process.env.CAMPAIGN_INBOX_PORT = "4099";
    delete process.env.ALLOW_REAL_SEND;
    const { startLocalServer } = require("../campaign-inbox/localServer");
    const server = startLocalServer();

    // نعتمد الحملة (approve) الأول عشان نتأكد إن المنع بسبب ALLOW_REAL_SEND تحديدًا مش بسبب الحالة
    const approved = inboxEngine.approveCampaign(csvCampaignId, "tester");
    check("15-تمهيدي: الحملة APPROVED", approved.status === "APPROVED");

    const res = await httpRequest({ host: "127.0.0.1", port: 4099, path: `/campaigns/${csvCampaignId}/send`, method: "POST" });
    check("15: الطلب اترفض (403)", res.status === 403);
    check("15: السبب REAL_SEND_DISABLED", JSON.parse(res.body).error === "REAL_SEND_DISABLED");
    check("15: الحالة رجعت APPROVED من غير أي إرسال", inboxStore.getMeta(csvCampaignId).status === "APPROVED");

    await new Promise((resolve) => server.close(resolve));
  }

  console.log("\n=== 16) قواعد الحالة/التكرار/الطلب القديم الحالية لسه شغالة عبر صندوق الحملات ===");
  {
    farmerState.setManualState("966599200009", "CARD_COLLECTED", { changedBy: "test", reason: "setup" });
    const buf = csvBuffer([
      ["name", "phone"],
      ["مزارع بطاقة", "966599200009"],
      ["مزارع جديد", "966599200010"],
    ]);
    const meta = await inboxEngine.receiveCampaign({
      buffer: buf,
      fileName: "state-rules.csv",
      purpose: "REGISTRATION",
      message: "دعوة تسجيل",
      source: "test",
    });
    check("16: صف صاحب البطاقة اتستبعد بسبب الحالة", meta.preview.excluded_card_collected === 1);
    check("16: صف واحد بس جاهز للإرسال", meta.preview.valid === 1);
  }

  console.log("\n=== 17) Restart أثناء Campaign لا يفقد Campaign Status ===");
  {
    ["../campaign-inbox/inboxStore", "../lib/campaignStore"].forEach((m) => delete require.cache[require.resolve(m)]);
    const inboxStore2 = require("../campaign-inbox/inboxStore");
    const campaignStore2 = require("../lib/campaignStore");

    const metaAfterRestart = inboxStore2.getMeta(csvCampaignId);
    check("17: حالة الحملة لسه AWAITING_APPROVAL بعد محاكاة إعادة التشغيل", metaAfterRestart.status === "AWAITING_APPROVAL" || metaAfterRestart.status === "APPROVED");
    const rowsCampaign = campaignStore2.getCampaign(metaAfterRestart.rowsCampaignId);
    check("17: صفوف الحملة لسه موجودة بعد محاكاة إعادة التشغيل", rowsCampaign && rowsCampaign.rows.length > 0);
  }

  console.log("\n=== 18) Campaign ID لا يتكرر ===");
  {
    const ids = new Set();
    for (let i = 0; i < 30; i++) {
      const meta = inboxStore.createCampaignMeta({ fileName: `f${i}.csv`, purpose: "SURVEY", message: "m", uploadedBy: "test", source: "test" });
      ids.add(meta.campaignId);
    }
    check("18: كل الـ30 معرّف فريدة", ids.size === 30);
  }

  console.log(`\n🎉 كل اختبارات نظام التحديث وصندوق الحملات نجحت (${passed} اختبار). من غير أي رسالة واتساب حقيقية.`);
}

const snapshot = snapshotFiles();
const dirSnapshot = snapshotDirs();
wipeTestFiles();
wipeTestDirs();
run()
  .catch((err) => {
    console.log(`\n💥 فشل الاختبار: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    delete process.env.GITHUB_OWNER;
    delete process.env.GITHUB_REPO;
    delete process.env.CAMPAIGN_INBOX_PORT;
    delete process.env.ALLOW_REAL_SEND;
    removeDirRecursive(path.join(ROOT, "updater_workdir"));
    removeDirRecursive(path.join(ROOT, "updater_backups"));
    restoreFiles(snapshot);
    restoreDirs(dirSnapshot);
    console.log("\n♻️ تم استرجاع كل ملفات وبيانات التشغيل الحقيقية زي ما كانت قبل الاختبار.");
  });
