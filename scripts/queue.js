#!/usr/bin/env node
"use strict";
const crypto = require("crypto");
const path = require("path");
const store = require("./lib/store");
const { runTask } = require("./lib/runner");

const OK_MARKER = "[QUEUE:OK]";
const FAIL_MARKER = "[QUEUE:FAIL]";

const CHAIN_INSTRUCTIONS = `

---
Esta tarefa veio da fila do claude-queue. Ao terminar, na ÚLTIMA linha da sua resposta, escreva exatamente \`${OK_MARKER}\` se deu tudo certo, ou \`${FAIL_MARKER} <motivo curto>\` se algo falhou/ficou incompleto. Sem essa linha, a fila entende como falha e para de encadear.`;

function now() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomBytes(4).toString("hex");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function cmdAdd(args) {
  const prompt = args._[0];
  if (!prompt) {
    console.error("erro: prompt vazio");
    process.exit(1);
  }
  const tasks = store.load();
  const task = {
    id: newId(),
    prompt,
    dir: args.dir ? path.resolve(args.dir) : process.cwd(),
    priority: args.priority ? parseInt(args.priority, 10) : 0,
    after: args.after || null,
    auto: !!args.auto,
    status: "queued",
    created_at: now(),
    started_at: null,
    finished_at: null,
    exit_code: null,
    retry_count: 0,
    retry_at: null,
  };
  tasks.push(task);
  store.save(tasks);
  console.log(`adicionada: ${task.id}  (prioridade ${task.priority}, dir ${task.dir})`);
}

function cmdList() {
  const tasks = store.load();
  if (tasks.length === 0) {
    console.log("fila vazia");
    return;
  }
  const sorted = [...tasks].sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
  for (const t of sorted) {
    const dep = t.after ? ` after=${t.after}` : "";
    const status = t.status.padEnd(12);
    console.log(`[${status}] ${t.id}  p=${t.priority}${dep}  dir=${t.dir}  :: ${t.prompt.slice(0, 70)}`);
  }
}

function cmdRemove(args) {
  const id = args._[0];
  const tasks = store.load();
  const next = tasks.filter((t) => t.id !== id);
  if (next.length === tasks.length) {
    console.error(`não encontrado: ${id}`);
    process.exit(1);
  }
  store.save(next);
  console.log(`removida: ${id}`);
}

function isEligible(t, doneIds) {
  const statusOk = t.status === "queued" || (t.status === "rate_limited" && t.retry_at && Date.parse(t.retry_at) <= Date.now());
  if (!statusOk) return false;
  if (t.after && !doneIds.has(t.after)) return false;
  return true;
}

function pickNext(tasks) {
  const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  const candidates = tasks.filter((t) => isEligible(t, doneIds));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
  return candidates[0];
}

function cmdRun(args) {
  for (;;) {
    const tasks = store.load();
    const next = pickNext(tasks);
    if (!next) {
      const pending = tasks.filter((t) => t.status === "queued" || t.status === "rate_limited");
      if (pending.length > 0) {
        const waiting = pending.find((t) => t.status === "rate_limited");
        if (waiting) {
          console.log(`task ${waiting.id} rate-limited, aguardando até ${waiting.retry_at}`);
        } else {
          console.log(`${pending.length} task(s) bloqueada(s) por dependência não satisfeita, parando`);
        }
      } else {
        console.log("fila vazia, nada a rodar");
      }
      break;
    }

    next.status = "running";
    next.started_at = now();
    store.save(tasks);

    console.log(`-> rodando ${next.id}: ${next.prompt.slice(0, 70)}`);
    const result = runTask(next);
    result.finished_at = now();

    const latest = store.load();
    const idx = latest.findIndex((t) => t.id === result.id);
    if (idx !== -1) latest[idx] = result;
    store.save(latest);

    console.log(`<- ${result.id} terminou: ${result.status}`);
    if (args.once) break;
  }
}

function cmdChainNext() {
  const state = store.loadChainState();
  if (state !== null) {
    process.exit(3);
  }
  const tasks = store.load();
  const next = pickNext(tasks);
  if (!next) process.exit(2);

  next.status = "running";
  next.started_at = now();
  store.save(tasks);
  store.saveChainState({ pending_id: next.id });

  console.log(next.prompt + CHAIN_INSTRUCTIONS);
}

function cmdChainResult(args) {
  const status = args._[0];
  const reason = args._[1];
  const state = store.loadChainState();
  if (state === null) return;

  const tasks = store.load();
  const t = tasks.find((x) => x.id === state.pending_id);
  if (t) {
    t.status = status === "ok" ? "done" : "failed";
    t.finished_at = now();
    if (status !== "ok" && reason) t.fail_reason = reason;
  }
  store.save(tasks);
  store.saveChainState(null);
}

function cmdStats() {
  const tasks = store.load();
  const byStatus = {};
  let totalDurationMs = 0;
  let withDuration = 0;
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    if (t.duration_ms) {
      totalDurationMs += t.duration_ms;
      withDuration++;
    }
  }
  const done = byStatus.done || 0;
  const failed = byStatus.failed || 0;
  const attempted = done + failed;
  const successRate = attempted > 0 ? ((done / attempted) * 100).toFixed(1) : "—";

  console.log(`total de tasks: ${tasks.length}`);
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status}: ${count}`);
  }
  console.log(`taxa de sucesso (done/attempted): ${successRate}%`);
  console.log(`tempo total rodando (subprocess, soma): ${(totalDurationMs / 1000 / 60).toFixed(1)} min (${withDuration} tasks com duração registrada)`);
}

function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (command) {
    case "add":
      return cmdAdd(args);
    case "list":
      return cmdList();
    case "remove":
      return cmdRemove(args);
    case "run":
      return cmdRun(args);
    case "chain-next":
      return cmdChainNext();
    case "chain-result":
      return cmdChainResult(args);
    case "stats":
      return cmdStats();
    case "dashboard":
      return require("./dashboard").start(args);
    default:
      console.error("uso: queue.js <add|list|remove|run|stats|dashboard> [opções]");
      process.exit(1);
  }
}

main();
