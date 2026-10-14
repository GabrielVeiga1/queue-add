"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { parseArgs, strArg, sameDir, isEligible, pickNext } = require("../scripts/queue.js");

test("parseArgs: flag normal com valor", () => {
  const args = parseArgs(["add", "tarefa", "--priority", "5"]);
  assert.equal(args._[0], "add");
  assert.equal(args._[1], "tarefa");
  assert.equal(args.priority, "5");
});

test("parseArgs: flag sem valor (seguida de outra flag) vira boolean true", () => {
  // esse é o caso que crashava antes do fix — garantindo que o parseArgs
  // continua produzindo `true` aqui, e que é strArg() quem neutraliza isso
  // em queue.js (cmdAdd/cmdChainNext), não o parseArgs em si.
  const args = parseArgs(["--dir", "--priority", "5"]);
  assert.equal(args.dir, true);
  assert.equal(args.priority, "5");
});

test("strArg: só aceita string, trata boolean/undefined como 'não informado'", () => {
  assert.equal(strArg({ dir: "/tmp" }, "dir"), "/tmp");
  assert.equal(strArg({ dir: true }, "dir"), undefined);
  assert.equal(strArg({}, "dir"), undefined);
});

test("sameDir: compara paths normalizando, case-insensitive no Windows", () => {
  assert.equal(sameDir(process.cwd(), process.cwd()), true);
  assert.equal(sameDir("C:/a/b", "C:/a/c"), false);
  assert.equal(sameDir(null, "/a"), false);
  assert.equal(sameDir("/a", null), false);
  if (process.platform === "win32") {
    assert.equal(sameDir("C:/Users/Foo", "c:/users/foo"), true);
  }
});

function mkTask(overrides) {
  return {
    id: "id1",
    prompt: "p",
    dir: "C:/proj",
    priority: 0,
    after: null,
    status: "queued",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("isEligible: respeita status, dependência (--after) e escopo de pasta (--cwd)", () => {
  const doneIds = new Set(["a"]);
  assert.equal(isEligible(mkTask({ status: "queued" }), doneIds), true);
  assert.equal(isEligible(mkTask({ status: "done" }), doneIds), false);
  assert.equal(isEligible(mkTask({ status: "running" }), doneIds), false);

  // dependência não satisfeita
  assert.equal(isEligible(mkTask({ after: "b" }), doneIds), false);
  // dependência satisfeita
  assert.equal(isEligible(mkTask({ after: "a" }), doneIds), true);

  // scoping por pasta: só filtra quando cwd é passado
  assert.equal(isEligible(mkTask({ dir: "C:/proj" }), doneIds, "C:/outro"), false);
  assert.equal(isEligible(mkTask({ dir: "C:/proj" }), doneIds, "C:/proj"), true);
  assert.equal(isEligible(mkTask({ dir: "C:/proj" }), doneIds, undefined), true);
});

test("isEligible: rate_limited só reentra na fila depois do retry_at", () => {
  const doneIds = new Set();
  const futuro = new Date(Date.now() + 60_000).toISOString();
  const passado = new Date(Date.now() - 60_000).toISOString();
  assert.equal(isEligible(mkTask({ status: "rate_limited", retry_at: futuro }), doneIds), false);
  assert.equal(isEligible(mkTask({ status: "rate_limited", retry_at: passado }), doneIds), true);
});

test("pickNext: prioridade maior primeiro, empate por ordem de criação", () => {
  const tasks = [
    mkTask({ id: "baixa", priority: 1, created_at: "2026-01-01T00:00:00.000Z" }),
    mkTask({ id: "alta", priority: 10, created_at: "2026-01-01T00:00:01.000Z" }),
    mkTask({ id: "empate-antes", priority: 5, created_at: "2026-01-01T00:00:00.000Z" }),
    mkTask({ id: "empate-depois", priority: 5, created_at: "2026-01-01T00:00:01.000Z" }),
  ];
  assert.equal(pickNext(tasks).id, "alta");
  assert.equal(pickNext(tasks.filter((t) => t.id !== "alta")).id, "empate-antes");
});

test("pickNext: devolve null quando nada elegível", () => {
  assert.equal(pickNext([mkTask({ status: "done" })]), null);
  assert.equal(pickNext([]), null);
});

test("pickNext: --cwd nunca deixa vazar task de outra pasta (regressão do bug de scoping)", () => {
  const tasks = [
    mkTask({ id: "projA", dir: "C:/projA", priority: 99 }),
    mkTask({ id: "projB", dir: "C:/projB", priority: 1 }),
  ];
  assert.equal(pickNext(tasks, "C:/projB").id, "projB");
  assert.equal(pickNext(tasks, path.resolve("C:/projA")).id, "projA");
});
