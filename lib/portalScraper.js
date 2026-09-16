// بيسجّل دخول لنظام بطاقات مركز الزراعة (حساب مشاهد فقط) ويستخرج:
// - البطاقات المطبوعة الجاهزة للتسليم (تاب "Printed")
// - الطلبات الجديدة في انتظار الطباعة (كارت إحصائية "Pending Printing")
//
// ملاحظة: الصفحتين ديناميكيتين (React/Angular)، فمحتاجين Puppeteer عشان نشغّل الجافاسكريبت
// ونستنى الجدول يتحمّل، مش مجرد تحميل HTML خام.

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "portal_config.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      'ملف portal_config.js مش موجود. انسخ portal_config.example.js وسمّيه portal_config.js واملأ بياناتك.'
    );
  }
  return require(CONFIG_PATH);
}

// بيحدّث اليوزر نيم والباسورد بس في portal_config.js، وبيحافظ على باقي الإعدادات (الروابط..إلخ)
// زي ما هي لو الملف موجود بالفعل، أو بيستخدم قيم افتراضية معقولة لو الملف مش موجود أصلًا
function saveCredentials(username, password) {
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      delete require.cache[require.resolve(CONFIG_PATH)];
      existing = require(CONFIG_PATH);
    } catch {
      existing = {};
    }
  }

  const merged = {
    LOGIN_URL: existing.LOGIN_URL || "https://agriculture.rcu.gov.sa/portal-selector",
    USERNAME: username,
    PASSWORD: password,
    ISSUING_URL: existing.ISSUING_URL || "https://agriculture.rcu.gov.sa/portals/smartcard-issuing",
    REGISTRATION_REVIEW_URL:
      existing.REGISTRATION_REVIEW_URL || "https://agriculture.rcu.gov.sa/portals/smartcard-registeration-review",
    DRAFT_FORMS_URL: existing.DRAFT_FORMS_URL || "https://agriculture.rcu.gov.sa/portals/smartcard-registration-form",
    CHECK_INTERVAL_MINUTES: existing.CHECK_INTERVAL_MINUTES || 60,
  };

  const fileContent =
    `// اتعمل/اتحدّث تلقائيًا بواسطة أمر "تسجيل بيانات المنصة" من واتساب - آخر تحديث: ${new Date().toISOString()}\n` +
    `module.exports = ${JSON.stringify(merged, null, 2)};\n`;

  fs.writeFileSync(CONFIG_PATH, fileContent, "utf8");
  try {
    delete require.cache[require.resolve(CONFIG_PATH)];
  } catch {
    // الملف لسه مكانش موجود قبل كده، مفيش cache نمسحه
  }
}

// بيدور جوه أي جدول في الصفحة، وبيستخرج (الاسم + رقم الجوال + رقم الهوية) من كل صف
// عن طريق البحث عن نمط رقم جوال سعودي ونمط رقم هوية/إقامة سعودي جوه نص كل صف،
// بدل ما يعتمد على ترتيب أعمدة ثابت. رقم الهوية بيتستخدم كمفتاح مطابقة إضافي بجانب الجوال
// عشان نضمن إن نفس المزارع (بطاقة جاهزة أو رفيو) منبعتلوش رسالة درافت غلط حتى لو رقم جواله مختلف شوية
async function scrapeVisibleTable(page, forcedStatus) {
  return await page.evaluate((forcedStatus) => {
    const rows = Array.from(document.querySelectorAll("table tbody tr"));
    return rows
      .map((row) => {
        const rowText = row.innerText || "";
        const phoneMatch = rowText.match(/\+?9665\d{8}/);
        // رقم الهوية الوطنية أو الإقامة السعودي: 10 أرقام تبدأ بـ 1 أو 2
        const idMatch = rowText.match(/\b[12]\d{9}\b/);
        if (!phoneMatch && !idMatch) return null;

        const phone = phoneMatch ? phoneMatch[0].replace(/[^\d]/g, "") : "";
        const nationalId = idMatch ? idMatch[0] : "";
        const lines = rowText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        // اسم المزارع غالبًا السطر اللي قبل سطر رقم الجوال (أو رقم الهوية لو الجوال مش ظاهر) مباشرة
        const anchorText = phoneMatch ? phoneMatch[0] : idMatch[0];
        const anchorLineIdx = lines.findIndex((l) => l.includes(anchorText));
        const name = anchorLineIdx > 0 ? lines[anchorLineIdx - 1] : lines[0] || "";

        // رقم النموذج (Form #) غالبًا أول خلية في الصف
        const cells = Array.from(row.querySelectorAll("td"));
        const formNumber = cells[0] ? cells[0].innerText.trim().replace(/\s+/g, " ") : "";

        // تاريخ التقديم (عمود "Submitted" في صفحة الرفيو) لو موجود بصيغة شهر/يوم/سنة
        const dateMatch = rowText.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
        const submittedDate = dateMatch ? dateMatch[0] : "";

        return { name, phone, nationalId, formNumber, status: forcedStatus || "", submittedDate };
      })
      .filter(Boolean);
  }, forcedStatus || "");
}

