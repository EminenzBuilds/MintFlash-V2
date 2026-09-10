const fs = require('fs');
const path = require('path');
const { config } = require('./config');

function filePath() {
  return path.join(config.dataDir, 'scheduled-mints.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath());
}

function generateId() {
  return `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function add(userId, entry) {
  const data = load();
  const key = String(userId);
  if (!data[key]) data[key] = [];
  data[key].push(entry);
  save(data);
  return entry;
}

function remove(userId, scheduleId) {
  const data = load();
  const key = String(userId);
  if (!data[key]) return;
  data[key] = data[key].filter((s) => s.id !== scheduleId);
  if (!data[key].length) delete data[key];
  save(data);
}

function list(userId) {
  return load()[String(userId)] || [];
}

function allEntries() {
  const data = load();
  const out = [];
  for (const [userId, entries] of Object.entries(data)) {
    for (const entry of entries) out.push({ userId, entry });
  }
  return out;
}

function countAll() {
  return allEntries().length;
}

module.exports = {
  generateId,
  add,
  remove,
  list,
  allEntries,
  countAll
};
