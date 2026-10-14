"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const store = require("./store");

// IMPORTANTE: o CLI `claude -p` tem um bug conhecido e documentado
// (github.com/anthropics/claude-code/issues/79500) onde ele sempre sai com
// exit code 0 — mesmo quando a chamada falha por rate limit. Por isso NÃO
// dá pra confiar em exit code pra detectar sucesso/falha. A forma correta é
// rodar com `--output-format json` e checar o campo `is_error` da resposta
// estruturada; `subtype` também é enganoso ("success" mesmo com erro) e deve
// ser ignorado.
const RATE_LIMIT_PATTERNS = [
  /rate limit reached/i, // string exata reportada no bug #79500
  /usage limit/i,
  /limit will reset/i,
  /resets at/i,
  /too many requests/i,
  /\b429\b/,
];

const DEFAULT_BACKOFF_MS = 5 * 60 * 1000; // 5min
const MAX_BACKOFF_MS = 4 * 60 * 60 * 1000; // 4h

function isRateLimited(text) {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

// Claude Code não expõe retry-after/reset timestamp em nenhum formato de
// saída documentado — backoff é só exponencial local mesmo.
function backoffDelay(retryCount) {
  const delay = DEFAULT_BACKOFF_MS * Math.pow(2, retryCount);
  return Math.min(delay, MAX_BACKOFF_MS);
}

function tryParseJson(stdout) {
  const trimmed = (stdout || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // às vezes vem mais de uma linha de log antes do JSON; tenta pegar só a última linha
    const lastLine = trimmed.split("\n").pop();
    try {
      return JSON.parse(lastLine);
    } catch {
      return null;
    }
  }
}

function classify(task, stdout, stderr, exitCode, spawnError) {
  if (spawnError && spawnError.code === "ENOENT") {
    return { status: "failed", fail_reason: "comando 'claude' não encontrado no PATH" };
  }

  const parsed = tryParseJson(stdout);

  if (parsed && typeof parsed === "object" && "is_error" in parsed) {
    if (!parsed.is_error) {
      return { status: "done" };
    }
    const resultText = String(parsed.result || parsed.error || "");
    if (isRateLimited(resultText)) {
      return { status: "rate_limited", fail_reason: resultText.slice(0, 200) || "rate limit detectado" };
    }
    return { status: "failed", fail_reason: resultText.slice(0, 200) || "erro reportado pelo claude -p" };
  }

  // fallback: não deu pra parsear JSON estruturado — não confia em exit code
  // (bug #79500), decide por texto bruto combinado
  const combined = `${stdout || ""}\n${stderr || ""}`;
  if (isRateLimited(combined)) {
    return { status: "rate_limited", fail_reason: "rate limit detectado (fallback texto)" };
  }
  if (exitCode === 0) {
    return { status: "done" };
  }
  return { status: "failed", fail_reason: `claude -p saiu com código ${exitCode} (ver log)` };
}

/**
 * Roda uma task via `claude -p ... --output-format json` (subprocess,
 * headless, CLI já autenticado). Grava log completo em
 * ~/.claude-queue/logs/<id>.log. Retorna a task atualizada.
 */
function runTask(task) {
  store.ensureLogsDir();
  const logPath = path.join(store.LOGS_DIR, `${task.id}.log`);

  // O prompt vai via STDIN (`input`), nunca como argumento de linha de
  // comando. `claude -p` lê o prompt do stdin quando não recebe argumento
  // posicional. Isso evita dois problemas reais: (1) no Windows, com
  // shell:true (necessário abaixo), caracteres como `<` e `>` no prompt são
  // tratados como operadores de redirecionamento pelo cmd.exe MESMO dentro
  // de aspas — testado e confirmado (um prompt com "<algo>" quebrava a
  // chamada inteira); (2) fecha de vez qualquer risco de shell injection via
  // prompt, já que nenhum texto do usuário chega a tocar a linha de comando
  // interpretada pelo shell — só os args fixos abaixo (-p, --output-format,
  // json, opcionalmente --dangerously-skip-permissions) passam por ali.
  const args = ["-p", "--output-format", "json"];
  if (task.auto) args.push("--dangerously-skip-permissions");

  // No Windows o binário `claude` instalado via npm é um shim `.cmd`, que o
  // Windows só executa através de um shell (cmd.exe) — sem isso, spawnSync
  // falha com ENOENT mesmo com o comando certo no PATH. `shell: true` é a
  // única forma suportada pelo Node de rodar um .cmd aqui.
  const prevNoDeprecation = process.noDeprecation;
  if (process.platform === "win32") process.noDeprecation = true; // DEP0190 — args são todos literais fixos, sem conteúdo do usuário

  const startedAt = Date.now();
  const result = spawnSync("claude", args, {
    cwd: task.dir,
    input: task.prompt,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
    shell: process.platform === "win32",
  });
  process.noDeprecation = prevNoDeprecation;
  const durationMs = Date.now() - startedAt;

  fs.writeFileSync(logPath, `${result.stdout || ""}\n${result.stderr || ""}`, "utf8");

  const exitCode = result.status === null ? -1 : result.status;
  const outcome = classify(task, result.stdout, result.stderr, exitCode, result.error);

  task.exit_code = exitCode;
  task.duration_ms = durationMs;
  task.status = outcome.status;
  if (outcome.fail_reason) task.fail_reason = outcome.fail_reason;

  if (outcome.status === "rate_limited") {
    const retryCount = task.retry_count || 0;
    task.retry_count = retryCount + 1;
    task.retry_at = new Date(Date.now() + backoffDelay(retryCount)).toISOString();
  }

  return task;
}

module.exports = { runTask, isRateLimited, backoffDelay, classify, RATE_LIMIT_PATTERNS };
