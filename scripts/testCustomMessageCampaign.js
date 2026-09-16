// اختبار كامل لميزة "رسائل مخصصة" (رفع ملف -> معاينة -> تأكيد -> إرسال -> إعادة محاولة الفاشل)
// من غير أي اتصال حقيقي بواتساب - بيستخدم عميل وهمي (fakeClient) بدل الحقيقي.
// شغّله بالأمر: node scripts/testCustomMessageCampaign.js

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const { parseCustomMessageRows } = require(path.join(__dirname, "..", "lib", "fileIngest"));
const { normalizeSaudiPhone, isValidSaudiPhone } = require(path.join(__dirname, "..", "lib", "phoneUtil"));
const { buildCampaignRows, summarizeCampaignRows } = require(path.join(__dirname, "..", "lib", "campaignBuilder"));
const campaignStore = require(path.join(__dirname, "..", "lib", "campaignStore"));
const { sendCampaignRows } = require(path.join(__dirname, "..", "lib", "campaignRunner"));

let passed = 0;
function check(label, condition) {
  assert(condition, `❌ FAILED: ${label}`);
  console.log(`✅ ${label}`);
  passed++;
}

// الإرسال دلوقتي بيعدّي على safeFarmerSend اللي بتكتب send_fingerprints.json و
// rate_limit_state.json و farmer_state.json - بنعمل نسخة احتياطية منهم ونرجّعهم زي ما كانوا
// في الآخر عشان أرقام الاختبار الوهمية متسيبش أثر في بيانات المشروع الحقيقية
const ROOT = path.join(__dirname, "..");
const STATE_FILES = [
  "send_fingerprints.json",
  "send_fingerprints.json.bak",
  "rate_limit_state.json",
  "farmer_state.json",
  "farmer_state.json.bak",
  "sent_history.json",
  "sent_history.json.bak",
];
function snapshotStateFiles() {
  const snap = {};
  STATE_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    snap[name] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  });
  return snap;
}
function restoreStateFiles(snap) {
  STATE_FILES.forEach((name) => {
    const p = path.join(ROOT, name);
    if (snap[name] === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, snap[name]);
    }
  });
}
const _stateSnapshot = snapshotStateFiles();

