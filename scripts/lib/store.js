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

function backupCorrupted(raw) {
  try {
    fs.writeFileSync(`${TASKS_FILE}.corrompido-${Date.now()}`, raw || "", "utf8");
  } catch {
    // melhor esforço; se nem isso der, segue o baile com fila vazia mesmo
  }
  console.error(`aviso: ${TASKS_FILE} estava corrompido e foi tratado como fila vazia — backup salvo ao lado como tasks.json.corrompido-<timestamp>`);
}

function load() {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) return [];
  let raw;
  let parsed;
  try {
    raw = fs.readFileSync(TASKS_FILE, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    // tasks.json corrompido (ex: processo morto no meio de uma escrita não
    // atômica de uma versão antiga, edição manual quebrada). Em vez de
    // silenciosamente devolver fila vazia — o que parece "perdi todo o
    // histórico" sem nenhum aviso — guarda o conteúdo quebrado do lado e
    // avisa, pra dar pra recuperar na mão se precisar.
    backupCorrupted(raw);
    return [];
  }
  if (!Array.isArray(parsed)) {
    // JSON sintaticamente válido mas não é o array esperado (ex: `{}`,
    // `null`, edição manual malfeita). Sem essa checagem, isso derrubava
    // add/list/remove com um erro genérico ("tasks is not iterable") sem
    // nenhuma pista de que o problema é o conteúdo de tasks.json — tratado
    // igual a JSON corrompido (mesmo backup + aviso).
    backupCorrupted(raw);
    return [];
  }
  return parsed;
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

// Chave normalizada por pasta (case-insensitive no Windows), igual ao
// sameDir() de scripts/queue.js — chain_state.json guarda um MAPA
// { "<pasta normalizada>": { pending_id } }, não mais um pending_id global
// único. Isso é necessário porque uma sessão travada/fechada no meio de uma
// task encadeada numa pasta não pode derrubar o encadeamento automático de
// TODAS as outras pastas/projetos (era exatamente o que acontecia antes: um
// único lock global por conta inteira).
function chainKey(cwd) {
  return process.platform === "win32" ? path.resolve(cwd || "").toLowerCase() : path.resolve(cwd || "");
}

function loadChainMap() {
  if (!fs.existsSync(CHAIN_STATE_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(CHAIN_STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // inclui o formato antigo de v1.1.0 ({ pending_id: "..." }, achatado,
    // sem chave de pasta) e qualquer JSON inválido: tratado como mapa vazio,
    // efeito equivalente a "sem nenhum estado pendente em nenhuma pasta" —
    // migração automática e silenciosa, sem travar nada.
    return {};
  }
}

function loadChainState(cwd) {
  return loadChainMap()[chainKey(cwd)] || null;
}

function saveChainState(cwd, state) {
  ensureDir();
  const map = loadChainMap();
  const key = chainKey(cwd);
  if (state === null) {
    delete map[key];
  } else {
    map[key] = state;
  }
  // mesmo padrão atômico (tmp+rename) do tasks.json — e como agora é sempre
  // uma reescrita do arquivo inteiro (nunca um delete), o caso de EPERM do
  // Windows ao tentar remover um arquivo travado (problema da versão
  // anterior) nem existe mais nesse caminho.
  const tmp = `${CHAIN_STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map), "utf8");
  fs.renameSync(tmp, CHAIN_STATE_FILE);
}

function ensureLogsDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

module.exports = {
  QUEUE_DIR,
  TASKS_FILE,
  LOGS_DIR,
  CHAIN_STATE_FILE,
  load,
  save,
  loadChainState,
  saveChainState,
  ensureLogsDir,
};
