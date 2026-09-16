// سكريبت تشخيصي مؤقت - بيوريك بالظبط إيه اللي بيحصل لما نحاول نفتح صفحة إصدار البطاقات
// ونضغط على تاب "Printed" ونقرا الصفوف. شغّله بالأمر: node scripts/debugPrintedTab.js
const puppeteer = require("puppeteer");
const path = require("path");
const cfg = require(path.join(__dirname, "..", "portal_config.js"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function login(page) {
  await page.goto(cfg.LOGIN_URL, { waitUntil: "networkidle2" });
  const usernameField =
    (await page.$('input[name="username"]')) ||
    (await page.$('input[name="mobile"]')) ||
    (await page.$('input[type="email"]')) ||
    (await page.$('input[type="text"]'));
  const passwordField = await page.$('input[name="password"], input[type="password"]');
  await usernameField.type(cfg.USERNAME, { delay: 30 });
  await passwordField.type(cfg.PASSWORD, { delay: 30 });
  const submitButton = await page.$('button[type="submit"]');
  if (submitButton) {
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}), submitButton.click()]);
  } else {
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
  }
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    console.log("1) تسجيل الدخول...");
    await login(page);

    console.log("2) الدخول لصفحة إصدار البطاقات (ISSUING_URL)...");
    console.log("   الرابط:", cfg.ISSUING_URL);
    await page.goto(cfg.ISSUING_URL, { waitUntil: "networkidle2" });
    await sleep(1500);

    // بنلاقي كل العناصر اللي نصها فيه كلمة "printed" (case-insensitive) - عشان نشوف إيه شكل
    // العنصر بالظبط (تاج، عدد الأولاد، النص الكامل) قبل ما نحاول نضغط عليه
    const printedCandidates = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      return all
        .filter((el) => /printed/i.test(el.textContent || ""))
        .map((el) => ({
          tag: el.tagName,
          childrenCount: el.children.length,
          text: (el.textContent || "").trim().slice(0, 60),
          className: (el.className || "").toString().slice(0, 80),
        }));
    });
    console.log("3) كل العناصر اللي فيها كلمة 'printed':");
    console.log(JSON.stringify(printedCandidates, null, 2));

    // نفس منطق fetchPrintedCards بالظبط - نشوف هل بيلاقي حاجة يدوس عليها
    const clicked = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("*"));
      const tab = tabs.find((el) => /printed/i.test(el.textContent || "") && el.children.length === 0);
      if (tab) {
        if (typeof tab.click === "function") tab.click();
        else tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    });
    console.log("4) هل لقى تاب يدوس عليه (children.length === 0)؟", clicked);

    if (clicked) await sleep(1500);

    // معلومات الجدول بعد الضغط (لو حصل)
    const tableInfo = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      const mainRows = rows.filter((r) => /^\d+$/.test((r.querySelector("td")?.innerText || "").trim()));
      return {
        totalRowsFound: rows.length,
        mainRowsCount: mainRows.length,
        firstRowFirstCellRaw: rows[0] ? JSON.stringify(rows[0].querySelector("td")?.innerText || "") : null,
        firstRowOuterHtmlSnippet: rows[0] ? rows[0].outerHTML.slice(0, 800) : null,
      };
    });
    console.log("5) حالة الجدول بعد الضغط:");
    console.log(JSON.stringify(tableInfo, null, 2));

    console.log("6) رابط الصفحة الحالي:", page.url());

    await browser.close();
  } catch (err) {
    console.error("خطأ:", err.message);
    await browser.close();
  }
})();