// بيدوّر على زرار "الصفحة التالية" في الجدول (pagination) ويدوس عليه لو موجود ومش متعطّل
// بيرجع true لو نجح في الانتقال لصفحة جديدة، false لو معندناش صفحات زيادة
async function goToNextPage(page) {
  return await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
    const nextBtn = candidates.find((b) => {
      const label = (b.getAttribute("aria-label") || "").trim().toLowerCase();
      const text = (b.textContent || "").trim().toLowerCase();
      return label === "next page" || label === "next" || label.includes("next") || text === "next" || text === ">";
    });
    if (!nextBtn) return false;
    const isDisabled =
      nextBtn.disabled ||
      nextBtn.getAttribute("aria-disabled") === "true" ||
      nextBtn.getAttribute("disabled") !== null ||
      nextBtn.classList.contains("disabled") ||
      nextBtn.classList.contains("Mui-disabled");
    if (isDisabled) return false;
    if (typeof nextBtn.click === "function") {
      nextBtn.click();
    } else {
      nextBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    return true;
  });
}

// بيفتح لحد maxExpand صف واحد واحد (بالدوس على سهم التوسيع) عشان يقرا "NAME (AR)" - الاسم
// بالعربي - الظاهر بس جوه تفاصيل الصف المفتوحة. لو مالقاش اسم عربي، بيرجع الاسم الإنجليزي بدله.
// بيعدّي على كل صفحات الجدول (pagination) لغاية ما يوصل maxExpand أو تخلص الصفحات -
// من غير كده كان بيقرا بس أول صفحة (10-12 صف) ويفضل يستبعد باقي المزارعين غلط.
async function scrapeTableWithArabicNames(page, maxExpand, forcedStatus) {
  const results = [];
  let pageGuard = 0;

  while (results.length < maxExpand && pageGuard < 50) {
    pageGuard++;

    const mainRowCount = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.filter((r) => /^\d+$/.test((r.querySelector("td")?.innerText || "").trim())).length;
    });

    if (mainRowCount === 0) break;

    const remaining = maxExpand - results.length;
    const limit = Math.min(mainRowCount, remaining);

    for (let i = 0; i < limit; i++) {
      // بنقرا رقم الطلب (ثابت ومميّز لكل صف) ونضغط على زرار التوسيع في نفس استدعاء evaluate واحد،
      // ونستخدم رقم الطلب ده (مش رقم الصف الترتيبي) عشان نلاقي نفس الصف تاني بعد كده - لأن الجدول
      // بيستقبل طلبات جديدة باستمرار، ولو الترتيب اتغيّر في الفترة (حتى لو أجزاء من الثانية) بين
      // الضغط وقراءة التفاصيل، هيبقى رقم الصف (index) بيشاور على صف تاني خالص، وده كان بيسبب ربط
      // بيانات مزارع برقم طلب/جوال مزارع تاني تمامًا (نفس المشكلة اللي ظهرت مع صفحة الدرافت)
      const opened = await page.evaluate((index) => {
        const rows = Array.from(document.querySelectorAll("table tbody tr"));
        const mainRows = rows.filter((r) => /^\d+$/.test((r.querySelector("td")?.innerText || "").trim()));
        const row = mainRows[index];
        if (!row) return { ok: false };
        const formNumber = (row.querySelector("td")?.innerText || "").trim();
        const toggle = row.querySelector("button") || row.querySelector("svg") || row.querySelector("td");
        if (!toggle) return { ok: false };
        // عناصر الـSVG معندهاش دالة click() أصلًا (بعكس الأزرار والخلايا العادية)، فبنستخدم
        // dispatchEvent بدل click() عشان يشتغل مع أي نوع عنصر (السبب اللي كان بيسبب "toggle.click is not a function")
        if (typeof toggle.click === "function") {
          toggle.click();
        } else {
          toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
        return { ok: true, formNumber };
      }, i);
      if (!opened.ok) break;

      await sleep(400);

      const info = await page.evaluate((targetFormNumber) => {
        const rows = Array.from(document.querySelectorAll("table tbody tr"));
        const mainRows = rows.filter((r) => /^\d+$/.test((r.querySelector("td")?.innerText || "").trim()));
        // بنلاقي نفس الصف اللي اتفتح بالظبط عن طريق رقم الطلب، مش رقم ترتيبه في الجدول
        const row = mainRows.find((r) => (r.querySelector("td")?.innerText || "").trim() === targetFormNumber);
        if (!row) return null;

        const rowText = row.innerText || "";
        const phoneMatch = rowText.match(/\+?9665\d{8}/);
        const idMatch = rowText.match(/\b[12]\d{9}\b/);
        const cells = Array.from(row.querySelectorAll("td"));
        const formNumber = cells[0] ? cells[0].innerText.trim().replace(/\s+/g, " ") : "";
        const dateMatch = rowText.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
        const submittedDate = dateMatch ? dateMatch[0] : "";

        const lines = rowText.split("\n").map((l) => l.trim()).filter(Boolean);
        const anchorText = phoneMatch ? phoneMatch[0] : idMatch ? idMatch[0] : "";
        const anchorLineIdx = anchorText ? lines.findIndex((l) => l.includes(anchorText)) : -1;
        const englishName = anchorLineIdx > 0 ? lines[anchorLineIdx - 1] : lines[0] || "";

        // الاسم بالعربي ظاهر في تفاصيل الصف المفتوحة (الصف اللي بعده مباشرة) تحت تسمية "NAME (AR)"
        const detailRow = row.nextElementSibling;
        const detailText = detailRow ? detailRow.innerText || "" : "";
        const detailLines = detailText.split("\n").map((l) => l.trim()).filter(Boolean);
        const nameArIdx = detailLines.findIndex((l) => /^name\s*\(ar\)$/i.test(l));
        const arabicName = nameArIdx >= 0 ? detailLines[nameArIdx + 1] || "" : "";

        return {
          name: arabicName || englishName,
          phone: phoneMatch ? phoneMatch[0].replace(/[^\d]/g, "") : "",
          nationalId: idMatch ? idMatch[0] : "",
          formNumber,
          submittedDate,
        };
      }, opened.formNumber);

      if (info && (info.phone || info.nationalId)) {
        results.push({ ...info, status: forcedStatus || "" });
      }
    }

    if (results.length >= maxExpand) break;

    const advanced = await goToNextPage(page);
    if (!advanced) break;
    await sleep(800);
  }

  return results;
}

