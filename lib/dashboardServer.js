const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const cfg = require("../config");
const textStore = require("./textStore");
const adminStore = require("./adminStore");
const editorStore = require("./editorStore");
const staffStore = require("./staffStore");
const messageLibrary = require("./messageLibrary");
const rateLimiter = require("./rateLimiter");
const auditLog = require("./auditLog");
const messagingDashboard = require("./messagingDashboard");
const { normalizeSaudiPhone, isValidSaudiPhone } = require("./phoneUtil");

// لوحة تحكم البوت: صفحة ويب بيقدّمها البوت نفسه (من غير أي مكتبة جديدة). مربوطة على 127.0.0.1 افتراضيًا
// (مش مفتوحة للشبكة) ومحمية بكلمة سر (Basic Auth) بتتولّد تلقائيًا في dashboard_password.txt أول مرة.
// بتعرض حالة الاتصال والحصص، وبتعدّل نصوص الرسائل، وبتدير الأدمن/المحررين/موظفي الخدمة، ومكتبة رسائل جاهزة.
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const PORT = parseInt(process.env.DASHBOARD_PORT || "4020", 10);
const PASSWORD_FILE = path.join(__dirname, "..", "dashboard_password.txt");
const PAGE_FILE = path.join(__dirname, "..", "dashboard", "index.html");
const MAX_BODY = 200 * 1024;

// تسمية عربية وتجميع لكل نص في config.js. أي مفتاح نصي جديد مش هنا بيظهر تحت "أخرى" باسمه الخام.
const TEXT_META = {
  MAIN_MENU: ["القائمة الرئيسية", "ردود المزارعين"],
  MAIN_MENU_PREVIEW: ["معاينة القائمة", "ردود المزارعين"],
  INVALID_CHOICE: ["اختيار غير مفهوم", "ردود المزارعين"],
  MENU_FOOTER: ["تذييل الرجوع للقائمة", "ردود المزارعين"],
  COMPLAINT_INTRO: ["مقدمة الشكاوى والاقتراحات", "ردود المزارعين"],
  COMPLAINT_THANKS: ["شكر على الشكوى", "ردود المزارعين"],
  HUMAN_HANDOFF: ["التحويل لموظف (أثناء الدوام)", "ردود المزارعين"],
  HUMAN_HANDOFF_OUT_OF_HOURS: ["التحويل لموظف (خارج الدوام)", "ردود المزارعين"],
  REGISTRATION_LINK: ["رابط التسجيل", "روابط"],
  DELIVERY_PICKUP_CONFIRM: ["تأكيد اختيار الاستلام", "توصيل البطاقات"],
  DELIVERY_ASK_REGION: ["طلب موقع المزارع", "توصيل البطاقات"],
  DELIVERY_REMINDER_CHOICE: ["تذكير باختيار (استلام/توصيل)", "توصيل البطاقات"],
  DELIVERY_REMINDER_REGION: ["تذكير بإرسال الموقع", "توصيل البطاقات"],
  DELIVERY_LOCATION_UNKNOWN: ["تعذّر تحديد المنطقة", "توصيل البطاقات"],
  DELIVERY_ASK_DATETIME: ["طلب اليوم والوقت", "توصيل البطاقات"],
  DELIVERY_REGION_CORRECTED: ["تصحيح المنطقة تلقائيًا", "توصيل البطاقات"],
  DELIVERY_OUTSIDE_HOURS: ["الوقت خارج ساعات التوصيل", "توصيل البطاقات"],
  DELIVERY_OUTSIDE_DAYS: ["اليوم خارج أيام التوصيل", "توصيل البطاقات"],
  DELIVERY_FAILED_NOTICE: ["إشعار تعذّر التوصيل", "توصيل البطاقات"],
  DELIVERY_REMINDER_DATETIME: ["تذكير بالموعد", "توصيل البطاقات"],
  DELIVERY_NEED_DAY: ["ينقص اليوم", "توصيل البطاقات"],
  DELIVERY_NEED_TIME: ["ينقص الوقت", "توصيل البطاقات"],
  DELIVERY_THANKS: ["تأكيد طلب التوصيل", "توصيل البطاقات"],
  REGISTRATION_STATUS_TEMPLATE: ["حالة التسجيل (تحت المراجعة)", "إشعارات وحملات"],
  CARD_PICKUP_TEMPLATE: ["جاهزية البطاقة", "إشعارات وحملات"],
  PRODUCTION_SURVEY_TEMPLATE: ["استبيان الإنتاج الزراعي", "إشعارات وحملات"],
  DOCUMENTS_REQUEST_TEMPLATE: ["طلب استكمال مستندات", "إشعارات وحملات"],
  REGISTRATION_INVITATION_TEMPLATE: ["دعوة التسجيل", "إشعارات وحملات"],
  DRAFT_REMINDER_TEMPLATE: ["تذكير باستكمال الطلب", "إشعارات وحملات"],
  CUSTOM_MESSAGE_TEMPLATE: ["قالب الرسالة المخصصة", "إشعارات وحملات"],
};

