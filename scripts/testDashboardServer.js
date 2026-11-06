const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

// اختبار لوحة التحكم: المصادقة، حماية CSRF/Host، تعديل النصوص، إدارة الأشخاص، مكتبة الرسائل.
// بيعمل نسخة احتياطية من ملفات الحالة الحقيقية ويسترجعها في الآخر.
const ROOT = path.join(__dirname, "..");
const FILES = ["text_overrides.json", "admin_settings.json", "editor_settings.json", "staff_settings.json", "message_library.json"].map((f) => path.join(ROOT, f));
const backup = new Map(FILES.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));
function restore() {
  for (const [f, data] of backup) {
    if (data === null) { if (fs.existsSync(f)) fs.unlinkSync(f); } else fs.writeFileSync(f, data);
  }
}

const { start } = require("../lib/dashboardServer");
const PASSWORD = "test-pass-123";
const auth = "Basic " + Buffer.from("admin:" + PASSWORD).toString("base64");

function call(port, method, p, { body, headers = {}, noAuth, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { ...(noAuth ? {} : { Authorization: auth }), ...(host ? { Host: host } : {}), ...(data ? { "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const t = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const server = start({ getConnection: () => ({ state: "ready", number: "966500000000" }), getBusy: () => "", getQr: () => null, restart: () => {} }, { password: PASSWORD, port: 0 });
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const W = { "X-Dash": "1" };
  let n = 0;
  const ok = (m) => console.log(`✅ ${++n}: ${m}`);
  try {
    assert.strictEqual((await call(port, "GET", "/", { noAuth: true })).status, 401); ok("بدون كلمة سر = 401");
    assert.strictEqual((await call(port, "GET", "/api/status", { headers: { Authorization: "Basic " + Buffer.from("a:wrong").toString("base64") }, noAuth: true })).status, 401); ok("كلمة سر خاطئة = 401");
    assert.strictEqual((await call(port, "GET", "/", { host: "evil.example.com" })).status, 403); ok("Host غريب (DNS rebinding) = 403");
    const page = await call(port, "GET", "/");
    assert.strictEqual(page.status, 200); assert.ok(page.text.includes("لوحة تحكم البوت")); ok("الصفحة الرئيسية تفتح");

    const st = await call(port, "GET", "/api/status");
    assert.strictEqual(st.json.connection.state, "ready"); assert.ok(st.json.rate.hourly.limit > 0); ok("الحالة: الاتصال والحصص");

    assert.strictEqual((await call(port, "PUT", "/api/texts/MAIN_MENU", { body: { value: "x" } })).status, 403); ok("تعديل بدون هيدر X-Dash = 403");
    const texts = (await call(port, "GET", "/api/texts")).json;
    const tpl = texts.find((t) => t.key === "CARD_PICKUP_TEMPLATE");
    assert.ok(tpl && tpl.placeholders.includes("{name}") && !tpl.overridden); ok("قائمة النصوص بالمتغيرات");

    const bad = await call(port, "PUT", "/api/texts/CARD_PICKUP_TEMPLATE", { headers: W, body: { value: "مرحبا {nmae}" } });
    assert.strictEqual(bad.status, 400); ok("متغير غير مسموح يترفض");
    assert.strictEqual((await call(port, "PUT", "/api/texts/CARD_PICKUP_TEMPLATE", { headers: W, body: { value: "   " } })).status, 400); ok("نص فارغ يترفض");
    const good = await call(port, "PUT", "/api/texts/CARD_PICKUP_TEMPLATE", { headers: W, body: { value: "أهلًا {name}، بطاقتك جاهزة" } });
    assert.strictEqual(good.status, 200); assert.deepStrictEqual(good.json.missing, []);
    const textStore = require("../lib/textStore");
    assert.strictEqual(textStore.getText(require("../config"), "CARD_PICKUP_TEMPLATE"), "أهلًا {name}، بطاقتك جاهزة"); ok("تعديل النص يصل لمخزن البوت");
    const warn = await call(port, "PUT", "/api/texts/CARD_PICKUP_TEMPLATE", { headers: W, body: { value: "بطاقتك جاهزة" } });
    assert.deepStrictEqual(warn.json.missing, ["{name}"]); ok("حذف متغير = تنبيه");
    assert.strictEqual((await call(port, "DELETE", "/api/texts/CARD_PICKUP_TEMPLATE", { headers: W })).status, 200);
    assert.ok(!(await call(port, "GET", "/api/texts")).json.find((t) => t.key === "CARD_PICKUP_TEMPLATE").overridden); ok("استرجاع النص الأصلي");
    assert.strictEqual((await call(port, "PUT", "/api/texts/NOPE_KEY", { headers: W, body: { value: "x" } })).status, 400); ok("مفتاح غير معروف لا يُحفظ");

    const badP = await call(port, "POST", "/api/people", { headers: W, body: { role: "admin", phone: "123" } });
    assert.strictEqual(badP.status, 400); ok("رقم غير صحيح يترفض");
    const addP = await call(port, "POST", "/api/people", { headers: W, body: { role: "admin", phone: "0501234567" } });
    assert.ok(addP.json.added && addP.json.phone === "966501234567");
    assert.ok((await call(port, "GET", "/api/people")).json.admin.numbers.includes("966501234567")); ok("إضافة أدمن بصيغة موحّدة");
    assert.strictEqual((await call(port, "POST", "/api/people", { headers: W, body: { role: "admin", phone: "0501234567" } })).json.added, false); ok("تكرار الأدمن لا يُضاف");
    assert.ok((await call(port, "DELETE", "/api/people/admin/966501234567", { headers: W })).json.removed); ok("حذف أدمن");
    assert.strictEqual((await call(port, "POST", "/api/people", { headers: W, body: { role: "root", phone: "0501234567" } })).status, 400); ok("دور غير معروف يترفض");

    assert.strictEqual((await call(port, "POST", "/api/library", { headers: W, body: { title: "", text: "x" } })).status, 400);
    const it = (await call(port, "POST", "/api/library", { headers: W, body: { title: "تذكير", text: "نص\r\nالرسالة" } })).json.item;
    assert.strictEqual(it.text, "نص\nالرسالة"); ok("إضافة رسالة للمكتبة");
    const upd = await call(port, "PUT", "/api/library/" + it.id, { headers: W, body: { title: "تذكير 2", text: "جديد" } });
    assert.strictEqual(upd.json.item.title, "تذكير 2"); ok("تعديل رسالة بالمكتبة");
    assert.strictEqual((await call(port, "GET", "/api/library")).json.length >= 1, true);
    assert.ok((await call(port, "DELETE", "/api/library/" + it.id, { headers: W })).json.removed); ok("حذف رسالة من المكتبة");
    assert.strictEqual((await call(port, "GET", "/api/activity")).status, 200); ok("سجل النشاط");
    console.log(`\n✅ نجحت كل الاختبارات (${n})`);
  } catch (err) {
    console.log(`💥 فشل الاختبار: ${err.stack}`);
    process.exitCode = 1;
  } finally {
    server.close();
    restore();
    console.log("♻️ تم استرجاع ملفات الحالة الحقيقية زي ما كانت.");
  }
})();
