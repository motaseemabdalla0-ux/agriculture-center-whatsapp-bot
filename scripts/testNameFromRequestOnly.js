// اختبار: الإرسال المبني على بيانات المنصة (nameFromRequestOnly) ما بيستخدمش الاسم المحفوظ في سجل المزارعين.
// Fake Client فقط - صفر رسائل حقيقية - وملفات البيانات بتتحفظ وتترجع زي ما كانت.
process.env.CAMPAIGN_TEST_FAST = "true";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DATA_FILES = [
  "farmer_state.json", "farmer_state.json.bak", "farmer_registry.json", "farmer_registry.json.bak",
  "send_fingerprints.json", "send_fingerprints.json.bak", "sent_history.json", "sent_history.json.bak",
  "rate_limit_state.json", "audit_log.jsonl",
];
const snap = {};
DATA_FILES.forEach((n) => {
  const p = path.join(ROOT, n);
  snap[n] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  if (fs.existsSync(p)) fs.unlinkSync(p);
});
function restore() {
  DATA_FILES.forEach((n) => {
    const p = path.join(ROOT, n);
    if (snap[n] === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else fs.writeFileSync(p, snap[n]);
  });
}

(async () => {
  let ok = true;
  const check = (label, cond) => {
    console.log(`${cond ? "✅" : "❌"} ${label}`);
    if (!cond) ok = false;
  };
  try {
    const farmerRegistry = require("../lib/farmerRegistry");
    const { runPersonalizedBroadcast } = require("../lib/personalizedRunner");
    const tpl = "عزيزي {name}، طلبكم {request_number}";
    const run = async (rows, opts) => {
      const sent = [];
      const client = {
        getNumberId: async (p) => ({ _serialized: `${p}@c.us` }),
        sendMessage: async (_to, text) => {
          sent.push(text);
          return true;
        },
      };
      const csv = path.join(os.tmpdir(), `nfro-${Date.now()}-${Math.random()}.csv`);
      fs.writeFileSync(csv, rows.map((r) => `${r.name},${r.phone},${r.req}`).join("\n"), "utf8");
      const summary = await runPersonalizedBroadcast(client, {
        csvPath: csv, columns: ["name", "phone", "request_number"], template: tpl,
        logFile: path.join(os.tmpdir(), "nfro-log.txt"), logLabel: "اختبار", ...opts,
      });
      fs.unlinkSync(csv);
      return { sent, summary };
    };

    // 1) اسم قديم محفوظ لنفس الجوال من ملف حملة سابقة
    farmerRegistry.backfillFromCampaignRow({ phone: "0555349329", nameArabic: "محمد طلال الفقير", campaignId: "old" });

    // 2) صف المنصة اسمه إنجليزي: الوضع الجديد = ممنوع (مش بياخد الاسم المحفوظ)
    let r = await run([{ name: "Talal Al-Faqir", phone: "0555349329", req: "30649" }], { campaignType: "draft_reminder", nameFromRequestOnly: true });
    check("اسم إنجليزي في الطلب + اسم قديم في السجل → ما اتبعتش أي رسالة", r.sent.length === 0);
    check("اتسجّل كممنوع بسبب الاسم", r.summary.blockedNonArabicName === 1);

    // 3) الوضع القديم (للمقارنة): كان بيستبدل بالاسم المحفوظ
    r = await run([{ name: "Talal Al-Faqir", phone: "0555349329", req: "30650" }], { campaignType: "draft_reminder_legacy_ctrl" });
    check("الوضع القديم كان بيستخدم الاسم المحفوظ (يثبت إن الاختبار حقيقي)", r.sent.length === 1 && /محمد طلال الفقير/.test(r.sent[0]));

    // 4) اسم عربي في الطلب نفسه: بيتبعت باسم الطلب مش المحفوظ
    r = await run([{ name: "طلال الفقير", phone: "0555349329", req: "30651" }], { campaignType: "card_pickup", messageSource: "SYSTEM_NOTIFICATION", nameFromRequestOnly: true });
    check("اسم عربي في الطلب → اتبعت باسم الطلب", r.sent.length === 1 && /طلال الفقير/.test(r.sent[0]) && !/محمد/.test(r.sent[0]));
  } catch (e) {
    console.error(e);
    ok = false;
  } finally {
    restore();
    console.log("♻️ تم استرجاع ملفات البيانات.");
  }
  console.log(ok ? "🎉 كل الفحوصات نجحت" : "❌ فيه فحوصات فشلت");
  process.exit(ok ? 0 : 1);
})();
