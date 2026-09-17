import fs from "node:fs";
import path from "node:path";

const file = path.resolve("data/store.json");

function empty() {
  return { tickets: {}, sessions: {} };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return empty();
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function getStore() {
  return load();
}

export function updateStore(mutator) {
  const data = load();
  mutator(data);
  save(data);
  return data;
}

export function makeCode(prefix = "t") {
  const part = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${part}`;
}
