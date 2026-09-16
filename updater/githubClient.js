const fs = require("fs");
const { getConfig } = require("./config");

// عميل GitHub بسيط جدًا - بيستخدم fetch المدمجة في Node (18+) بدل أي مكتبة خارجية جديدة.
// بيدعم Repository خاص عن طريق GITHUB_TOKEN من .env (مفيش توكن مكتوب في الكود أبدًا،
// ومفيش طباعة للتوكن في أي Log تحت أي ظرف)

function authHeaders() {
  const { token } = getConfig();
  const headers = { "User-Agent": "agriculture-center-whatsapp-bot-updater", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// بيرجع أحدث Release منشور على الريبو (مش Draft ومش Pre-release) - فيه tag_name (زي v1.0.2)،
// zipball_url (كود المصدر كـzip، بيتولد تلقائيًا من GitHub لكل tag/release من غير ما نحتاج
// نرفع أي asset يدوي)، و target_commitish/commit sha
async function getLatestRelease() {
  const { owner, repo } = getConfig();
  if (!owner || !repo) {
    throw new Error("GITHUB_OWNER/GITHUB_REPO غير مضبوطين في .env");
  }
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`فشل الاتصال بـGitHub (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    tagName: data.tag_name,
    version: (data.tag_name || "").replace(/^v/, ""),
    zipballUrl: data.zipball_url,
    commitSha: null, // الـReleases API القياسية مابترجعش SHA مباشرة - بيتحدد من محتوى الـzip نفسه لو احتجناه
    publishedAt: data.published_at,
    htmlUrl: data.html_url,
  };
}

// بيحمّل الـzip الخاص بالإصدار لملف محلي - بيستخدم fetch العادية (الملفات دي عادةً صغيرة
// لمشروع زي ده، فمفيش داعي لـstreaming معقّد)
async function downloadZip(zipballUrl, destFile) {
  const res = await fetch(zipballUrl, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`فشل تحميل نسخة الإصدار (${res.status})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destFile, buffer);
  return destFile;
}

module.exports = { getLatestRelease, downloadZip };
