// تقرير "حالة طلبات خدمات المزارعين": حساب الأرقام من بيانات بوابة مدير علاقات المزارعين + فحص صحتها
// + نصوص الإجراءات المطلوبة. العرض في farmerRequestsRender.js. مفيش أي كتابة على المنصة.

const STALLED_DAYS = 10; // "بلا حركة" = مرّ على آخر تغيير حالة 10 أيام فأكثر

// ترتيب الوحدات زي التقرير الأصلي (الأكبر أولًا في صف، والتلات التانيين تحتها)
const UNITS = [
  { key: "ipm", type: "FarmOperatorIPMRequest", name: "الوقاية والمكافحة المتكاملة (IPM)", short: "IPM", rep: "ممثل وحدة IPM", mgr: "مدير وحدة IPM" },
  { key: "livestock", type: "FarmOperatorLivestockRequest", name: "الثروة الحيوانية", short: "الثروة الحيوانية", rep: "ممثل وحدة الثروة الحيوانية", mgr: "مدير وحدة الثروة الحيوانية" },
  { key: "markets", type: "FarmOperatorMarketingRequest", name: "الأسواق الموسمية", short: "الأسواق", rep: "ممثل وحدة الأسواق", mgr: "مدير وحدة الأسواق" },
  { key: "extension", type: "FarmOperatorFarmerCapabilityDevelopmentRequest", name: "الإرشاد وتنمية القدرات", short: "الإرشاد", rep: "ممثل وحدة الإرشاد", mgr: "مدير وحدة الإرشاد" },
];

// مراحل الطلب المفتوح (نفس تقسيم التقرير الأصلي)، والحالة في المنصة المقابلة لكل مرحلة
const STAGES = [
  { key: "newIn", label: "طلبات جديدة", statuses: ["InitialReview"] },
  { key: "toAssign", label: "بانتظار تحويل لمقدم الخدمة", statuses: ["Assigned"] },
  { key: "provider", label: "لدى مقدم الخدمة", statuses: ["FieldExecution", "CaseReview"] },
  { key: "completion", label: "مراجعة الإنجاز", statuses: ["CompletionReview"] },
  { key: "manager", label: "اعتماد المدير", statuses: ["ManagerAssessment"] },
];

const OPEN_TABS = ["NewIncoming", "InProgress", "PendingApproval"];
const CLOSED_STATUSES = ["Rejected", "Cancelled"];
const DONE_STATUSES = ["Closed", "Completed", "Approved", "ClosureApproved"];

const MS_DAY = 24 * 3600 * 1000;
function daysSince(iso, now) {
  if (!iso) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / MS_DAY);
}

function stageOf(status) {
  const s = STAGES.find((st) => st.statuses.includes(status));
  return s ? s.key : null;
}