// بيحوّل تاريخ بصيغة شهر/يوم/سنة (زي "9/2/2026" الظاهر في عمود Submitted) لكائن Date
// عشان نقدر نقارنه بتاريخ معيّن (زي "من بكرة"). بيرجع null لو الصيغة مش مفهومة
function parseUsSlashDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, month, day, year] = m;
  return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
}

// بيدوّر على أي عنصر ورقة نصه بيطابق نمط معين ويدوس عليه (مستخدمة للتابات وكروت الإحصائيات
// اللي بتفلتر الجدول لما تدوس عليها). maxChildren بيتحكم في نوع العنصر (تاب = 0، كارت = <=2)
async function clickElementByText(page, patternSource, maxChildren) {
  return await page.evaluate(
    (patternSource, maxChildren) => {
      const regex = new RegExp(patternSource, "i");
      const els = Array.from(document.querySelectorAll("*"));
      const el = els.find((e) => regex.test(e.textContent || "") && e.children.length <= maxChildren);
      if (el) {
        if (typeof el.click === "function") {
          el.click();
        } else {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
        return true;
      }
      return false;
    },
    patternSource,
    maxChildren
  );
}

// بيدور على مربع البحث الظاهر في الصفحة (placeholder فيه كلمة Search) ويكتب فيه نص معيّن
// بيمسح أي نص قديم فيه الأول (تريبل كليك = تحديد الكل ثم مسح)
async function setSearchBox(page, text) {
  const input = await page.$('input[placeholder*="Search" i]');
  if (!input) return false;
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  if (text) await input.type(text, { delay: 20 });
  return true;
}

async function login(page, cfg) {
  // إخفاء بصمة الأتمتة الأساسية: Chromium الـheadless بيسيب navigator.webdriver = true
  // ويستخدم User-Agent فيه كلمة "HeadlessChrome" ظاهرة - مواقع كتير (خصوصًا فيها حماية بوتات)
  // بترفض تسجيل الدخول لو لقت العلامتين دول حتى لو البيانات صح 100%. الدخول اليدوي في متصفح
  // عادي كان بينجح، بينما نفس البيانات بالظبط كانت بترجع لصفحة الدخول من غير أي سبب واضح -
  // ده بالظبط النمط المتوقع لو المشكلة اكتشاف بوت مش رفض بيانات
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  await page.goto(cfg.LOGIN_URL, { waitUntil: "networkidle2" });

  // محاولات متعددة لإيجاد حقول اليوزر والباسورد (النظام مش موثّق، فبنجرب أشكال شائعة)
  const usernameSelectors = [
    'input[name="username"]',
    'input[name="mobile"]',
    'input[type="email"]',
    'input[type="text"]',
  ];
  const passwordSelectors = ['input[name="password"]', 'input[type="password"]'];

  let usernameField = null;
  for (const sel of usernameSelectors) {
    usernameField = await page.$(sel);
    if (usernameField) break;
  }
  let passwordField = await page.$(passwordSelectors.join(","));

  if (!usernameField || !passwordField) {
    throw new Error(
      "مش لاقي حقول تسجيل الدخول بالشكل المتوقع. الصفحة غالبًا اتغيّر شكلها، محتاجين نراجع الـ selectors."
    );
  }

  // بنركّز على الحقل الأول (click) قبل الكتابة عشان نضمن إن الفوكس فعليًا عليه (بعض المواقع
  // الحديثة بتتجاهل .type() لو الحقل مش focused فعليًا)، وبعد الكتابة بنتأكد إن القيمة
  // فعلاً اتسجّلت في الـDOM (مش بس اتبعتت كضغطات مفاتيح) - لو لأ، بنعيد المحاولة مرة واحدة
  async function typeAndVerify(field, value) {
    await field.click({ clickCount: 3 });
    await field.type(value, { delay: 30 });
    const actual = await field.evaluate((el) => el.value);
    if (actual !== value) {
      await field.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await field.type(value, { delay: 50 });
    }
  }

  await typeAndVerify(usernameField, cfg.USERNAME);
  await typeAndVerify(passwordField, cfg.PASSWORD);
  await sleep(300);

  const submitButton = await page.$('button[type="submit"]');
  if (submitButton) {
    // لو الزرار متعطّل (disabled) لحد ما التحقق الداخلي للموقع يخلص، بننتظره يتفعّل قبل الضغط
    // بدل ما نضغط عليه وهو متعطّل من غير ما يحصل أي حاجة فعليًا
    await page
      .waitForFunction((btn) => !btn.disabled, { timeout: 5000 }, submitButton)
      .catch(() => {});
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}),
      submitButton.click(),
    ]);
  } else {
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
  }

  // تأكيد إن الدخول نجح فعلًا: لو لسه واقفين في صفحة اللوجين بعد المحاولة، يبقى البيانات
  // اترفضت أو الفورم ما اتقدّمش صح - نرمي خطأ واضح بدل ما نكمل بجلسة مش مسجّل دخول فيها
  // (وده كان بيسبب رجوع كل نتايج المزامنة "صفر" أو "غير متاح" من غير أي تفسير)
  await sleep(500);
  if (/\/auth\/login/i.test(page.url())) {
    throw new Error("فشل تسجيل الدخول في البوابة - البيانات اترفضت أو شكل الفورم اتغيّر");
  }
}

