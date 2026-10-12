#!/usr/bin/env python3
"""
claude-queue Stop hook.

Claude Code chama este script toda vez que uma resposta termina (evento
"Stop"), passando um JSON no stdin com, entre outras coisas, o caminho do
transcript da sessão.

O que ele faz:
1. Se existe uma task pendente de resultado (foi injetada no Stop anterior),
   lê a última mensagem do assistente no transcript e procura o marcador
   `[QUEUE:OK]` ou `[QUEUE:FAIL] <motivo>`. Sem marcador OK explícito, trata
   como falha (fail-safe) e PARA a corrente.
2. Se não tem task pendente (ou acabou de resolver uma com sucesso), pega a
   próxima task da fila (queue.py chain-next). Se tiver, devolve
   {"decision": "block", "reason": "<prompt>"} — isso impede o Claude Code
   de encerrar e injeta o prompt como continuação da mesma sessão.
3. Se a fila está vazia, ou a última task falhou, deixa parar normal
   (sem stdout, exit 0).

Nunca lança exceção sem tratar: se algo der errado aqui, deixa a sessão
parar normal (fail-open pra não travar o Claude Code).
"""
import json
import subprocess
import sys
from pathlib import Path

QUEUE_SCRIPT = Path.home() / ".claude" / "skills" / "queue" / "queue.py"
OK_MARKER = "[QUEUE:OK]"
FAIL_MARKER = "[QUEUE:FAIL]"


def _python():
    return sys.executable or "python3"


def _run_queue(*args):
    try:
        return subprocess.run(
            [_python(), str(QUEUE_SCRIPT), *args],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception:
        return None


def _last_assistant_text(transcript_path):
    try:
        lines = Path(transcript_path).read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return ""

    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        msg = entry.get("message") if isinstance(entry, dict) else None
        role = (msg or {}).get("role") or entry.get("type")
        if role != "assistant":
            continue

        content = (msg or {}).get("content", [])
        if isinstance(content, str):
            return content
        text_parts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
        if text_parts:
            return "\n".join(text_parts)
    return ""


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if payload.get("stop_hook_active"):
        sys.exit(0)

    if not QUEUE_SCRIPT.exists():
        sys.exit(0)

    # 1. resolve task pendente, se houver
    chain_state_file = Path.home() / ".claude-queue" / "chain_state.json"
    if chain_state_file.exists():
        text = _last_assistant_text(payload.get("transcript_path", ""))
        if FAIL_MARKER in text:
            reason = text.split(FAIL_MARKER, 1)[1].strip().splitlines()[0][:200]
            _run_queue("chain-result", "fail", reason or "sem motivo informado")
            sys.exit(0)  # para a corrente, deixa stop normal
        elif OK_MARKER in text:
            _run_queue("chain-result", "ok")
        else:
            # sem marcador = não dá pra confirmar sucesso -> fail-safe, para
            _run_queue("chain-result", "fail", "resposta terminou sem marcador de conclusão")
            sys.exit(0)

    # 2. tenta puxar a próxima task da fila
    result = _run_queue("chain-next")
    if result is None or result.returncode != 0:
        sys.exit(0)

    next_prompt = result.stdout.strip()
    if not next_prompt:
        sys.exit(0)

    print(json.dumps({"decision": "block", "reason": next_prompt}))
    sys.exit(0)


if __name__ == "__main__":
    main()