const ROLES = {
  admin: { label: "أدمن (يتحكم بالبوت)", store: adminStore, get: () => adminStore.getAdmins(), add: (p) => adminStore.addAdmin(p), remove: (p) => adminStore.removeAdmin(p) },
  editor: { label: "محرر (أوامر التحكم من رقمه)", store: editorStore, get: () => editorStore.getEditors(), add: (p) => editorStore.addEditor(p), remove: (p) => editorStore.removeEditor(p) },
  staff: { label: "موظف خدمة المزارعين", store: staffStore, get: () => staffStore.getStaff(), add: (p) => staffStore.addStaff(p), remove: (p) => staffStore.removeStaff(p) },
};

function placeholders(text) {
  return [...new Set((String(text).match(/\{\w+\}/g) || []))];
}

function textKeys() {
  return Object.keys(cfg).filter((k) => typeof cfg[k] === "string");
}

function listTexts() {
  const overrides = textStore.load();
  return textKeys().map((key) => {
    const meta = TEXT_META[key] || [key, "أخرى"];
    return {
      key,
      label: meta[0],
      group: meta[1],
      value: overrides[key] !== undefined ? overrides[key] : cfg[key],
      defaultValue: cfg[key],
      overridden: overrides[key] !== undefined,
      placeholders: placeholders(cfg[key]),
    };
  });
}

function saveText(key, value) {
  if (!textKeys().includes(key)) throw new Error("نص غير معروف");
  const text = String(value === undefined ? "" : value).replace(/\r\n/g, "\n");
  if (!text.trim()) throw new Error("النص لا يمكن أن يكون فارغًا");
  if (text.length > 4000) throw new Error("النص أطول من 4000 حرف");
  const allowed = new Set(placeholders(cfg[key]));
  const used = placeholders(text);
  const unknown = used.filter((p) => !allowed.has(p));
  if (unknown.length) throw new Error(`متغيرات غير مسموحة: ${unknown.join(" ")}. المسموح: ${[...allowed].join(" ") || "لا شيء"}`);
  const missing = [...allowed].filter((p) => !used.includes(p));
  textStore.setOverride(key, text);
  return { missing };
}

function maskPhone(p) {
  const s = String(p || "");
  return s.length > 6 ? `${s.slice(0, 3)}••••${s.slice(-3)}` : s;
}

function people() {
  const out = {};
  for (const [role, def] of Object.entries(ROLES)) out[role] = { label: def.label, numbers: def.get() };
  out.configAdmins = { label: "أدمن ثابتون من config.js (للقراءة فقط)", numbers: Array.isArray(cfg.ADMIN_NUMBERS) ? cfg.ADMIN_NUMBERS : [] };
  return out;
}

function status(deps) {
  const rate = rateLimiter.getStatus();
  let dash = null;
  try {
    dash = messagingDashboard.getDashboard();
  } catch {
    dash = null;
  }
  const conn = deps.getConnection();
  return {
    connection: conn,
    uptimeSec: Math.round(process.uptime()),
    busy: deps.getBusy ? deps.getBusy() : "",
    rate: { hourly: rate.hourly, daily: rate.daily, paused: rate.paused },
    today: dash ? { campaigns: dash.campaigns.today, notifications: dash.systemNotifications.sentToday } : null,
    texts: { total: textKeys().length, overridden: Object.keys(textStore.load()).filter((k) => textKeys().includes(k)).length },
    people: { admins: adminStore.getAdmins().length, editors: editorStore.getEditors().length, staff: staffStore.getStaff().length },
    serverTime: new Date().toISOString(),
  };
}

function activity() {
  return auditLog
    .readRecent(512 * 1024)
    .slice(-40)
    .reverse()
    .map((e) => ({ at: e.timestamp, decision: e.decision, source: e.messageSource, type: e.campaignType || e.campaignPurpose, phone: maskPhone(e.normalizedPhone), reason: e.reason }));
}

function loadOrCreatePassword() {
  try {
    const existing = fs.readFileSync(PASSWORD_FILE, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const pwd = crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "x").slice(0, 12);
  fs.writeFileSync(PASSWORD_FILE, pwd + "\n", "utf8");
  return pwd;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sendJson(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("الطلب كبير جدًا"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("صيغة JSON غير صحيحة"));
      }
    });
    req.on("error", reject);
  });
}