// بيدخل الحساب، يروح لصفحة "استلام البطاقات"، يدوس تاب "Printed"، ويفتح لحد maxExpand صف
// عشان يقرا الاسم بالعربي (NAME (AR)) من تفاصيل كل صف، ويرجّع قائمة المزارعين
async function fetchPrintedCards(maxExpand = 30) {
  const cfg = loadConfig();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, cfg);

    await page.goto(cfg.ISSUING_URL, { waitUntil: "networkidle2" });

    // الدوس على تاب "Printed" (بالنص الظاهر في الصفحة)
    const clicked = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("*"));
      const tab = tabs.find((el) => /printed/i.test(el.textContent || "") && el.children.length === 0);
      if (tab) {
        if (typeof tab.click === "function") {
          tab.click();
        } else {
          tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
        return true;
      }
      return false;
    });
    if (clicked) await sleep(1500);

    return await scrapeTableWithArabicNames(page, maxExpand);
  } finally {
    await browser.close();
  }
}

// بيدخل الحساب، يروح لصفحة "مراجعة التسجيل"، ويفتح لحد maxExpand صف من حالة "Pending Printing"
// عشان يقرا الاسم بالعربي من تفاصيل كل صف، ويرجّع قائمة المزارعين
async function fetchPendingPrintingRequests(maxExpand = 30) {
  const cfg = loadConfig();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, cfg);

    await page.goto(cfg.REGISTRATION_REVIEW_URL, { waitUntil: "networkidle2" });

    // الدوس على كارت إحصائية "Pending Printing" عشان يفلتر الجدول عليها
    const clicked = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("*"));
      const card = cards.find((el) => /pending printing/i.test(el.textContent || "") && el.children.length <= 2);
      if (card) {
        if (typeof card.click === "function") {
          card.click();
        } else {
          card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
        return true;
      }
      return false;
    });
    if (clicked) await sleep(1500);

    return await scrapeTableWithArabicNames(page, maxExpand);
  } finally {
    await browser.close();
  }
}

