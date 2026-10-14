"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { isRateLimited, backoffDelay, classify, runTask, resolveClaudeBin } = require("../scripts/lib/runner.js");

test("isRateLimited: reconhece as variações de mensagem de rate limit", () => {
  assert.equal(isRateLimited("Rate limit reached, tente mais tarde"), true);
  assert.equal(isRateLimited("You hit your usage limit for today"), true);
  assert.equal(isRateLimited("HTTP 429 Too Many Requests"), true);
  assert.equal(isRateLimited("deu erro de sintaxe no código"), false);
});

test("backoffDelay: exponencial com teto de 4h", () => {
  assert.equal(backoffDelay(0), 5 * 60 * 1000);
  assert.equal(backoffDelay(1), 10 * 60 * 1000);
  assert.equal(backoffDelay(2), 20 * 60 * 1000);
  assert.equal(backoffDelay(10), 4 * 60 * 60 * 1000); // teto
});

test("classify: is_error=false -> done, mesmo que o texto do resultado contenha '429' por acaso", () => {
  const stdout = JSON.stringify({ is_error: false, result: "a resposta menciona o código 429 só de exemplo" });
  assert.equal(classify({}, stdout, "", 0, null).status, "done");
});

test("classify: is_error=true com texto de rate limit -> rate_limited", () => {
  const stdout = JSON.stringify({ is_error: true, result: "Rate limit reached, resets at 10pm" });
  assert.equal(classify({}, stdout, "", 1, null).status, "rate_limited");
});

test("classify: is_error=true sem texto de rate limit -> failed", () => {
  const stdout = JSON.stringify({ is_error: true, result: "erro de permissão no arquivo X" });
  assert.equal(classify({}, stdout, "", 1, null).status, "failed");
});

test("classify: spawnError ENOENT -> failed com mensagem de comando não encontrado", () => {
  const r = classify({}, "", "", -1, { code: "ENOENT" });
  assert.equal(r.status, "failed");
  assert.match(r.fail_reason, /claude.*não encontrado/);
});

test("classify: spawnError ENOBUFS (maxBuffer estourado) -> failed com mensagem específica, não o fallback genérico de exit code", () => {
  const r = classify({}, "{ json cortado no meio", "", -1, { code: "ENOBUFS" });
  assert.equal(r.status, "failed");
  assert.match(r.fail_reason, /32MB|buffer/);
});

test("classify: JSON ilegível (claude -p sempre sai exit 0 mesmo com erro, #79500) cai pro fallback de texto", () => {
  // sem JSON estruturado: não confia em exit code 0 isolado quando o texto bruto grita rate limit
  const r = classify({}, "saida quebrada", "Too Many Requests", 0, null);
  assert.equal(r.status, "rate_limited");
});

test("classify: exit code 0 sem JSON e sem sinal de rate limit -> done (fallback)", () => {
  assert.equal(classify({}, "ok", "", 0, null).status, "done");
});

test("resolveClaudeBin: resolve caminho absoluto (regressão: nome não-qualificado 'claude' + cwd arbitrário permitia hijack via executável plantado na pasta da task)", () => {
  const bin = resolveClaudeBin();
  assert.equal(typeof bin, "string");
  assert.ok(bin.length > 0);
  // se `claude` está instalado nesta máquina (é o caso do ambiente de dev/CI
  // que já roda Claude Code), o resultado tem que ser um caminho absoluto —
  // nunca o nome cru "claude", que é exatamente o que ficava sujeito a
  // resolução via cwd no Windows.
  if (bin !== "claude") {
    assert.ok(path.isAbsolute(bin), `esperava caminho absoluto, recebi: ${bin}`);
  }
});

test("runTask: dir inexistente falha com mensagem específica, sem tentar rodar claude (regressão: antes dava o mesmo ENOENT de 'claude não encontrado')", () => {
  const result = runTask({ id: "x", prompt: "oi", dir: "C:/essa/pasta/nao/existe/" + Date.now(), auto: false });
  assert.equal(result.status, "failed");
  assert.match(result.fail_reason, /diretório não existe/);
  assert.equal(result.duration_ms, 0); // nem chegou a tentar spawnSync
});
