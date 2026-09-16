const fs = require("fs");
const path = require("path");

const STORE_FILE = path.join(__dirname, "..", "admin_settings.json");

function load() {
  if (!fs.existsSync(STORE_FILE)) {
    return { selfReportEnabled: true, admins: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      selfReportEnabled: data.selfReportEnabled !== false,
      admins: Array.isArray(data.admins) ? data.admins : [],
    };
  } catch {
    return { selfReportEnabled: true, admins: [] };
  }
}

function save(state) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function getState() {
  return load();
}

function isSelfReportEnabled() {
  return load().selfReportEnabled;
}

function setSelfReportEnabled(enabled) {
  const state = load();
  state.selfReportEnabled = enabled;
  save(state);
}

function addAdmin(phone) {
  const state = load();
  if (!state.admins.includes(phone)) {
    state.admins.push(phone);
    save(state);
    return true;
  }
  return false;
}

function removeAdmin(phone) {
  const state = load();
  const before = state.admins.length;
  state.admins = state.admins.filter((p) => p !== phone);
  save(state);
  return state.admins.length < before;
}

function getAdmins() {
  return load().admins;
}

module.exports = {
  getState,
  isSelfReportEnabled,
  setSelfReportEnabled,
  addAdmin,
  removeAdmin,
  getAdmins,
};
