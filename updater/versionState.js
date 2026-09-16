const fs = require("fs");
const path = require("path");

// حالة التحديث محفوظة في جذر المشروع (مش جوّه updater/) عشان تفضل بيانات تشغيلية مستقلة تمامًا
// عن كود الـUpdater نفسه - لو نزل إصدار جديد لكود updater/ ذاته، الحالة دي (آخر إصدار متثبّت،
// آخر فحص...) لازم تفضل زي ما هي ومتتلمسش أبدًا أثناء أي مزامنة كود
const STATE_FILE = path.join(__dirname, "..", "update_state.json");

function defaultState() {
  return {
    installedVersion: require("../package.json").version,
    installedTag: null,
    installedCommitSha: null,
    installedAt: null,
    lastCheckedAt: null,
    lastCheckResult: null, // { latestVersion, latestTag, updateAvailable }
  };
}

function load() {
  if (!fs.existsSync(STATE_FILE)) return defaultState();
  try {
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return defaultState();
  }
}

function save(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

function recordCheck(result) {
  const state = load();
  state.lastCheckedAt = new Date().toISOString();
  state.lastCheckResult = result;
  save(state);
  return state;
}

function recordInstall({ version, tag, commitSha }) {
  const state = load();
  state.installedVersion = version;
  state.installedTag = tag;
  state.installedCommitSha = commitSha;
  state.installedAt = new Date().toISOString();
  save(state);
  return state;
}

module.exports = { STATE_FILE, load, save, recordCheck, recordInstall };