// raw = { statistics, tabs: { NewIncoming:{total,items}, InProgress, PendingApproval, History } }
function computeFarmerRequests(raw, now = Date.now()) {
  const units = UNITS.map((u) => ({
    ...u,
    open: 0,
    stalled: 0,
    oldest: 0,
    stages: Object.fromEntries(STAGES.map((s) => [s.key, 0])),
    statuses: {},
    rejected: 0,
    cancelled: 0,
    done: 0,
    unknownStatus: 0,
  }));
  const byType = Object.fromEntries(units.map((u) => [u.type, u]));
  const unknownTypes = new Set();

  for (const tab of OPEN_TABS) {
    for (const r of (raw.tabs[tab] && raw.tabs[tab].items) || []) {
      const u = byType[r.type];
      if (!u) {
        unknownTypes.add(r.type);
        continue;
      }
      const st = stageOf(r.status);
      if (!st) {
        u.unknownStatus++;
        continue;
      }
      u.open++;
      u.stages[st]++;
      u.statuses[r.status] = (u.statuses[r.status] || 0) + 1;
      const idle = daysSince(r.lastChange, now);
      if (idle !== null && idle >= STALLED_DAYS) u.stalled++;
      const age = daysSince(r.createdOn, now);
      if (age !== null) u.oldest = Math.max(u.oldest, Math.floor(age));
    }
  }
  for (const r of (raw.tabs.History && raw.tabs.History.items) || []) {
    const u = byType[r.type];
    if (!u) {
      unknownTypes.add(r.type);
      continue;
    }
    if (r.status === "Rejected") u.rejected++;
    else if (r.status === "Cancelled") u.cancelled++;
    else if (DONE_STATUSES.includes(r.status)) u.done++;
    else u.unknownStatus++;
  }
  for (const u of units) {
    u.closedNoExec = u.rejected + u.cancelled;
    u.total = u.open + u.closedNoExec + u.done;
  }

  const sum = (f) => units.reduce((a, u) => a + f(u), 0);
  const total = sum((u) => u.total);
  const open = sum((u) => u.open);
  const stalled = sum((u) => u.stalled);
  const rejected = sum((u) => u.rejected);
  const cancelled = sum((u) => u.cancelled);
  const done = sum((u) => u.done);
  return {
    now,
    units,
    total,
    open,
    stalled,
    rejected,
    cancelled,
    closedNoExec: rejected + cancelled,
    done,
    openPct: total ? Math.round((open / total) * 100) : 0,
    stageTotals: Object.fromEntries(STAGES.map((s) => [s.key, sum((u) => u.stages[s.key])])),
    unknownTypes: [...unknownTypes],
    unknownStatus: sum((u) => u.unknownStatus),
    raw: {
      statistics: raw.statistics,
      listed: Object.fromEntries(Object.entries(raw.tabs).map(([k, v]) => [k, { total: v.total, got: v.items.length }])),
    },
  };
}

// فحص الصحة قبل الإرسال. errors = ما نرسلش، warnings = نرسل مع تنبيه
function validateFarmerRequests(d) {
  const errors = [];
  const warnings = [];
  const stats = d.raw.statistics || {};
  const expected = { NewIncoming: stats.newIncoming, InProgress: stats.inProgress, PendingApproval: stats.pendingApproval, History: stats.history };
  for (const [tab, info] of Object.entries(d.raw.listed)) {
    if (info.total != null && info.total !== info.got) errors.push(`تبويب ${tab}: المنصة تقول ${info.total} والمقروء ${info.got}`);
    if (expected[tab] != null && expected[tab] !== info.got) errors.push(`تبويب ${tab}: عدّاد المنصة ${expected[tab]} والمقروء ${info.got}`);
  }
  if (d.total === 0) errors.push("لم تُقرأ أي طلبات من المنصة");
  if (d.unknownTypes.length) errors.push(`نوع طلب غير معروف: ${d.unknownTypes.join("، ")}`);
  if (d.unknownStatus) errors.push(`${d.unknownStatus} طلب بحالة غير معروفة`);
  if (d.open + d.closedNoExec + d.done !== d.total) errors.push("مجموع المفتوحة والمغلقة لا يساوي الإجمالي");
  for (const u of d.units) {
    const st = Object.values(u.stages).reduce((a, b) => a + b, 0);
    if (st !== u.open) errors.push(`${u.short}: مجموع المراحل ${st} لا يساوي المفتوح ${u.open}`);
  }
  if (d.stalled > d.open) errors.push("عدد المتعثرة أكبر من المفتوحة");
  if (d.done === 0) warnings.push("لا توجد طلبات مكتملة ومغلقة");
  return { errors, warnings };
}

// ---- النصوص (عربي) ----
const AR = (v) => String(v).replace(/\d/g, (x) => "٠١٢٣٤٥٦٧٨٩"[x]);
function reqWord(n) {
  if (n === 1) return "طلب واحد";
  if (n === 2) return "طلبان";
  return n <= 10 ? `${n} طلبات` : `${n} طلبًا`;
}
function reqWordObj(n) {
  if (n === 1) return "طلب واحد";
  if (n === 2) return "طلبين";
  return n <= 10 ? `${n} طلبات` : `${n} طلبًا`;
}

