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
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30min — evita travar a fila inteira pra sempre se claude -p pendurar

// Resolve o caminho ABSOLUTO do binário `claude` uma vez (memoizado), em vez
// de deixar o shell procurar pelo nome "claude" sozinho. Isso fecha um
// vetor real: com shell:true no Windows e cwd=task.dir (pasta arbitrária
// vinda de --dir), o cmd.exe resolve nomes não-qualificados procurando
// PRIMEIRO no diretório de trabalho atual, antes do PATH — então um
// executável `claude.exe`/`claude.cmd` plantado dentro de task.dir seria
// executado no lugar do CLI real, sem precisar de --auto nem de caractere
// especial no prompt. Com caminho absoluto, não há nome pra resolver — o
// cmd.exe/shell roda exatamente esse arquivo, nunca um da pasta da task.
let cachedClaudeBin = null;
function resolveClaudeBin() {
  if (cachedClaudeBin !== null) return cachedClaudeBin;
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(finder, ["claude"], { encoding: "utf8" });
    const firstLine = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    cachedClaudeBin = r.status === 0 && firstLine ? firstLine : "claude";
  } catch {
    // sem `where`/`which` disponível (improvável) — cai pro nome simples,
    // mesmo comportamento de antes (spawnSync vai dar ENOENT se não achar)
    cachedClaudeBin = "claude";
  }
  return cachedClaudeBin;
}

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
  if (spawnError && spawnError.code === "ENOBUFS") {
    // maxBuffer estourado: a saída do claude -p foi cortada no meio por
    // exceder o limite (32MB) — sem essa checagem caía no fallback genérico
    // "saiu com código -1 (ver log)", escondendo a causa real.
    return { status: "failed", fail_reason: "saída do claude -p excedeu o limite de 32MB e foi cortada (ver log)" };
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

  // Checa a pasta ANTES de tentar rodar: se task.dir não existe (projeto foi
  // movido/apagado entre o /queue add e o /queue run), spawnSync também
  // falha com ENOENT — exatamente o mesmo código de erro de "comando claude
  // não encontrado". Sem checar antes, as duas causas ficavam
  // indistinguíveis e o usuário via uma mensagem enganosa.
  if (!fs.existsSync(task.dir)) {
    return { ...task, exit_code: -1, duration_ms: 0, status: "failed", fail_reason: `diretório não existe: ${task.dir}` };
  }

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
  const result = spawnSync(resolveClaudeBin(), args, {
    cwd: task.dir,
    input: task.prompt,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
    timeout: TASK_TIMEOUT_MS,
    killSignal: "SIGKILL",
    shell: process.platform === "win32",
  });
  process.noDeprecation = prevNoDeprecation;
  const durationMs = Date.now() - startedAt;

  fs.writeFileSync(logPath, `${result.stdout || ""}\n${result.stderr || ""}`, "utf8");

  const exitCode = result.status === null ? -1 : result.status;
  // se o spawnSync matou o processo por estourar `timeout` (ou qualquer
  // outro sinal), isso não é um erro reportado pelo claude -p — sem checar
  // `result.signal` antes, caía no fallback genérico de classify() como se
  // fosse um erro comum, sem nenhuma pista de que foi um timeout.
  const outcome = result.signal
    ? { status: "failed", fail_reason: `task interrompida por sinal ${result.signal} (provavelmente excedeu o limite de ${Math.round(TASK_TIMEOUT_MS / 60000)}min)` }
    : classify(task, result.stdout, result.stderr, exitCode, result.error);

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

module.exports = { runTask, isRateLimited, backoffDelay, classify, RATE_LIMIT_PATTERNS, resolveClaudeBin };
