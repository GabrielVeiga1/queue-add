#!/usr/bin/env python3
"""
Instalador do claude-queue.

- Copia a skill (SKILL.md + queue.py) para ~/.claude/skills/queue
- Copia o hook Stop para ~/.claude/hooks/queue_stop_hook.py
- Registra o hook em ~/.claude/settings.json (mescla, não sobrescreve)

Rodar: python3 install.py   (ou python install.py no Windows)
Desinstalar: python3 install.py --uninstall
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent
CLAUDE_DIR = Path.home() / ".claude"
SKILL_DST = CLAUDE_DIR / "skills" / "queue"
HOOK_DST = CLAUDE_DIR / "hooks" / "queue_stop_hook.py"
SETTINGS_FILE = CLAUDE_DIR / "settings.json"

HOOK_MARKER = "queue_stop_hook.py"


def install():
    SKILL_DST.mkdir(parents=True, exist_ok=True)
    shutil.copy2(REPO_DIR / "skill" / "SKILL.md", SKILL_DST / "SKILL.md")
    shutil.copy2(REPO_DIR / "skill" / "queue.py", SKILL_DST / "queue.py")
    print(f"skill instalada em {SKILL_DST}")

    HOOK_DST.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(REPO_DIR / "hooks" / "queue_stop_hook.py", HOOK_DST)
    print(f"hook instalado em {HOOK_DST}")

    settings = {}
    if SETTINGS_FILE.exists():
        try:
            settings = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"aviso: {SETTINGS_FILE} não é JSON válido, não mexi nele. "
                  f"Adicione o hook manualmente (veja README).", file=sys.stderr)
            return

    hooks = settings.setdefault("hooks", {})
    stop_hooks = hooks.setdefault("Stop", [])

    already = any(
        HOOK_MARKER in json.dumps(entry)
        for entry in stop_hooks
    )
    if not already:
        stop_hooks.append({
            "matcher": "",
            "hooks": [
                {
                    "type": "command",
                    "command": f'"{sys.executable}" "{HOOK_DST}"',
                }
            ],
        })
        SETTINGS_FILE.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"hook Stop registrado em {SETTINGS_FILE}")
    else:
        print("hook Stop já estava registrado, não duplicado")

    print("\npronto. Reinicie sessões abertas do Claude Code pra pegar o hook novo.")
    print('uso: /queue add "faça X" --dir /caminho --priority 5   |   /queue run   |   /queue list')


def uninstall():
    if SKILL_DST.exists():
        shutil.rmtree(SKILL_DST)
        print(f"removido {SKILL_DST}")
    if HOOK_DST.exists():
        HOOK_DST.unlink()
        print(f"removido {HOOK_DST}")

    if SETTINGS_FILE.exists():
        try:
            settings = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return
        stop_hooks = settings.get("hooks", {}).get("Stop", [])
        new_stop_hooks = [
            entry for entry in stop_hooks
            if HOOK_MARKER not in json.dumps(entry)
        ]
        if len(new_stop_hooks) != len(stop_hooks):
            settings["hooks"]["Stop"] = new_stop_hooks
            SETTINGS_FILE.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
            print("hook Stop removido de settings.json")

    print("claude-queue desinstalado. (dados em ~/.claude-queue não foram apagados)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    uninstall() if args.uninstall else install()


if __name__ == "__main__":
    main()
