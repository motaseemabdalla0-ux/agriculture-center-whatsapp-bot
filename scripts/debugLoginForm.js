// سكريبت تشخيصي مؤقت - بيوري تفاصيل فورم تسجيل الدخول بالظبط (كل الحقول، الزرار، وهل فيه
// أي iframe مشبوه زي كابتشا) قبل وبعد محاولة تسجيل الدخول - من غير ما يطبع الباسورد نفسه أبدًا.
// شغّله بالأمر: node scripts/debugLoginForm.js
const puppeteer = require("puppeteer");
const path = require("path");
const cfg = require(path.join(__dirname, "..", "portal_config.js"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function dumpForm(page, label) {
  const info = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input")).map((el) => ({
      tag: el.tagName,
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      value: el.type === "password" ? (el.value ? "***" : "") : el.value,
      disabled: el.disabled,
      required: el.required,
    }));
    const buttons = Array.from(document.querySelectorAll("button")).map((el) => ({
      type: el.type,
      text: (el.textContent || "").trim().slice(0, 40),
      disabled: el.disabled,
      form: el.form ? true : false,
    }));
    const forms = Array.from(document.querySelectorAll("form")).map((f) => ({
      action: f.action,
      method: f.method,
    }));
    const iframes = Array.from(document.querySelectorAll("iframe")).map((f) => f.src || f.title || "بدون src/title");
    return { inputs, buttons, forms, iframes, url: location.href };
  });
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(info, null, 2));
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    console.log("1) فتح صفحة تسجيل الدخول...");
    await page.goto(cfg.LOGIN_URL, { waitUntil: "networkidle2" });
    await sleep(1500);
    await dumpForm(page, "الفورم قبل أي إدخال");

    const usernameField =
      (await page.$('input[name="username"]')) ||
      (await page.$('input[name="mobile"]')) ||
      (await page.$('input[type="email"]')) ||
      (await page.$('input[type="text"]'));
    const passwordField = await page.$('input[name="password"], input[type="password"]');

    if (!usernameField || !passwordField) {
      console.log("❌ مش لاقي حقل يوزر أو باسورد!");
      await browser.close();
      return;
    }

    await usernameField.click({ clickCount: 3 });
    await usernameField.type(cfg.USERNAME, { delay: 40 });
    await passwordField.click({ clickCount: 3 });
    await passwordField.type(cfg.PASSWORD, { delay: 40 });
    await sleep(500);

    await dumpForm(page, "الفورم بعد كتابة البيانات (قبل الضغط على تسجيل الدخول)");

    const submitButton = await page.$('button[type="submit"]');
    console.log("\n2) فيه زرار type=submit؟", !!submitButton);

    if (submitButton) {
      const disabled = await submitButton.evaluate((b) => b.disabled);
      console.log("   الزرار متعطل (disabled)؟", disabled);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch((e) => console.log("   (مفيش navigation:", e.message, ")")),
        submitButton.click(),
      ]);
    } else {
      await page.keyboard.press("Enter");
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    }

    await sleep(1500);
    await dumpForm(page, "الفورم بعد محاولة تسجيل الدخول");

    // هل فيه أي رسالة خطأ ظاهرة في الصفحة (زي "بيانات غلط" أو "invalid")؟
    const bodyText = await page.evaluate(() => document.body.innerText);
    const errorHints = bodyText
      .split("\n")
      .filter((line) => /invalid|incorrect|error|خطأ|غير صحيح|فشل|محظور|blocked|locked|too many|denied/i.test(line));
    console.log("\n3) أي أسطر فيها كلمة تدل على خطأ:");
    console.log(errorHints.length ? JSON.stringify(errorHints, null, 2) : "(مفيش)");

    await browser.close();
  } catch (err) {
    console.error("خطأ:", err.message);
    await browser.close();
  }
})();
