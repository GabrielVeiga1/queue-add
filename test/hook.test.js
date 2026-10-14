"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractText, finalAssistantText, findMarker } = require("../hooks/queue-stop-hook.js");

test("extractText: aceita string simples", () => {
  assert.equal(extractText("texto puro\n[QUEUE:OK]"), "texto puro\n[QUEUE:OK]");
});

test("extractText: aceita array de blocos, ignora os que não são 'text'", () => {
  const value = [
    { type: "text", text: "parte 1" },
    { type: "thinking", text: "não deveria aparecer" },
    { type: "text", text: "[QUEUE:OK]" },
  ];
  assert.equal(extractText(value), "parte 1\n[QUEUE:OK]");
});

test("extractText: aceita objeto com .text ou .content", () => {
  assert.equal(extractText({ text: "[QUEUE:OK]" }), "[QUEUE:OK]");
  assert.equal(extractText({ content: [{ type: "text", text: "[QUEUE:OK]" }] }), "[QUEUE:OK]");
});

test("extractText: vazio/undefined/formato desconhecido -> string vazia, nunca lança", () => {
  assert.equal(extractText(undefined), "");
  assert.equal(extractText(null), "");
  assert.equal(extractText(42), "");
});

test("finalAssistantText: usa last_assistant_message (oficial) quando disponível, não toca no transcript", () => {
  const r = finalAssistantText({ last_assistant_message: "[QUEUE:OK]", transcript_path: "/caminho/que/nao/existe.jsonl" });
  assert.equal(r.text, "[QUEUE:OK]");
  assert.equal(r.source, "last_assistant_message");
});

test("finalAssistantText: cai pro fallback de transcript só quando last_assistant_message vem vazio", () => {
  const r = finalAssistantText({ transcript_path: "/caminho/que/nao/existe.jsonl" });
  assert.equal(r.text, "");
  assert.equal(r.source, "transcript_fallback");
});

test("findMarker: pega OK/FAIL na última linha", () => {
  assert.deepEqual(findMarker("fiz tudo\n[QUEUE:OK]"), { marker: "ok" });
  assert.deepEqual(findMarker("deu ruim\n[QUEUE:FAIL] motivo curto"), { marker: "fail", reason: "motivo curto" });
});

test("findMarker: ignora menção ao marcador fora da última linha (regressão: FAIL citado no meio do texto não derrubava mais uma resposta que terminou OK)", () => {
  const texto = "Vou seguir o protocolo: escrevo [QUEUE:FAIL] <motivo> se der erro.\nTudo certo.\n[QUEUE:OK]";
  assert.deepEqual(findMarker(texto), { marker: "ok" });
});

test("findMarker: sem marcador nenhum -> null", () => {
  assert.deepEqual(findMarker("só terminei de explicar, sem marcador"), { marker: null });
});

test("findMarker: ignora linhas em branco no final (marcador na última linha com conteúdo)", () => {
  assert.deepEqual(findMarker("[QUEUE:OK]\n\n\n"), { marker: "ok" });
});