// بيدور جوه صفحة تفاصيل الطلب (اللي بتفتح لما تدوس "Edit") على قيمة حقل معيّن بالاسم بتاعه
// (زي "FULL NAME" أو "NATIONAL ID" أو "PHONE") - بيدوّر على عنصر ورقة نصه بالظبط اسم الحقل،
// وياخد باقي نص العنصر الأب بعد ما يشيل اسم الحقل نفسه (القيمة عادة تحت اسم الحقل في نفس الكارت)
async function extractDetailField(page, labelText) {
  return await page.evaluate((label) => {
    const labelEl = Array.from(document.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && el.textContent.trim().toUpperCase() === label
    );
    if (!labelEl) return "";
    const container = labelEl.parentElement;
    if (!container) return "";
    return (container.textContent || "").replace(labelEl.textContent, "").trim();
  }, labelText);
}

// بيدخل الحساب، يروح لصفحة "تسجيل بطاقات ذكية"، يدور على تاب "Draft"، ولكل صف بيدوس على
// زرار "Edit" اللي بيوديه لصفحة تفاصيل الطلب الكاملة (فيها FULL NAME عربي+إنجليزي، NATIONAL ID،
// PHONE بشكل واضح ومنظّم) - أدق بكتير من محاولة قراءة تفاصيل الصف المطوي زي باقي الصفحات
// targetCount: كام نتيجة "مقبولة" (بعد فلترة filterFn) عايزين نوصلها - مش عدد الصفوف اللي هنزورها.
// filterFn (اختياري): بيتفحص كل مرشّح فور استخراج بياناته، ولو رجّع false منتحسبش من targetCount
// (بس لسه بنزور باقي صفوف الصفحة والصفحات اللي بعدها). ده يحل مشكلة إن أول صفحة/صفحتين ممكن
// يكونوا كلهم اتبعتلهم رسالة قبل كده أو مستبعدين، فيرجع صفر رغم وجود مئات الصفوف المؤهلة بعدهم
async function fetchDraftForms(targetCount, filterFn) {
  const cfg = loadConfig();
  if (!cfg.DRAFT_FORMS_URL) return []; // لو مش متظبّط في الإعدادات، نتجاهل الميزة دي بهدوء

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, cfg);

    await page.goto(cfg.DRAFT_FORMS_URL, { waitUntil: "networkidle2" });
    await sleep(1000);

    // بيعدّي على كل صفحات الجدول (pagination) لغاية ما يوصل targetCount نتيجة مقبولة أو تخلص الصفحات
    const results = [];
    let pageGuard = 0;

    while (results.length < targetCount && pageGuard < 50) {
      pageGuard++;

      const mainRowCount = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("table tbody tr"));
        return rows.filter((r) => /^\d+$/.test((r.querySelector("td")?.innerText || "").trim())).length;
      });
      if (mainRowCount === 0) break;

      // بنزور كل صفوف الصفحة (مش بس أول "remaining" منها) لأن بعضهم ممكن يترفض بالفلتر
      // ومنعرفش قبل ما نزوره - بس بنوقف بدري لو وصلنا للعدد المطلوب فعلًا
      for (let i = 0; i < mainRowCount; i++) {
        if (results.length >= targetCount) break;
        // مهم: بنقرا رقم الطلب ونضغط على "Edit" في نفس استدعاء evaluate واحد (مش استدعائين منفصلين)
        // لأن الجدول بيستقبل طلبات درافت جديدة باستمرار (185 عنصر وبيزيد)، ولو حصل تحديث/إعادة
        // ترتيب للصفوف في الوقت بين قراءة الرقم والضغط على الزرار (حتى لو أجزاء من الثانية)، هيبقى
        // رقم الطلب اللي اتقرا مش هو نفسه اللي اتفتح فعليًا - وده اللي كان بيسبب ربط اسم مزارع
        // برقم طلب مزارع تاني خالص. برضه بناخد رقم الطلب الحقيقي من رابط صفحة التفاصيل بعد كده
        // كتأكيد نهائي (أدق مصدر، مالوش علاقة بترتيب الجدول خالص).
        const pagesBefore = await browser.pages();
        const rowSnapshot = await page.evaluate((index) => {
          const rows = Array.from(document.querySelectorAll("table tbody tr"));
          const mainRows = rows.filter((r) => /^\d+$/.test((r.querySelector("td")?.innerText || "").trim()));
          const row = mainRows[index];
          if (!row) return { found: false };
          const formNumber = (row.querySelector("td")?.innerText || "").trim();
          const editBtn = Array.from(row.querySelectorAll("button, a")).find((b) => /view|edit/i.test(b.textContent || ""));
          if (!editBtn) return { found: false, formNumber };
          if (typeof editBtn.click === "function") {
            editBtn.click();
          } else {
            editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
          return { found: true, formNumber };
        }, i);

        if (!rowSnapshot.found) continue;
        let formNumber = rowSnapshot.formNumber;

        await sleep(800); // نديله وقت يفتح تاب جديد لو هيفتح، قبل ما نتأكد

        // لو اتفتح تاب جديد، هنشتغل عليه هو (مش الصفحة الأصلية) عشان نقرا التفاصيل منه
        const pagesAfter = await browser.pages();
        const openedNewTab = pagesAfter.length > pagesBefore.length;
        const detailPage = openedNewTab ? pagesAfter[pagesAfter.length - 1] : page;
        if (openedNewTab) await detailPage.bringToFront().catch(() => {});

        // بننتظر ظهور حقل "FULL NAME" فعليًا بدل الاعتماد على حدث navigation، لأن المنصة
        // React/Angular وبتغيّر محتوى الصفحة من غير تحميل كامل (اللي كان بيخلي waitForNavigation
        // يستنى 15 ثانية من غير فايدة وبعدين يكمل يقرا من نفس صفحة القائمة القديمة فيرجّع نتيجة فاضية)
        await detailPage
          .waitForFunction(
            () =>
              Array.from(document.querySelectorAll("*")).some(
                (el) => el.children.length === 0 && el.textContent.trim().toUpperCase() === "FULL NAME"
              ),
            { timeout: 15000 }
          )
          .catch(() => {});
        await sleep(300);

        // تأكيد نهائي لرقم الطلب من رابط صفحة التفاصيل نفسها (اللي احنا فعليًا بنقرا منها البيانات
        // دلوقتي) - ده المصدر الوحيد المضمون ميتأثرش بأي إعادة ترتيب حصلت في جدول القائمة
        const urlMatch = detailPage.url().match(/requests\/(\d+)/);
        if (urlMatch) formNumber = urlMatch[1];

        const fullNameBlock = await extractDetailField(detailPage, "FULL NAME");
        const nationalIdBlock = await extractDetailField(detailPage, "NATIONAL ID");
        const phoneBlock = await extractDetailField(detailPage, "PHONE NUMBER");

        const nameLines = fullNameBlock.split("\n").map((l) => l.trim()).filter(Boolean);
        const arabicName = nameLines.find((l) => /[؀-ۿ]/.test(l)) || "";
        const englishName = nameLines.find((l) => !/[؀-ۿ]/.test(l)) || nameLines[0] || "";

        const idMatch = nationalIdBlock.match(/\b[12]\d{9}\b/);
        const phoneMatch = phoneBlock.match(/\+?9665\d{8}/);

        if (phoneMatch || idMatch) {
          const candidate = {
            name: arabicName || englishName,
            phone: phoneMatch ? phoneMatch[0].replace(/[^\d]/g, "") : "",
            nationalId: idMatch ? idMatch[0] : "",
            formNumber,
          };
          if (!filterFn || filterFn(candidate)) {
            results.push(candidate);
          }
        }

        if (openedNewTab) {
          // نقفل التاب الجديد ونرجع نشتغل على تاب القائمة الأصلي زي ما هو (لسه فاتح على نفس الصفحة)
          await detailPage.close().catch(() => {});
          await page.bringToFront().catch(() => {});
        } else {
          // نرجع لصفحة قائمة الدرافت تاني عشان نكمل بقية الصفوف - بننتظر ظهور الجدول تاني
          // بدل ما نستنى navigation event (نفس السبب اللي فوق)
          await page.goBack().catch(() => {});
          await page
            .waitForFunction(() => document.querySelectorAll("table tbody tr").length > 0, { timeout: 15000 })
            .catch(() => {});
        }
        await sleep(300);
      }

      if (results.length >= targetCount) break;

      const advanced = await goToNextPage(page);
      if (!advanced) break;
      await sleep(800);
    }

    return results;
  } finally {
    await browser.close();
  }
}

