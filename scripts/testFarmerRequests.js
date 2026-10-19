// فحص تقرير طلبات المزارعين: بيانات ثابتة (بدون شبكة) + اختياري --live لقراءة المنصة فعلًا وتوليد الملفات
const assert = require("assert");
const fr = require("../lib/farmerRequests");

const NOW = Date.parse("2026-10-19T12:00:00Z");
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const it = (type, status, created, last) => ({ id: Math.random(), type, status, role: "x", createdOn: day(created), lastChange: day(last) });
const IPM = "FarmOperatorIPMRequest", LSK = "FarmOperatorLivestockRequest", MKT = "FarmOperatorMarketingRequest", EXT = "FarmOperatorFarmerCapabilityDevelopmentRequest";

const raw = {
  statistics: { newIncoming: 1, inProgress: 8, pendingApproval: 0, history: 3 },
  tabs: {
    NewIncoming: { total: 1, items: [it(LSK, "InitialReview", 0, 0)] },
    InProgress: {
      total: 8,
      items: [
        it(IPM, "FieldExecution", 20, 12),
        it(IPM, "FieldExecution", 5, 2),
        it(IPM, "CaseReview", 9, 1),
        it(IPM, "CompletionReview", 7, 3),
        it(LSK, "Assigned", 13, 12),
        it(LSK, "Assigned", 5, 5),
        it(MKT, "Assigned", 53, 4),
        it(EXT, "ManagerAssessment", 35, 32),
      ],
    },
    PendingApproval: { total: 0, items: [] },
    History: { total: 3, items: [it(LSK, "Rejected", 9, 9), it(LSK, "Cancelled", 9, 9), it(MKT, "Rejected", 9, 9)] },
  },
};

const d = fr.computeFarmerRequests(raw, NOW);
assert.strictEqual(d.total, 12);
assert.strictEqual(d.open, 9);
assert.strictEqual(d.closedNoExec, 3);
assert.strictEqual(d.done, 0);
assert.strictEqual(d.openPct, 75);
assert.strictEqual(d.stalled, 3); // IPM 12 يوم، LSK 12 يوم، EXT 32 يوم
const ipm = d.units.find((u) => u.key === "ipm");
assert.strictEqual(ipm.open, 4);
assert.strictEqual(ipm.stages.provider, 3);
assert.strictEqual(ipm.stages.completion, 1);
assert.strictEqual(d.units.find((u) => u.key === "markets").oldest, 53);
let v = fr.validateFarmerRequests(d);
assert.deepStrictEqual(v.errors, []);

// عدّاد المنصة مختلف عن المقروء => ممنوع الإرسال
const bad = JSON.parse(JSON.stringify(raw));
bad.statistics.inProgress = 9;
v = fr.validateFarmerRequests(fr.computeFarmerRequests(bad, NOW));
assert.ok(v.errors.length >= 1);

// نوع طلب غير معروف / حالة غير معروفة => خطأ
const weird = JSON.parse(JSON.stringify(raw));
weird.tabs.InProgress.items[0].status = "SomethingNew";
v = fr.validateFarmerRequests(fr.computeFarmerRequests(weird, NOW));
assert.ok(v.errors.some((e) => /غير معروفة/.test(e)));

assert.ok(fr.buildActions(d).length >= 4);
assert.ok(fr.buildPriorities(d).length >= 2);
console.log("✅ الفحوصات الثابتة نجحت");

if (process.argv.includes("--live")) {
  (async () => {
    const fs = require("fs");
    const out = process.argv[process.argv.indexOf("--live") + 1] || ".";
    const live = await require("../lib/portalScraper").fetchFarmerRequests();
    const ld = fr.computeFarmerRequests(live);
    console.log(JSON.stringify({ total: ld.total, open: ld.open, stalled: ld.stalled, closed: ld.closedNoExec, done: ld.done, validate: fr.validateFarmerRequests(ld) }));
    const files = await require("../lib/farmerRequestsRender").renderFarmerRequestsFiles(ld);
    files.pngs.forEach((b, i) => fs.writeFileSync(`${out}/fr_live_${i + 1}.png`, b));
    fs.writeFileSync(`${out}/fr_live.pdf`, files.pdf);
    console.log("files written to", out);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
