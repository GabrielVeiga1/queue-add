"use strict";
// Isola esse arquivo de teste do ~/.claude-queue de verdade: troca a home
// ANTES de dar require em store.js (ele resolve os caminhos uma vez, na
// hora do require). Cada arquivo de teste roda em processo separado com
// `node --test`, então isso não vaza pra outros testes.
const os = require("os");
const path = require("path");
const fs = require("fs");

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-queue-test-"));
if (process.platform === "win32") {
  process.env.USERPROFILE = fakeHome;
} else {
  process.env.HOME = fakeHome;
}

const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../scripts/lib/store.js");

test.after(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test("load: fila vazia quando tasks.json não existe ainda", () => {
  assert.deepEqual(store.load(), []);
});

test("save/load: grava e lê de volta (write atômico tmp+rename)", () => {
  const tasks = [{ id: "a", status: "queued" }];
  store.save(tasks);
  assert.deepEqual(store.load(), tasks);
  // não deve sobrar arquivo .tmp depois do rename
  const leftovers = fs.readdirSync(path.dirname(store.TASKS_FILE)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("load: tasks.json corrompido (JSON inválido) vira fila vazia + aviso + backup ao lado", () => {
  fs.mkdirSync(path.dirname(store.TASKS_FILE), { recursive: true });
  fs.writeFileSync(store.TASKS_FILE, "{ isso não é json válido", "utf8");

  const originalError = console.error;
  let warned = false;
  console.error = (msg) => {
    warned = /corrompido/.test(msg);
  };
  const result = store.load();
  console.error = originalError;

  assert.deepEqual(result, []);
  assert.equal(warned, true);
  const backups = fs.readdirSync(path.dirname(store.TASKS_FILE)).filter((f) => f.includes("corrompido"));
  assert.ok(backups.length >= 1, "deveria ter salvo um backup do arquivo corrompido");
});

test("load: tasks.json com JSON válido mas que não é array (ex: {}, null) também é tratado como corrompido, não quebra", () => {
  for (const bad of ["{}", "null", "42", '"string"']) {
    fs.writeFileSync(store.TASKS_FILE, bad, "utf8");
    assert.deepEqual(store.load(), [], `esperava fila vazia pra conteúdo ${bad}`);
  }
});

test("chain state: loadChainState é null quando não existe, e depois de saveChainState(cwd, null)", () => {
  const dir = process.cwd();
  assert.equal(store.loadChainState(dir), null);
  store.saveChainState(dir, { pending_id: "abc" });
  assert.deepEqual(store.loadChainState(dir), { pending_id: "abc" });
  store.saveChainState(dir, null);
  assert.equal(store.loadChainState(dir), null);
});

test("chain state: é escopado por pasta — travar numa pasta não afeta outra (regressão do lock global)", () => {
  const dirA = path.join(os.tmpdir(), "projA");
  const dirB = path.join(os.tmpdir(), "projB");
  store.saveChainState(dirA, { pending_id: "tarefa-presa-em-A" });
  assert.deepEqual(store.loadChainState(dirA), { pending_id: "tarefa-presa-em-A" });
  assert.equal(store.loadChainState(dirB), null, "pasta B não deveria ver o estado pendente da pasta A");
  store.saveChainState(dirA, null);
});

test("chain state: formato antigo (flat, v1.1.0) não quebra — tratado como mapa vazio", () => {
  fs.mkdirSync(path.dirname(store.TASKS_FILE), { recursive: true });
  fs.writeFileSync(store.CHAIN_STATE_FILE, JSON.stringify({ pending_id: "formato-antigo" }), "utf8");
  assert.equal(store.loadChainState(process.cwd()), null);
});
