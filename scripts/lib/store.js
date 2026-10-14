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
  // escreve em arquivo temporário e troca com rename (atômico no mesmo
  // filesystem) — evita tasks.json corrompido/truncado se o processo
  // morrer no meio da escrita.
  const tmp = `${TASKS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf8");
  fs.renameSync(tmp, TASKS_FILE);
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
    try {
      fs.rmSync(CHAIN_STATE_FILE, { force: true });
    } catch {
      // No Windows o arquivo pode estar momentaneamente travado (ex:
      // antivírus) e `rmSync` pode lançar EPERM mesmo com force:true (que só
      // ignora "arquivo não existe", não erro de permissão/lock). Sem esse
      // catch, isso derruba o processo e deixa chain_state.json órfão — o
      // que travaria TODO encadeamento futuro pra sempre (loadChainState
      // sempre acharia um estado pendente). Em vez de deletar, sobrescreve
      // com conteúdo inválido: loadChainState() trata JSON inválido como
      // "sem estado", então o efeito é o mesmo sem depender de conseguir
      // remover o arquivo.
      try {
        fs.writeFileSync(CHAIN_STATE_FILE, "", "utf8");
      } catch {
        // pior caso: deixa como está, a próxima chamada tenta de novo.
      }
    }
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
