// سكريبت تشخيصي مؤقت - بيوريك هل صفحات الإحصائيات (مراجعة التسجيل + إصدار البطاقات) بتفتح
// صح بعد تسجيل الدخول، وهل كروت الإحصائيات ("Items") موجودة فعلًا في الصفحة.
// شغّله بالأمر: node scripts/debugStatsPage.js
const puppeteer = require("puppeteer");
const path = require("path");
const cfg = require(path.join(__dirname, "..", "portal_config.js"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function login(page) {
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  await page.goto(cfg.LOGIN_URL, { waitUntil: "networkidle2" });
  const usernameField =
    (await page.$('input[name="username"]')) ||
    (await page.$('input[name="mobile"]')) ||
    (await page.$('input[type="email"]')) ||
    (await page.$('input[type="text"]'));
  const passwordField = await page.$('input[name="password"], input[type="password"]');

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
    await page.waitForFunction((btn) => !btn.disabled, { timeout: 5000 }, submitButton).catch(() => {});
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}), submitButton.click()]);
  } else {
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
  }
  await sleep(500);
  console.log("رابط بعد محاولة تسجيل الدخول:", page.url());
}

async function inspect(page, label, url) {
  console.log(`\n=== ${label} ===`);
  console.log("رابط:", url);
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  } catch (err) {
    console.log("❌ فشل فتح الصفحة:", err.message);
    return;
  }
  await sleep(2000);
  console.log("رابط الصفحة الفعلي بعد التحميل:", page.url());

  const itemsCount = await page.evaluate(
    () => Array.from(document.querySelectorAll("*")).filter((el) => el.children.length === 0 && /^items$/i.test((el.textContent || "").trim())).length
  );
  console.log('عدد العناصر اللي نصها "Items" بالظبط:', itemsCount);

  const bodyTextSnippet = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log("أول 2000 حرف من نص الصفحة:");
  console.log(bodyTextSnippet);
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    console.log("1) تسجيل الدخول...");
    await login(page);
    console.log("   رابط بعد تسجيل الدخول:", page.url());

    await inspect(page, "صفحة مراجعة التسجيل (REGISTRATION_REVIEW_URL)", cfg.REGISTRATION_REVIEW_URL);
    await inspect(page, "صفحة إصدار البطاقات (ISSUING_URL)", cfg.ISSUING_URL);

    await browser.close();
  } catch (err) {
    console.error("خطأ:", err.message);
    await browser.close();
  }
})();