// بيدور على كروت الإحصائيات الظاهرة في الصفحة (زي "22 Items / Pending Review")
// وبيرجع مصفوفة {number, label} لكل كارت - مش بيعتمد على ترتيب أو عدد ثابت للكروت
async function extractStatCards(page) {
  return await page.evaluate(() => {
    // بندور على أي عنصر ورقة نصه بالظبط "Items" (زي ما ظاهر في كروت الإحصائيات)
    const itemsEls = Array.from(document.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && /^items$/i.test((el.textContent || "").trim())
    );

    const cards = [];
    itemsEls.forEach((itemEl) => {
      // بنطلع لحد ما نلاقي عنصر أب نصه الكامل يبدأ برقم وفيه كلمة تانية غير "Items" (ده الليبل)
      let node = itemEl;
      for (let i = 0; i < 6 && node; i++) {
        const text = (node.textContent || "").trim().replace(/\s+/g, " ");
        const numMatch = text.match(/^(\d+)/);
        if (numMatch) {
          const rest = text.replace(/^\d+/, "").replace(/items/i, "").trim();
          if (rest) {
            cards.push({ number: parseInt(numMatch[1], 10), label: rest });
            break;
          }
        }
        node = node.parentElement;
      }
    });
    return cards;
  });
}

// بيدوّر جوه مصفوفة كروت الإحصائيات على أول كارت لييبله يطابق نص/نمط معين (مش حساس لحالة الأحرف)
function findStatValue(cards, labelPattern) {
  const card = cards.find((c) => labelPattern.test(c.label));
  return card ? card.number : null;
}

