// سكريبت تشخيصي مؤقت - بيوريك بالظبط إيه اللي بيحصل لما ندوس على أول صف في تاب الدرافت
// شغّله بالأمر: node scripts/debugDraftRow.js
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

    console.log("2) الدخول لصفحة الدرافت...");
    await page.goto(cfg.DRAFT_FORMS_URL, { waitUntil: "networkidle2" });
    await sleep(1500);

    const rowInfo = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      const mainRows = rows.filter((r) => /^\d+$/.test((r.querySelector("td")?.innerText || "").trim()));
      if (mainRows.length === 0) return { error: "مفيش صفوف رئيسية اتلاقت خالص (mainRows.length === 0)" };
      const row = mainRows[0];
      return {
        mainRowsCount: mainRows.length,
        rowOuterHtmlSnippet: row.outerHTML.slice(0, 1500),
        buttonsAndLinksText: Array.from(row.querySelectorAll("button, a")).map((b) => ({
          tag: b.tagName,
          text: (b.textContent || "").trim(),
          href: b.getAttribute("href") || null,
        })),
      };
    });

    console.log("3) معلومات أول صف:");
    console.log(JSON.stringify(rowInfo, null, 2));

    if (rowInfo.buttonsAndLinksText && rowInfo.buttonsAndLinksText.length > 0) {
      console.log("4) هندوس على أول زرار/لينك في الصف...");
      const pagesBefore = await browser.pages();
      await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("table tbody tr"));
        const mainRows = rows.filter((r) => /^\d+$/.test((r.querySelector("td")?.innerText || "").trim()));
        const row = mainRows[0];
        const btn = row.querySelector("button, a");
        if (btn.click) btn.click();
        else btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      await sleep(2000);
      const pagesAfter = await browser.pages();
      console.log(`5) عدد التابات قبل: ${pagesBefore.length}, بعد: ${pagesAfter.length}`);

      const targetPage = pagesAfter.length > pagesBefore.length ? pagesAfter[pagesAfter.length - 1] : page;
      await targetPage.bringToFront().catch(() => {});
      await sleep(1000);

      const bodyText = await targetPage.evaluate(() => document.body.innerText.slice(0, 2000));
      console.log("6) أول 2000 حرف من نص الصفحة بعد الدوس:");
      console.log(bodyText);
      console.log("7) رابط الصفحة الحالي:", targetPage.url());
    }

    await browser.close();
  } catch (err) {
    console.error("خطأ:", err.message);
    await browser.close();
  }
})();
