// فحص نسخ طلبات التوصيل للمجموعة العامة: بتوصل نسخة (نص + موقع) لكل طلب جديد بجانب مجموعة منطقته، من غير تكرار،
// ومن غير ما فشلها يأثّر على مسار الطلب الأصلي. Fake Client فقط، وملفات delivery_state بتتحفظ وتترجع.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const REAL = path.join(__dirname, "..", "delivery_state.json");
const files = [REAL, `${REAL}.bak`];
const backup = files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));
files.forEach((f) => fs.existsSync(f) && fs.unlinkSync(f));

(async () => {
  try {
    const store = require("../lib/deliveryStore");
    const flow = require("../lib/deliveryFlow");
    const log = [];
    const mk = (failFor = []) => ({
      sendMessage: async (to, payload) => {
        if (failFor.includes(to)) throw new Error("boom");
        log.push({ to, kind: payload && payload.latitude !== undefined ? "pin" : "text", text: typeof payload === "string" ? payload : "" });
        return true;
      },
    });
    const to = (id) => log.filter((l) => l.to === id);

    store.setGroup("NORTH", "north@g.us");
    store.setMirrorGroup("all@g.us");
    assert.strictEqual(store.getMirrorGroup(), "all@g.us");

    // 1) طلب بموقع: مجموعة المنطقة + العامة، كلاهما نص + pin
    let r = store.createRequest({ phone: "966500000001", name: "مزارع", regionKey: "NORTH", autoDetected: true, preferredDateTime: "الأحد", latitude: 26.6, longitude: 37.9 });
    let res = await flow.forwardRequest(mk(), r);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(to("north@g.us").map((l) => l.kind), ["text", "pin"]);
    assert.deepStrictEqual(to("all@g.us").map((l) => l.kind), ["text", "pin"]);
    assert.ok(/نسخة/.test(to("all@g.us")[0].text) && !/تم التوصيل D-/.test(to("all@g.us")[0].text), "نسخة من غير تعليمات الأمر");
    assert.ok(/تم التوصيل D-/.test(to("north@g.us")[0].text), "مجموعة المنطقة لسه فيها التعليمات");
    assert.strictEqual(store.findRequest(r.id).mirrored, true);

    // 2) إعادة الإرسال لنفس الطلب (بعد قراءته من الـstore) ما بتكررش النسخة العامة
    const before = to("all@g.us").length;
    await flow.forwardRequest(mk(), store.findRequest(r.id));
    assert.strictEqual(to("all@g.us").length, before, "ما اتكررتش النسخة");

    // 3) مجموعة المنطقة مش مربوطة (الوسط): العامة بتستلمها برضه، والنتيجة no_group_linked
    log.length = 0;
    r = store.createRequest({ phone: "966500000002", name: "ثاني", regionKey: "CENTER", preferredDateTime: "الأربعاء" });
    res = await flow.forwardRequest(mk(), r);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "no_group_linked");
    assert.deepStrictEqual(to("all@g.us").map((l) => l.kind), ["text"], "من غير موقع = نص بس");

    // 4) فشل المجموعة العامة ما يأثرش على نجاح مجموعة المنطقة
    log.length = 0;
    r = store.createRequest({ phone: "966500000003", name: "ثالث", regionKey: "NORTH", preferredDateTime: "اليوم" });
    res = await flow.forwardRequest(mk(["all@g.us"]), r);
    assert.strictEqual(res.ok, true);
    assert.ok(to("north@g.us").length >= 1);
    assert.ok(!store.findRequest(r.id).mirrored, "ما اتعلّمتش منسوخة لأنها فشلت");

    // 5) من غير مجموعة عامة: ما فيش نسخ
    assert.strictEqual(store.clearMirrorGroup(), true);
    log.length = 0;
    r = store.createRequest({ phone: "966500000004", name: "رابع", regionKey: "NORTH", preferredDateTime: "اليوم" });
    await flow.forwardRequest(mk(), r);
    assert.strictEqual(to("all@g.us").length, 0);
    assert.strictEqual(store.clearMirrorGroup(), false);
    console.log("✅ كل الفحوصات نجحت (5 سيناريوهات)");
  } finally {
    files.forEach((f, i) => {
      if (backup[i] === null) { if (fs.existsSync(f)) fs.unlinkSync(f); } else fs.writeFileSync(f, backup[i]);
    });
  }
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