// بيسجّل دخول مرة واحدة، ويعدي على صفحة الرفيو وصفحة الإصدار (والدرافت لو متظبّطة)
// ويقرا أرقام الكروت الظاهرة فيهم مباشرة (مش بيعدّ صفوف الجدول يدويًا - أسرع وأدق)
async function fetchPortalStats() {
  const cfg = loadConfig();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, cfg);

    // صفحة مراجعة التسجيل (Profile Review Queue)
    await page.goto(cfg.REGISTRATION_REVIEW_URL, { waitUntil: "networkidle2" });
    await sleep(1000);
    const reviewCards = await extractStatCards(page);

    // صفحة إصدار البطاقات (Card Issuance Queue)
    await page.goto(cfg.ISSUING_URL, { waitUntil: "networkidle2" });
    await sleep(1000);
    const issuingCards = await extractStatCards(page);

    const stats = {
      pendingReview: findStatValue(reviewCards, /pending review/i),
      onHold: findStatValue(reviewCards, /on hold/i),
      approved: findStatValue(reviewCards, /approved/i),
      rejected: findStatValue(reviewCards, /rejected/i),
      archived: findStatValue(reviewCards, /archived/i),
      pendingPrinting: findStatValue(reviewCards, /pending printing/i),

      issuingPending: findStatValue(issuingCards, /pending printing/i) ?? findStatValue(issuingCards, /^pending$/i),
      pendingDelivery: findStatValue(issuingCards, /pending delivery/i),
      delivered: findStatValue(issuingCards, /delivered/i),
      totalInQueue: findStatValue(issuingCards, /total in queue/i),
    };

    // الدرافت: العدد غالبًا ظاهر جوه اسم التاب نفسه "Draft (185)" مش ككارت منفصل
    // بندوّر بس على عنصر ورقة (تاب) نصه بالظبط بيبدأ بـ"Draft" ومعاه رقم بين قوسين،
    // بدل ما ندور في نص الصفحة كله (اللي ممكن يلاقي رقم غلط من مكان تاني قريب من كلمة Draft)
    if (cfg.DRAFT_FORMS_URL) {
      await page.goto(cfg.DRAFT_FORMS_URL, { waitUntil: "networkidle2" });
      await sleep(1500);
      const draftCount = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("*")).filter((el) => el.children.length === 0);
        for (const el of els) {
          const t = (el.textContent || "").trim();
          const m = t.match(/^draft\s*\(\s*(\d+)\s*\)$/i);
          if (m) return parseInt(m[1], 10);
        }
        return null;
      });
      stats.draft = draftCount;
    } else {
      stats.draft = null;
    }

    return stats;
  } finally {
    await browser.close();
  }
}

// أسماء الحالات في صفحة "مراجعة التسجيل" (كروت إحصائية بتفلتر الجدول لما تدوس عليها)
const REVIEW_STATUS_PATTERNS = {
  "قيد المراجعة": "pending review",
  "معلق": "on hold",
  "مقبول": "approved",
  "مرفوض": "rejected",
  "مؤرشف": "archived",
  "قيد الطباعة": "pending printing",
};