// ملخص "الإجراءات المطلوبة" لكل دور (صفحة 2 أسفل). الصياغة "N من الطلبات ..." عشان القواعد النحوية تفضل سليمة لأي عدد
function buildActions(d) {
  const rows = [];
  const newTotal = d.stageTotals.newIn;
  if (newTotal) {
    const parts = d.units.filter((u) => u.stages.newIn).map((u) => `${u.short}: ${u.stages.newIn}`).join("، ");
    rows.push({ role: "ممثل علاقات المزارعين", text: `مراجعة ${newTotal} من الطلبات الجديدة وتحويلها للوحدات (${parts}).` });
  }
  for (const u of d.units) {
    const n = u.stages.toAssign;
    if (n) rows.push({ role: u.rep, text: `تعيين مقدم خدمة لـ ${n} من الطلبات المعلّقة، بدءًا بالأقدم.` });
  }
  const executed = d.units.find((u) => u.key === "ipm").statuses.CaseReview || 0;
  if (executed) rows.push({ role: "مقدم خدمة IPM (الفهاد)", text: `رفع الإنجاز على ${executed} من الطلبات التي نُفّذت أوامر عملها، لتنتقل للمراجعة والإغلاق.` });
  for (const u of d.units) {
    const n = u.stages.completion;
    if (n) rows.push({ role: u.rep, text: `التحقق من إنجاز ${n} من الطلبات وإحالتها للاعتماد.` });
  }
  for (const u of d.units) {
    const n = u.stages.manager;
    if (n) rows.push({ role: u.mgr, text: `اعتماد ${n} من الطلبات الجاهزة للإغلاق.` });
  }
  return rows;
}

// أولويات التنفيذ (الصفحة 1): أهم الإجراءات
function buildPriorities(d) {
  const out = [];
  const maxAssign = [...d.units].sort((a, b) => b.stages.toAssign - a.stages.toAssign)[0];
  if (maxAssign && maxAssign.stages.toAssign) out.push(`تعيين مقدم خدمة لـ ${maxAssign.stages.toAssign} من الطلبات في ${maxAssign.key === "ipm" ? "وحدة IPM" : maxAssign.short}.`);
  if (d.stageTotals.manager) out.push(`اعتماد ${d.stageTotals.manager} من الطلبات الجاهزة للإغلاق.`);
  const ex = d.units.find((u) => u.key === "ipm").statuses.CaseReview || 0;
  if (ex) out.push(`رفع إنجاز ${ex} من الطلبات المنفّذة في IPM.`);
  if (d.stageTotals.newIn) out.push(`مراجعة ${d.stageTotals.newIn} من الطلبات الجديدة وتحويلها للوحدات.`);
  return out.slice(0, 4);
}

// وصف "الوحدات الأخرى" في صفحة 2
function buildOtherUnitLines(u) {
  const lines = [];
  if (u.stages.newIn) lines.push(`${u.stages.newIn} جديدة بانتظار المراجعة الأولية.`);
  if (u.stages.toAssign) lines.push(`${u.stages.toAssign} بانتظار تحويل لمقدم الخدمة: ممثل الوحدة.`);
  if (u.stages.provider) lines.push(`${u.stages.provider} قيد التنفيذ لدى مقدم الخدمة.`);
  if (u.stages.completion) lines.push(`${u.stages.completion} بانتظار التحقق من الإنجاز.`);
  if (u.stages.manager) lines.push(`${u.stages.manager} بانتظار اعتماد مدير الوحدة للإغلاق.`);
  if (u.closedNoExec) {
    const parts = [];
    if (u.rejected) parts.push(`مرفوض: ${u.rejected}`);
    if (u.cancelled) parts.push(`ملغى: ${u.cancelled}`);
    lines.push(`أُغلقت دون تنفيذ ${u.closedNoExec} (${parts.join("، ")}).`);
  }
  return lines.length ? lines : ["لا توجد طلبات."];
}

module.exports = {
  UNITS,
  STAGES,
  STALLED_DAYS,
  computeFarmerRequests,
  validateFarmerRequests,
  buildActions,
  buildPriorities,
  buildOtherUnitLines,
  stageOf,
  daysSince,
  reqWord,
  AR,
};
