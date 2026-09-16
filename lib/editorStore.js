const fs = require("fs");
const path = require("path");

const STORE_FILE = path.join(__dirname, "..", "editor_settings.json");

function load() {
  if (!fs.existsSync(STORE_FILE)) return { editors: [] };
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { editors: Array.isArray(data.editors) ? data.editors : [] };
  } catch {
    return { editors: [] };
  }
}

function save(state) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function getEditors() {
  return load().editors;
}

function addEditor(phone) {
  const state = load();
  if (!state.editors.includes(phone)) {
    state.editors.push(phone);
    save(state);
    return true;
  }
  return false;
}

function removeEditor(phone) {
  const state = load();
  const before = state.editors.length;
  state.editors = state.editors.filter((p) => p !== phone);
  save(state);
  return state.editors.length < before;
}

module.exports = { getEditors, addEditor, removeEditor };