(async () => {
  console.log("=== 1) تطبيع والتحقق من صيغ الجوال ===");
  check("محلي 05xxxxxxxx", normalizeSaudiPhone("0512345678") === "966512345678");
  check("دولي +9665xxxxxxxx", normalizeSaudiPhone("+966512345678") === "966512345678");
  check("دولي 009665xxxxxxxx", normalizeSaudiPhone("00966512345678") === "966512345678");
  check("بدون كود دولة 5xxxxxxxx", normalizeSaudiPhone("512345678") === "966512345678");
  check("أرقام عربية ٠٥١٢٣٤٥٦٧٨", normalizeSaudiPhone("٠٥١٢٣٤٥٦٧٨") === "966512345678");
  check("رقم صحيح يتقبل", isValidSaudiPhone(normalizeSaudiPhone("0512345678")));
  check("رقم قصير يترفض", !isValidSaudiPhone(normalizeSaudiPhone("12345")));

  console.log("\n=== 2) قراءة ملف CSV فيه فاصلة وسطر جديد جوه الرسالة ===");
  // ملف CSV حقيقي بصيغة الاقتباسات (RFC4180): رسالة فيها فاصلة وسطر جديد جوه علامتي اقتباس
  const csvContent =
    "الاسم,رقم الجوال,الرسالة\n" +
    'أحمد محمد,0512345678,"مرحبًا أحمد، نتمنى لك يومًا سعيدًا.\nنشكرك على تعاونك."\n' +
    "سارة علي,0523456789,رسالة عادية من غير فاصلة\n" +
    "خالد فهد,invalidphone,رسالة لرقم غلط\n" +
    "نفس الرقم مرة تانية,0512345678,رسالة مكررة\n" +
    "بدون رسالة,0534567890,\n";
  const buffer = Buffer.from(csvContent, "utf8");
  const rawRows = parseCustomMessageRows(buffer);

  check("عدد الصفوف المستخرجة = 5", rawRows.length === 5);
  check(
    "الرسالة الأولى فيها فاصلة وسطر جديد سليمين",
    rawRows[0].message === "مرحبًا أحمد، نتمنى لك يومًا سعيدًا.\nنشكرك على تعاونك."
  );
  check("الصف التاني (من غير فاصلة) اتقرا صح", rawRows[1].name === "سارة علي" && rawRows[1].phone === "0523456789");

  console.log("\n=== 3) بناء صفوف الحملة (فلترة/تطبيع/استبعاد مكرر) ===");
  const campaignRows = buildCampaignRows(rawRows);
  const counts = summarizeCampaignRows(campaignRows);

  check("2 صف صالح للإرسال (أحمد وسارة)", counts.valid === 2);
  check("2 صف جوال غير صحيح/رسالة فاضية (خالد + بدون رسالة)", counts.invalid_phone === 2);
  check("صف واحد مكرر (نفس رقم أحمد)", counts.duplicate === 1);
  check(
    "الصف الرابع (نفس رقم أحمد) اتعلّم duplicate مش pending",
    campaignRows[3].status === "duplicate"
  );

  console.log("\n=== 4) إنشاء حملة حقيقية واختبار الإرسال بعميل وهمي ===");
  const campaignId = campaignStore.createCampaign({
    label: "رسائل مخصصة (اختبار)",
    createdBy: "test@c.us",
    rows: campaignRows,
  });
  check("اتحفظت الحملة ورجع معرّف", typeof campaignId === "string" && campaignId.length > 0);

  const sentTo = [];
  // عميل وهمي: أحمد بيتبعتله بنجاح، سارة رقمها "مش مسجل على واتساب"، عشان نختبر الحالتين
  const fakeClient = {
    async getNumberId(phone) {
      if (phone === "966523456789") return null; // سارة: مش مسجلة
      return { _serialized: `${phone}@c.us` };
    },
    async sendMessage(to, text) {
      sentTo.push({ to, text });
      return true;
    },
  };

  const summary1 = await sendCampaignRows(fakeClient, campaignId);
  check("النتيجة: sent=1, notOnWhatsapp=1", summary1.sent === 1 && summary1.notOnWhatsapp === 1);
  check("فعليًا اتبعت رسالة واحدة بس (لأحمد)", sentTo.length === 1 && sentTo[0].to === "966512345678@c.us");

  const afterFirstRun = campaignStore.getCampaign(campaignId);
  const pendingAfter = afterFirstRun.rows.filter((r) => r.status === "pending").length;
  check("مفيش صفوف pending متبقية بعد أول إرسال", pendingAfter === 0);

  console.log("\n=== 5) منع تكرار التنفيذ (تأكيد إرسال مرة تانية على حملة خلصت) ===");
  const summary2 = await sendCampaignRows(fakeClient, campaignId);
  check("تشغيل تاني على نفس الحملة مبيبعتش أي حاجة (0 صفوف pending)", summary2.total === 0);
  check("العدد الإجمالي المُرسل فعليًا فضل 1 بس (مفيش تكرار)", sentTo.length === 1);

  console.log("\n=== 6) إعادة محاولة الفاشل بس (سارة اللي كانت not_on_whatsapp) ===");
  const resetCount = campaignStore.resetFailedRows(campaignId);
  check("اتصفّر صف واحد بس (سارة)", resetCount === 1);

  // في المحاولة التانية، سارة بقت "متسجلة" (زي لو ثبّتت واتساب بعد كده)
  const fakeClient2 = {
    async getNumberId(phone) {
      return { _serialized: `${phone}@c.us` };
    },
    async sendMessage(to, text) {
      sentTo.push({ to, text });
      return true;
    },
  };
  const summary3 = await sendCampaignRows(fakeClient2, campaignId);
  check("إعادة المحاولة بعتت لسارة بس (1 صف)", summary3.total === 1 && summary3.sent === 1);
  check("إجمالي المُرسل بقى 2 (أحمد + سارة)", sentTo.length === 2);

  const finalCampaign = campaignStore.getCampaign(campaignId);
  const allResolved = finalCampaign.rows.every((r) => r.status !== "pending");
  check("كل صفوف الحملة اتحسمت (مفيش pending باقي)", allResolved);

  console.log("\n=== 7) استكمال بعد 'كراش' (محاكاة) ===");
  // بنعمل حملة تانية فيها 3 صفوف صالحة، ونحاكي كراش بعد أول صف بس (عميل بيرمي خطأ من التاني)
  const crashRows = buildCampaignRows([
    { name: "واحد", phone: "0511111111", message: "رسالة 1" },
    { name: "اتنين", phone: "0522222222", message: "رسالة 2" },
    { name: "تلاتة", phone: "0533333333", message: "رسالة 3" },
  ]);
  const crashCampaignId = campaignStore.createCampaign({ label: "اختبار استكمال", rows: crashRows });

  let callCount = 0;
  const crashClient = {
    async getNumberId(phone) {
      callCount++;
      if (callCount === 2) throw new Error("انقطاع شبكة محاكى");
      return { _serialized: `${phone}@c.us` };
    },
    async sendMessage() {
      return true;
    },
  };
  const summaryCrash = await sendCampaignRows(crashClient, crashCampaignId);
  check("من 3 صفوف: 2 نجحوا و1 فشل (محاكاة انقطاع)", summaryCrash.sent === 2 && summaryCrash.failed === 1);

  const afterCrash = campaignStore.getCampaign(crashCampaignId);
  check(
    "الصف اللي فشل اتسجّل 'failed' مش 'pending' (يعني التقدم محفوظ فعلًا)",
    afterCrash.rows.filter((r) => r.status === "failed").length === 1
  );

  // تنظيف ملفات الاختبار عشان منسيبش أثر في مجلد campaigns الحقيقي
  [campaignId, crashCampaignId].forEach((id) => {
    const file = path.join(__dirname, "..", "campaigns", `${id}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  console.log(`\n🎉 كل الاختبارات نجحت (${passed} اختبار). الميزة شغالة صح من غير أي رسالة حقيقية اتبعتت.`);
})()
  .catch((err) => {
    console.error("\n💥 فشل الاختبار:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreStateFiles(_stateSnapshot);
    console.log("♻️ تم استرجاع ملفات الحالة الحقيقية زي ما كانت.");
  });