// بيدخل صفحة "مراجعة التسجيل"، يدوس على كارت الحالة المطلوبة، يفتح لحد maxExpand صف
// عشان يقرا الاسم بالعربي، ويرجّع كل الصفوف
// statusKeyword لازم يكون واحد من مفاتيح REVIEW_STATUS_PATTERNS
async function fetchReviewByStatus(statusKeyword, maxExpand = 30) {
  const pattern = REVIEW_STATUS_PATTERNS[statusKeyword];
  if (!pattern) throw new Error(`حالة غير معروفة: ${statusKeyword}`);

  const cfg = loadConfig();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, cfg);
    await page.goto(cfg.REGISTRATION_REVIEW_URL, { waitUntil: "networkidle2" });
    await sleep(1000);

    const clicked = await clickElementByText(page, pattern, 2);
    if (clicked) await sleep(1500);

    return await scrapeTableWithArabicNames(page, maxExpand, statusKeyword);
  } finally {
    await browser.close();
  }
}

// أسماء تابات صفحة "إصدار البطاقات"
// ملاحظة: "قيد الطباعة" مقصودة لكارت "Pending Printing" في صفحة الرفيو (REVIEW_STATUS_PATTERNS)
// وده تاب "Pending" هنا في صفحة الإصدار نفسها (نفس المرحلة تقريبًا)، سميناه مختلف عشان مايتلخبطش
const ISSUING_TAB_PATTERNS = {
  "في طابور الطباعة": "^pending\\s*\\(",
  "مطبوعة": "^printed\\s*\\(",
  "تم التسليم": "^delivered\\s*\\(",
  "الكل": "^all$",
};

// بيدخل صفحة "إصدار البطاقات"، يدوس على التاب المطلوب، يفتح لحد maxExpand صف
// عشان يقرا الاسم بالعربي، ويرجّع كل الصفوف
async function fetchIssuingByTab(tabKeyword, maxExpand = 30) {
  const pattern = ISSUING_TAB_PATTERNS[tabKeyword];
  if (!pattern) throw new Error(`تاب غير معروف: ${tabKeyword}`);

  const cfg = loadConfig();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, cfg);
    await page.goto(cfg.ISSUING_URL, { waitUntil: "networkidle2" });
    await sleep(1000);

    const clicked = await clickElementByText(page, pattern, 0);
    if (clicked) await sleep(1500);

    return await scrapeTableWithArabicNames(page, maxExpand, tabKeyword);
  } finally {
    await browser.close();
  }
}

// بحث حر بالاسم/الجوال/الهوية جوه صفحة "إصدار البطاقات" (بتاب "الكل" عشان يشمل كل الحالات)
async function searchIssuing(queryText) {
  const cfg = loadConfig();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, cfg);
    await page.goto(cfg.ISSUING_URL, { waitUntil: "networkidle2" });
    await sleep(1000);

    await clickElementByText(page, "^all$", 0);
    await sleep(1000);

    const found = await setSearchBox(page, queryText);
    if (!found) return [];
    await sleep(1000);

    return await scrapeVisibleTable(page, "");
  } finally {
    await browser.close();
  }
}

// بحث حر بالاسم/الجوال/الهوية جوه صفحة "مراجعة التسجيل"
// الصفحة دي معندهاش تاب "الكل"، فبندوّر داخل كل كارت حالة على حدة ونجمع النتائج
async function searchReview(queryText) {
  const cfg = loadConfig();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, cfg);
    await page.goto(cfg.REGISTRATION_REVIEW_URL, { waitUntil: "networkidle2" });
    await sleep(1000);

    const results = [];
    for (const [statusKeyword, pattern] of Object.entries(REVIEW_STATUS_PATTERNS)) {
      const clicked = await clickElementByText(page, pattern, 2);
      if (!clicked) continue;
      await sleep(1000);

      const found = await setSearchBox(page, queryText);
      if (!found) continue;
      await sleep(1000);

      const rows = await scrapeVisibleTable(page, statusKeyword);
      results.push(...rows);
    }

    return results;
  } finally {
    await browser.close();
  }
}

// بحث موحّد على صفحتي "مراجعة التسجيل" و"إصدار البطاقات" مع بعض، وتجميع النتائج
// (مفيش بحث في الدرافت لأن كل صف فيها محتاج فتح يدوي عشان يظهر رقم الجوال - مكلف جدًا لو هنفتح 185 صف)
async function searchPortal(queryText) {
  const [reviewResults, issuingResults] = await Promise.all([
    searchReview(queryText).catch(() => []),
    searchIssuing(queryText).catch(() => []),
  ]);
  return [...reviewResults, ...issuingResults];
}

module.exports = {
  fetchPrintedCards,
  fetchPendingPrintingRequests,
  fetchDraftForms,
  fetchPortalStats,
  fetchReviewByStatus,
  fetchIssuingByTab,
  searchPortal,
  saveCredentials,
  parseUsSlashDate,
  REVIEW_STATUS_PATTERNS,
  ISSUING_TAB_PATTERNS,
  loadConfig,
};
