#!/usr/bin/env python3
"""
claude-queue: fila local de prompts para rodar sequencialmente via CLI oficial
`claude -p` (headless). Sem session key, sem endpoint interno — só orquestra
o CLI já autenticado na máquina.

Dados em: ~/.claude-queue/tasks.json
Logs em:  ~/.claude-queue/logs/<task_id>.log
"""
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

QUEUE_DIR = Path.home() / ".claude-queue"
TASKS_FILE = QUEUE_DIR / "tasks.json"
LOGS_DIR = QUEUE_DIR / "logs"
CHAIN_STATE_FILE = QUEUE_DIR / "chain_state.json"

OK_MARKER = "[QUEUE:OK]"
FAIL_MARKER = "[QUEUE:FAIL]"

CHAIN_INSTRUCTIONS = (
    "\n\n---\n"
    "Esta tarefa veio da fila do claude-queue. Ao terminar, na ÚLTIMA linha da sua "
    f"resposta, escreva exatamente `{OK_MARKER}` se deu tudo certo, ou "
    f"`{FAIL_MARKER} <motivo curto>` se algo falhou/ficou incompleto. "
    "Sem essa linha, a fila entende como falha e para de encadear."
)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _load():
    QUEUE_DIR.mkdir(exist_ok=True)
    if not TASKS_FILE.exists():
        return []
    try:
        return json.loads(TASKS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save(tasks):
    QUEUE_DIR.mkdir(exist_ok=True)
    TASKS_FILE.write_text(json.dumps(tasks, indent=2, ensure_ascii=False), encoding="utf-8")


def cmd_add(args):
    prompt = args.prompt
    if not prompt:
        print("erro: prompt vazio", file=sys.stderr)
        sys.exit(1)
    tasks = _load()
    task = {
        "id": uuid.uuid4().hex[:8],
        "prompt": prompt,
        "dir": str(Path(args.dir).resolve()) if args.dir else os.getcwd(),
        "priority": args.priority,
        "after": args.after,
        "auto": args.auto,
        "status": "queued",
        "created_at": _now(),
        "started_at": None,
        "finished_at": None,
        "exit_code": None,
    }
    tasks.append(task)
    _save(tasks)
    print(f"adicionada: {task['id']}  (prioridade {task['priority']}, dir {task['dir']})")


def cmd_list(args):
    tasks = _load()
    if not tasks:
        print("fila vazia")
        return
    for t in sorted(tasks, key=lambda x: (-x["priority"], x["created_at"])):
        dep = f" after={t['after']}" if t.get("after") else ""
        print(f"[{t['status']:12}] {t['id']}  p={t['priority']}{dep}  dir={t['dir']}  :: {t['prompt'][:70]}")


def cmd_remove(args):
    tasks = _load()
    new_tasks = [t for t in tasks if t["id"] != args.id]
    if len(new_tasks) == len(tasks):
        print(f"não encontrado: {args.id}", file=sys.stderr)
        sys.exit(1)
    _save(new_tasks)
    print(f"removida: {args.id}")


def _pick_next(tasks):
    done_ids = {t["id"] for t in tasks if t["status"] == "done"}
    candidates = [
        t for t in tasks
        if t["status"] == "queued" and (not t.get("after") or t["after"] in done_ids)
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda x: (-x["priority"], x["created_at"]))
    return candidates[0]


def _run_task(task, tasks):
    task["status"] = "running"
    task["started_at"] = _now()
    _save(tasks)

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOGS_DIR / f"{task['id']}.log"

    cmd = ["claude", "-p", task["prompt"]]
    if task.get("auto"):
        cmd.append("--dangerously-skip-permissions")

    print(f"-> rodando {task['id']}: {task['prompt'][:70]}")
    with open(log_path, "w", encoding="utf-8") as logf:
        try:
            result = subprocess.run(
                cmd,
                cwd=task["dir"],
                stdout=logf,
                stderr=subprocess.STDOUT,
            )
            task["exit_code"] = result.returncode
            task["status"] = "done" if result.returncode == 0 else "failed"
        except FileNotFoundError:
            task["exit_code"] = -1
            task["status"] = "failed"
            logf.write("erro: comando 'claude' não encontrado no PATH\n")

    task["finished_at"] = _now()
    _save(tasks)
    print(f"<- {task['id']} terminou: {task['status']} (log: {log_path})")


def _load_chain_state():
    if not CHAIN_STATE_FILE.exists():
        return None
    try:
        return json.loads(CHAIN_STATE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _save_chain_state(state):
    QUEUE_DIR.mkdir(exist_ok=True)
    if state is None:
        CHAIN_STATE_FILE.unlink(missing_ok=True)
    else:
        CHAIN_STATE_FILE.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def cmd_chain_next(args):
    """Usado pelo hook Stop: pega a próxima task e imprime o prompt pronto
    pra ser injetado na sessão viva (modo 'mesma sessão', sem subprocess)."""
    state = _load_chain_state()
    if state is not None:
        # já existe uma task pendente de resultado; não emenda outra até
        # ela ser resolvida via chain-result
        sys.exit(3)

    tasks = _load()
    next_task = _pick_next(tasks)
    if not next_task:
        sys.exit(2)

    next_task["status"] = "running"
    next_task["started_at"] = _now()
    _save(tasks)
    _save_chain_state({"pending_id": next_task["id"]})

    print(next_task["prompt"] + CHAIN_INSTRUCTIONS)


def cmd_chain_result(args):
    """Usado pelo hook Stop: registra o resultado (ok/fail) da task que
    estava pendente, lido do marcador na última mensagem do assistente."""
    state = _load_chain_state()
    if state is None:
        sys.exit(0)

    tasks = _load()
    for t in tasks:
        if t["id"] == state["pending_id"]:
            t["status"] = "done" if args.status == "ok" else "failed"
            t["finished_at"] = _now()
            if args.status != "ok" and args.reason:
                t["fail_reason"] = args.reason
            break
    _save(tasks)
    _save_chain_state(None)


def cmd_run(args):
    while True:
        tasks = _load()
        next_task = _pick_next(tasks)
        if not next_task:
            pending = [t for t in tasks if t["status"] == "queued"]
            if pending:
                print(f"{len(pending)} task(s) bloqueada(s) por dependência não satisfeita, parando")
            else:
                print("fila vazia, nada a rodar")
            break
        _run_task(next_task, tasks)
        if args.once:
            break


def main():
    import argparse

    parser = argparse.ArgumentParser(prog="queue")
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="adiciona prompt na fila")
    p_add.add_argument("prompt")
    p_add.add_argument("--dir", default=None, help="diretório de trabalho (default: cwd atual)")
    p_add.add_argument("--priority", type=int, default=0, help="maior roda primeiro")
    p_add.add_argument("--after", default=None, help="id de task que precisa terminar antes")
    p_add.add_argument("--auto", action="store_true", help="roda com --dangerously-skip-permissions")
    p_add.set_defaults(func=cmd_add)

    p_list = sub.add_parser("list", help="lista tasks")
    p_list.set_defaults(func=cmd_list)

    p_rm = sub.add_parser("remove", help="remove task da fila")
    p_rm.add_argument("id")
    p_rm.set_defaults(func=cmd_remove)

    p_run = sub.add_parser("run", help="processa a fila sequencialmente")
    p_run.add_argument("--once", action="store_true", help="roda só a próxima task e para")
    p_run.set_defaults(func=cmd_run)

    p_chain_next = sub.add_parser("chain-next", help="(uso interno do hook) pega próxima task pra injetar na sessão viva")
    p_chain_next.set_defaults(func=cmd_chain_next)

    p_chain_result = sub.add_parser("chain-result", help="(uso interno do hook) registra resultado ok/fail da task pendente")
    p_chain_result.add_argument("status", choices=["ok", "fail"])
    p_chain_result.add_argument("reason", nargs="?", default=None)
    p_chain_result.set_defaults(func=cmd_chain_result)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
