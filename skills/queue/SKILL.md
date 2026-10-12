---
name: queue
description: Fila local de prompts pro Claude Code — encadeia tasks automaticamente na mesma sessão, roda em background via claude -p, recua sozinho em rate limit. Use quando o usuário pedir pra enfileirar um prompt, rodar algo "quando terminar o que está fazendo", processar tasks em lote, ver o dashboard da fila, ou invocar /queue.
---

# Queue

Orquestra `claude -p` (headless, CLI já autenticado) rodando prompts em sequência.
Dados em `~/.claude-queue/tasks.json`, logs em `~/.claude-queue/logs/<id>.log`.
Script: `${CLAUDE_PLUGIN_ROOT}/scripts/queue.js` (Node, sem dependências externas).

## Comandos

`/queue add "<prompt>" [--dir <path>] [--priority N] [--after <id>] [--auto]`
Adiciona prompt na fila.
- `--dir`: diretório de trabalho da task (default: diretório atual)
- `--priority`: maior número roda primeiro (default 0)
- `--after <id>`: só roda depois que a task `<id>` terminar com sucesso
- `--auto`: roda com `--dangerously-skip-permissions`. Só use se confiar 100% no prompt/diretório.

`/queue list` — mostra status de todas as tasks (queued/running/done/failed/rate_limited).

`/queue remove <id>` — remove task da fila (só antes de rodar).

`/queue run [--once]` — processa a fila em background: roda `claude -p --output-format json` pra cada task, salva log completo, marca done/failed/rate_limited, pega a próxima. Se bater rate limit, reagenda automaticamente com backoff exponencial em vez de desistir. `--once` roda só uma e para.

`/queue stats` — total de tasks por status, taxa de sucesso, tempo total rodado. Só lê dados locais, não chama o Claude.

`/queue dashboard [--port N]` — sobe um painel web local (`http://127.0.0.1:4317` por default) mostrando a fila ao vivo. Só leitura local, zero chamadas ao Claude.

## Como executar

Sempre chame o script via Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" add "faça X" --dir /caminho/projeto --priority 5
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" list
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" run
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" stats
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" dashboard
```

Se `${CLAUDE_PLUGIN_ROOT}` não estiver setado (instalação manual/dev), usar o caminho absoluto do clone do repo no lugar.

## Modo "encadear na mesma sessão" (hook Stop, automático)

O plugin já vem com o hook `Stop` registrado. Toda vez que uma resposta termina:

1. Confere se a task que acabou de rodar terminou com `[QUEUE:OK]` na última linha da resposta. Sem esse marcador (ou com `[QUEUE:FAIL] motivo`), considera falha e **para a corrente** — não emenda a próxima task. Isso é fail-safe de propósito: sem confirmação explícita de sucesso, não arrisca encadear em cima de algo que pode ter quebrado.
2. Se ok, pega a próxima task da fila e injeta como continuação da mesma conversa, sem o usuário digitar nada.

O texto do marcador já vem anexado automaticamente ao prompt pelo `chain-next` — não precisa fazer nada manual, só `/queue add`.

## Rate limit (modo `run`/background)

`claude -p` tem um bug documentado onde sempre sai com exit code 0, mesmo em
rate limit (anthropics/claude-code#79500). Por isso `queue run` roda com
`--output-format json` e decide pelo campo `is_error` da resposta estruturada
em vez de confiar no exit code. Quando detecta "Rate limit reached", marca a
task como `rate_limited` com backoff exponencial (5min, 10min, 20min... até
4h) em vez de desistir — ela volta sozinha pra fila quando o horário de retry
chegar. Isso não acessa nenhum endpoint interno nem monitora o limite de uso
em tempo real — é só reação ao erro que o próprio CLI oficial já devolve.

## Por que isso é seguro (vs. ferramentas tipo claude-queue do GitHub)

- Usa só o CLI oficial `claude -p`, já autenticado localmente — nenhuma session key, cookie ou endpoint interno de claude.ai é tocado.
- Sem risco de ToS: é só automação de linha de comando em cima do produto oficial.
- `--auto` é opt-in explícito por task — por padrão respeita prompts de permissão normais do Claude Code.
- Dashboard e stats só leem dados locais (`~/.claude-queue/`) — não fazem chamada nenhuma ao Claude, não custam token extra.