function createHandler(deps, password) {
  return async (req, res) => {
    try {
      // حماية DNS-rebinding: لازم الـHost يكون العنوان اللي اتربطنا عليه (أو localhost)
      const host = String(req.headers.host || "").replace(/:\d+$/, "");
      if (!["127.0.0.1", "localhost", "[::1]", HOST].includes(host)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      const auth = String(req.headers.authorization || "");
      const decoded = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : "";
      const pwd = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : "";
      if (!decoded || !safeEqual(pwd, password)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Bot Dashboard", charset="UTF-8"' });
        return res.end("Unauthorized");
      }

      const url = new URL(req.url, `http://${host}`);
      const p = url.pathname;
      const m = req.method;

      if (m === "GET" && (p === "/" || p === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(fs.readFileSync(PAGE_FILE));
      }
      if (!p.startsWith("/api/")) {
        res.writeHead(404);
        return res.end("Not found");
      }
      // أي تعديل لازم يجي بهيدر مخصص - بيمنع طلبات من مواقع تانية (CSRF) لأن المتصفح بيتطلب preflight ليه
      if (m !== "GET" && req.headers["x-dash"] !== "1") return sendJson(res, 403, { error: "طلب غير مصرّح" });

      if (m === "GET" && p === "/api/status") return sendJson(res, 200, status(deps));
      if (m === "GET" && p === "/api/activity") return sendJson(res, 200, activity());
      if (m === "GET" && p === "/api/texts") return sendJson(res, 200, listTexts());
      if (m === "GET" && p === "/api/people") return sendJson(res, 200, people());
      if (m === "GET" && p === "/api/library") return sendJson(res, 200, messageLibrary.list());
      if (m === "GET" && p === "/api/qr") {
        const qr = deps.getQr ? deps.getQr() : null;
        if (!qr) return sendJson(res, 200, { svg: null });
        return sendJson(res, 200, { svg: require("./qrFile").qrSvg(qr, 6, 3) });
      }

      let mt;
      if ((mt = p.match(/^\/api\/texts\/([A-Z_]+)$/))) {
        const key = mt[1];
        if (m === "PUT") {
          const body = await readJson(req);
          return sendJson(res, 200, { ok: true, ...saveText(key, body.value) });
        }
        if (m === "DELETE") {
          if (!textKeys().includes(key)) return sendJson(res, 404, { error: "نص غير معروف" });
          textStore.clearOverride(key);
          return sendJson(res, 200, { ok: true });
        }
      }

      if (p === "/api/people" && m === "POST") {
        const body = await readJson(req);
        const def = ROLES[body.role];
        if (!def) return sendJson(res, 400, { error: "الدور غير معروف" });
        const phone = normalizeSaudiPhone(body.phone);
        if (!isValidSaudiPhone(phone)) return sendJson(res, 400, { error: "رقم الجوال غير صحيح (مثال: 0501234567)" });
        const added = def.add(phone);
        return sendJson(res, 200, { ok: true, added, phone });
      }
      if ((mt = p.match(/^\/api\/people\/(admin|editor|staff)\/(\d+)$/)) && m === "DELETE") {
        const removed = ROLES[mt[1]].remove(mt[2]);
        return sendJson(res, 200, { ok: true, removed });
      }

      if (p === "/api/library" && m === "POST") {
        const body = await readJson(req);
        return sendJson(res, 200, { ok: true, item: messageLibrary.add(body) });
      }
      if ((mt = p.match(/^\/api\/library\/(m\d+)$/))) {
        if (m === "PUT") {
          const body = await readJson(req);
          const item = messageLibrary.update(mt[1], body);
          return item ? sendJson(res, 200, { ok: true, item }) : sendJson(res, 404, { error: "الرسالة غير موجودة" });
        }
        if (m === "DELETE") return sendJson(res, 200, { ok: true, removed: messageLibrary.remove(mt[1]) });
      }

      if (p === "/api/restart" && m === "POST") {
        if (!deps.restart) return sendJson(res, 501, { error: "إعادة التشغيل غير متاحة" });
        sendJson(res, 200, { ok: true });
        setTimeout(() => deps.restart(), 500);
        return;
      }
      return sendJson(res, 404, { error: "غير موجود" });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || "خطأ" });
    }
  };
}

// deps: { getConnection(), getBusy?(), getQr?(), restart?() } - بتتحقن من index.js (أو من الاختبار)
function start(deps, opts = {}) {
  const password = opts.password || loadOrCreatePassword();
  const port = opts.port !== undefined ? opts.port : PORT;
  const server = http.createServer(createHandler(deps, password));
  server.on("error", (err) => console.log(`⚠️ [لوحة التحكم] تعذّر التشغيل: ${err.message}`));
  server.listen(port, HOST, () => {
    const addr = server.address();
    console.log(`🖥️ [لوحة التحكم] http://${HOST}:${addr.port} - المستخدم: أي اسم، كلمة السر في ملف dashboard_password.txt`);
  });
  return server;
}

module.exports = { start, createHandler, listTexts, saveText, placeholders, PASSWORD_FILE };
