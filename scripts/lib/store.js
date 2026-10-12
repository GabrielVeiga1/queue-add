"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const QUEUE_DIR = path.join(os.homedir(), ".claude-queue");
const TASKS_FILE = path.join(QUEUE_DIR, "tasks.json");
const LOGS_DIR = path.join(QUEUE_DIR, "logs");
const CHAIN_STATE_FILE = path.join(QUEUE_DIR, "chain_state.json");

function ensureDir() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function save(tasks) {
  ensureDir();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf8");
}

function loadChainState() {
  if (!fs.existsSync(CHAIN_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CHAIN_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveChainState(state) {
  ensureDir();
  if (state === null) {
    fs.rmSync(CHAIN_STATE_FILE, { force: true });
  } else {
    fs.writeFileSync(CHAIN_STATE_FILE, JSON.stringify(state), "utf8");
  }
}

function ensureLogsDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

module.exports = {
  QUEUE_DIR,
  TASKS_FILE,
  LOGS_DIR,
  load,
  save,
  loadChainState,
  saveChainState,
  ensureLogsDir,
};
