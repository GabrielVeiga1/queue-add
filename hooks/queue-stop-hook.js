#!/usr/bin/env node
"use strict";
/**
 * claude-queue Stop hook.
 *
 * Claude Code chama este script toda vez que uma resposta termina (evento
 * "Stop"), passando um JSON no stdin com, entre outras coisas, o caminho do
 * transcript da sessão.
 *
 * 1. Se existe uma task pendente de resultado (injetada no Stop anterior),
 *    lê a última mensagem do assistente no transcript e procura o marcador
 *    [QUEUE:OK] ou [QUEUE:FAIL] <motivo>. Sem marcador OK explícito, trata
 *    como falha (fail-safe) e PARA a corrente.
 * 2. Se não tem task pendente (ou acabou de resolver uma com sucesso), pega
 *    a próxima task da fila (queue.js chain-next). Se tiver, devolve
 *    {"decision": "block", "reason": "<prompt>"} — isso impede o Claude Code
 *    de encerrar e injeta o prompt como continuação da mesma sessão.
 * 3. Se a fila está vazia, ou a última task falhou, deixa parar normal.
 *
 * Fail-open: qualquer erro inesperado aqui deixa a sessão parar normal, pra
 * nunca travar o Claude Code por causa de um bug neste hook.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const QUEUE_SCRIPT = path.join(__dirname, "..", "scripts", "queue.js");
const OK_MARKER = "[QUEUE:OK]";
const FAIL_MARKER = "[QUEUE:FAIL]";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function runQueue(...args) {
  try {
    return spawnSync(process.execPath, [QUEUE_SCRIPT, ...args], { encoding: "utf8", timeout: 15000 });
  } catch {
    return null;
  }
}

function lastAssistantText(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return "";
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry && entry.message;
    const role = (msg && msg.role) || entry.type;
    if (role !== "assistant") continue;

    const content = (msg && msg.content) || [];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const textParts = content.filter((c) => c && c.type === "text").map((c) => c.text || "");
      if (textParts.length) return textParts.join("\n");
    }
  }
  return "";
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    process.exit(0);
  }

  if (payload.stop_hook_active) process.exit(0);
  if (!fs.existsSync(QUEUE_SCRIPT)) process.exit(0);

  const chainStateFile = path.join(require("os").homedir(), ".claude-queue", "chain_state.json");
  if (fs.existsSync(chainStateFile)) {
    const text = lastAssistantText(payload.transcript_path || "");
    if (text.includes(FAIL_MARKER)) {
      const reason = text.split(FAIL_MARKER)[1].trim().split("\n")[0].slice(0, 200);
      runQueue("chain-result", "fail", reason || "sem motivo informado");
      process.exit(0); // para a corrente
    } else if (text.includes(OK_MARKER)) {
      runQueue("chain-result", "ok");
    } else {
      runQueue("chain-result", "fail", "resposta terminou sem marcador de conclusão");
      process.exit(0); // fail-safe: sem marcador, para
    }
  }

  const result = runQueue("chain-next");
  if (!result || result.status !== 0) process.exit(0);

  const nextPrompt = (result.stdout || "").trim();
  if (!nextPrompt) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: "block", reason: nextPrompt }));
  process.exit(0);
}

main();
