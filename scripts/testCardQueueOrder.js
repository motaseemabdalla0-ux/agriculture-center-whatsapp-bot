// فحص ترتيب طابور إشعارات البطاقات: الفاشلون نهائيًا ما يسدّوش الطابور (head-of-line blocking).
const assert = require("assert");
const { orderForSending, isTerminalDecision } = require("../lib/portalSync");

const NOW = Date.parse("2026-10-28T10:00:00Z");
const row = (n, phone) => ({ name: `م${n}`, phone });
// أول 6 صفوف أرقامهم مش على واتساب (فشل حديث)، بعدين صفوف جديدة بدون أي محاولة، وواحد فشل عام، وواحد فشل نهائي قديم (> 24 ساعة)
const rows = [1, 2, 3, 4, 5, 6].map((i) => row(i, `96650000000${i}`)).concat([7, 8, 9].map((i) => row(i, `96650000000${i}`)), [row(10, "966500000010"), row(11, "966500000011")]);
const dec = {
  966500000001: { decision: "FAILED", reason: "not_on_whatsapp", at: NOW - 3600e3 },
  966500000002: { decision: "FAILED", reason: "not_on_whatsapp", at: NOW - 3600e3 },
  966500000003: { decision: "FAILED", reason: "not_on_whatsapp", at: NOW - 3600e3 },
  966500000004: { decision: "FAILED", reason: "not_on_whatsapp", at: NOW - 3600e3 },
  966500000005: { decision: "FAILED", reason: "not_on_whatsapp", at: NOW - 3600e3 },
  966500000006: { decision: "BLOCKED_NON_ARABIC_NAME", reason: "", at: NOW - 3600e3 },
  966500000010: { decision: "FAILED", reason: "timeout", at: NOW - 3600e3 }, // فشل عام: يتعاد بعد الجدد
  966500000011: { decision: "FAILED", reason: "not_on_whatsapp", at: NOW - 30 * 3600e3 }, // فشل نهائي قديم: يتعاد
};
const decisionOf = (p) => dec[p] || null;
const ordered = orderForSending(rows, decisionOf, NOW);
assert.deepStrictEqual(ordered.slice(0, 3).map((r) => r.name), ["م7", "م8", "م9"], "الجدد (ما اتحاولش معاهم) أولًا");
assert.deepStrictEqual(ordered.slice(3).map((r) => r.name), ["م10", "م11"], "بعدهم اللي اتحاول معاهم، واللي فشله النهائي قديم يتعاد");
assert.ok(!ordered.some((r) => ["م1", "م2", "م3", "م4", "م5", "م6"].includes(r.name)), "الفشل النهائي الحديث متأجّل 24 ساعة");
// أول 5 في الدفعة = أول 3 جدد + اتنين تانيين (مش الفاشلين الخمسة)
assert.deepStrictEqual(ordered.slice(0, 5).map((r) => r.name), ["م7", "م8", "م9", "م10", "م11"]);
// من غير أي سجل قرارات = الترتيب الأصلي زي ما هو
assert.deepStrictEqual(orderForSending(rows, () => null, NOW).map((r) => r.name), rows.map((r) => r.name));
assert.strictEqual(isTerminalDecision({ decision: "FAILED", reason: "timeout" }), false);
assert.strictEqual(isTerminalDecision({ decision: "INVALID_PHONE" }), true);
assert.strictEqual(isTerminalDecision(null), false);
console.log("✅ كل الفحوصات نجحت");
