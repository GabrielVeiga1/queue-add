---
name: queue
description: Fila local de prompts para rodar via CLI oficial do Claude (claude -p), sequencial, sem tocar session key/endpoint interno. Use quando o usuário pedir pra enfileirar um prompt, rodar algo "quando terminar o que está fazendo", processar tasks em lote, ou invocar /queue.
---

# Queue

Orquestra `claude -p` (headless, CLI já autenticado) rodando prompts em sequência.
Dados em `~/.claude-queue/tasks.json`, logs em `~/.claude-queue/logs/<id>.log`.
Script: `~/.claude/skills/queue/queue.py` (python3, sem dependências externas).

## Comandos

`/queue add "<prompt>" [--dir <path>] [--priority N] [--after <id>] [--auto]`
Adiciona prompt na fila.
- `--dir`: diretório de trabalho da task (default: diretório atual)
- `--priority`: maior número roda primeiro (default 0)
- `--after <id>`: só roda depois que a task `<id>` terminar com sucesso
- `--auto`: roda com `--dangerously-skip-permissions` (sem prompt de permissão). Só use se confiar 100% no prompt/diretório.

`/queue list`
Lista tasks (status, prioridade, dir, prompt).

`/queue remove <id>`
Remove task da fila (só antes de rodar).

`/queue run [--once]`
Processa a fila: pega a task de maior prioridade com dependências satisfeitas, roda `claude -p` nela até terminar, salva log, marca done/failed, pega a próxima. Para quando a fila esvaziar ou travar em dependência. `--once` roda só uma e para.

## Como executar

Sempre chame o script via Bash:

```bash
python3 ~/.claude/skills/queue/queue.py add "faça X" --dir /caminho/projeto --priority 5
python3 ~/.claude/skills/queue/queue.py list
python3 ~/.claude/skills/queue/queue.py run
```

No Windows, se `python3` não existir no PATH, usar `python`.

## Modo "encadear na mesma sessão" (hook Stop)

Se instalado via `install.py` (ver README do repo), toda vez que uma resposta
termina, o hook `Stop` automaticamente:

1. Confere se a task que acabou de rodar terminou com `[QUEUE:OK]` na última
   linha. Sem esse marcador (ou com `[QUEUE:FAIL] motivo`), considera falha e
   **para a corrente** — não emenda a próxima task.
2. Se ok, pega a próxima task da fila e injeta como continuação da mesma
   conversa, sem o usuário digitar nada.

Por isso, ao escrever/gerar o prompt de uma task pensada pra rodar em cadeia,
a instrução do marcador já vai anexada automaticamente pelo `chain-next` —
não precisa fazer nada manual, só `/queue add`.

## Por que isso é seguro (vs. ferramentas tipo claude-queue do GitHub)

- Usa só o CLI oficial `claude -p`, já autenticado localmente — nenhuma session key, cookie ou endpoint interno de claude.ai é tocado.
- Sem risco de ToS: é só automação de linha de comando em cima do produto oficial.
- `--auto` é opt-in explícito por task — por padrão respeita prompts de permissão normais do Claude Code.
