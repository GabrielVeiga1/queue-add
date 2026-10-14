#!/usr/bin/env node
"use strict";
/**
 * claude-queue Stop hook.
 *
 * Claude Code chama este script toda vez que uma resposta termina (evento
 * "Stop"), passando um JSON no stdin com, entre outras coisas, o cwd da
 * sessão e o texto final da resposta do assistente.
 *
 * 1. Se existe uma task pendente de resultado (injetada no Stop anterior),
 *    pega o texto final da resposta do assistente e procura o marcador
 *    [QUEUE:OK] ou [QUEUE:FAIL] <motivo>. Sem marcador OK explícito, trata
 *    como falha (fail-safe) e PARA a corrente.
 * 2. Se não tem task pendente (ou acabou de resolver uma com sucesso), pega
 *    a próxima task da fila pra ESSA pasta (queue.js chain-next --cwd). Se
 *    tiver, devolve {"decision": "block", "reason": "<prompt>"} — isso
 *    impede o Claude Code de encerrar e injeta o prompt como continuação da
 *    mesma sessão.
 * 3. Se a fila está vazia (ou não tem task pra essa pasta), ou a última
 *    task falhou, deixa parar normal.
 *
 * Fail-open: qualquer erro inesperado aqui deixa a sessão parar normal, pra
 * nunca travar o Claude Code por causa de um bug neste hook.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const QUEUE_SCRIPT = path.join(__dirname, "..", "scripts", "queue.js");
const OK_MARKER = "[QUEUE:OK]";
const FAIL_MARKER = "[QUEUE:FAIL]";
const DEBUG_LOG = path.join(os.homedir(), ".claude-queue", "logs", "hook-debug.log");

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

// Registra só o caso "sem marcador" (o caso interessante/raro) pra dar pra
// diagnosticar sem precisar vasculhar transcript na mão. Nunca deixa um
// erro de log derrubar o hook (fail-open).
function logMissingMarker(source, text) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    const snippet = text.length > 300 ? `${text.slice(0, 150)} […] ${text.slice(-150)}` : text;
    const line = `${new Date().toISOString()} source=${source} len=${text.length} text=${JSON.stringify(snippet)}\n`;
    fs.appendFileSync(DEBUG_LOG, line, "utf8");
  } catch {
    // fail-open, log é só conveniência de diagnóstico
  }
}

function extractText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((c) => c && c.type === "text").map((c) => c.text || "").join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return extractText(value.content);
  }
  return "";
}

// Lê o transcript JSONL e pega o texto da última entrada com role
// "assistant". MANTIDO SÓ COMO FALLBACK: ler o transcript manualmente aqui
// corre risco de race condition com a escrita do Claude Code (a última
// linha pode ainda não ter sido persistida no disco no exato instante em
// que o hook roda, fazendo o hook cair numa mensagem intermediária sem
// marcador e declarar falha por engano — foi exatamente isso que causou
// falsos "sem marcador de conclusão" em uso real). A doc oficial recomenda
// `last_assistant_message` do próprio payload do Stop pra esse caso
// exatamente por isso; usamos ele como fonte primária em finalAssistantText.
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
    const text = extractText(content);
    if (text) return text;
  }
  return "";
}

// Fonte primária: payload.last_assistant_message (campo oficial do evento
// Stop, preenchido pelo próprio Claude Code — sem risco de race condition
// com leitura de arquivo). Cai pro parse manual do transcript só se esse
// campo não vier (versões mais antigas do Claude Code, por ex).
function finalAssistantText(payload) {
  const direct = extractText(payload.last_assistant_message);
  if (direct) return { text: direct, source: "last_assistant_message" };
  return { text: lastAssistantText(payload.transcript_path || ""), source: "transcript_fallback" };
}

function lastNonEmptyLine(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

// Restrito à ÚLTIMA LINHA não-vazia da resposta — igual ao que é pedido ao
// modelo em CHAIN_INSTRUCTIONS. Antes isso procurava o marcador na resposta
// INTEIRA (text.includes), então se o assistente citasse/explicasse o
// protocolo (ex: "...vou escrever [QUEUE:FAIL] <motivo> se der erro...") em
// qualquer parágrafo anterior, a task era marcada como falha mesmo tendo
// terminado certinho com [QUEUE:OK] na última linha.
function findMarker(text) {
  const line = lastNonEmptyLine(text);
  if (line.includes(FAIL_MARKER)) {
    return { marker: "fail", reason: line.split(FAIL_MARKER)[1].trim().slice(0, 200) };
  }
  if (line.includes(OK_MARKER)) {
    return { marker: "ok" };
  }
  return { marker: null };
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    process.exit(0);
  }
  if (!payload || typeof payload !== "object") payload = {};

  if (payload.stop_hook_active) process.exit(0);
  if (!fs.existsSync(QUEUE_SCRIPT)) process.exit(0);

  // cwd é um campo comum garantido em todo hook (doc oficial), mas sem ele
  // não dá pra escopar com segurança nem o lock de encadeamento nem a
  // seleção de task por pasta — melhor não fazer nada do que arriscar picar
  // a pasta errada.
  const cwd = payload.cwd || "";
  if (!cwd) process.exit(0);

  const pendingCheck = runQueue("has-pending", "--cwd", cwd);
  if (pendingCheck && pendingCheck.status === 0) {
    const { text, source } = finalAssistantText(payload);
    const { marker, reason } = findMarker(text);
    if (marker === "fail") {
      runQueue("chain-result", "fail", reason || "sem motivo informado", "--cwd", cwd);
      process.exit(0); // para a corrente
    } else if (marker === "ok") {
      runQueue("chain-result", "ok", "--cwd", cwd);
    } else {
      logMissingMarker(source, text);
      runQueue("chain-result", "fail", "resposta terminou sem marcador de conclusão", "--cwd", cwd);
      process.exit(0); // fail-safe: sem marcador, para
    }
  }

  const result = runQueue("chain-next", "--cwd", cwd);
  if (!result || result.status !== 0) process.exit(0);

  const nextPrompt = (result.stdout || "").trim();
  if (!nextPrompt) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: "block", reason: nextPrompt }));
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch {
    // fail-open: qualquer bug inesperado aqui deixa a sessão parar normal
    process.exit(0);
  }
}

module.exports = { extractText, finalAssistantText, findMarker };
