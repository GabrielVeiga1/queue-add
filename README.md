# claude-queue

Fila local de prompts pro [Claude Code](https://claude.com/claude-code): enfileira
tarefas, roda sequencial, e opcionalmente **encadeia automaticamente** a próxima
task assim que a atual termina — na mesma sessão, sem você precisar digitar nada.

Inspirado em [vasiliyk/claude-queue](https://github.com/vasiliyk/claude-queue), mas
com uma diferença de arquitetura importante:

| | vasiliyk/claude-queue | este projeto |
|---|---|---|
| Autenticação | `CLAUDE_SESSION_KEY` extraída de cookie do claude.ai | nenhuma — usa o CLI `claude` já autenticado na sua máquina |
| Monitoramento de limite | acessa endpoint interno não documentado do claude.ai | não acessa nada interno |
| Risco de ToS | o próprio repo admite que pode violar os Termos de Serviço | automação em cima do produto oficial, sem tocar infraestrutura interna |
| Detecção de sucesso/falha | — | marcador explícito `[QUEUE:OK]` / `[QUEUE:FAIL]` escrito pelo próprio Claude |

## O que faz

- `/queue add "<prompt>" [--dir X] [--priority N] [--after <id>] [--auto]` — enfileira
- `/queue list` — mostra status de todas as tasks
- `/queue remove <id>` — remove da fila
- `/queue run [--once]` — processa a fila rodando `claude -p` (headless, subprocess) pra cada task, com log completo salvo
- **Hook `Stop` automático**: ao instalar, toda vez que uma resposta termina dentro de uma sessão do Claude Code, confere a fila e injeta a próxima task na mesma conversa — só se a task anterior terminou com sucesso confirmado

## Por que o marcador de sucesso é confiável

Diferente de heurística por palavra-chave, a task injetada vem com instrução
explícita pro Claude terminar a resposta com `[QUEUE:OK]` ou
`[QUEUE:FAIL] <motivo>`. O hook lê essa linha no transcript da sessão. Sem
marcador nenhum = tratado como falha (fail-safe): a corrente para em vez de
seguir cegamente.

## Instalação

Requisitos: Python 3.8+, [Claude Code](https://claude.com/claude-code) já instalado e logado.

```bash
git clone <url-deste-repo>
cd claude-queue
python3 install.py
```

Isso copia a skill pra `~/.claude/skills/queue`, o hook pra `~/.claude/hooks/queue_stop_hook.py`,
e registra o hook em `~/.claude/settings.json` (mescla — não sobrescreve configs existentes).

No Windows, use `python install.py` (sem o 3).

### Desinstalar

```bash
python3 install.py --uninstall
```

Remove skill, hook e entrada em `settings.json`. Dados da fila em `~/.claude-queue/` não são apagados.

## Uso básico

Dentro de uma sessão do Claude Code:

```
/queue add "roda os testes e corrige o que falhar" --dir ~/projetos/api --priority 10
/queue add "atualiza o changelog" --dir ~/projetos/api --priority 5
/queue list
```

A primeira task já começa a rodar sozinha assim que a conversa atual terminar
(hook Stop). As próximas emendam automaticamente, uma por vez, até a fila
esvaziar ou alguma falhar.

Pra rodar manualmente em vez de esperar o hook: `/queue run`.

## Modo background (subprocess, sem depender de sessão aberta)

`/queue run` roda cada task como processo `claude -p` separado — serve pra
deixar rodando tipo overnight, sem precisar de uma sessão interativa aberta.
Logs completos ficam em `~/.claude-queue/logs/<id>.log`, com exit code real
(mais confiável que o marcador, já que é um processo isolado).

## Estrutura

```
claude-queue/
├── install.py              # instalador (copia + registra hook)
├── skill/
│   ├── SKILL.md             # definição do /queue pro Claude Code
│   └── queue.py             # CLI da fila (add/list/remove/run/chain-*)
└── hooks/
    └── queue_stop_hook.py   # hook Stop: lê marcador, encadeia próxima task
```

## Limitações conhecidas

- `--auto` roda com `--dangerously-skip-permissions` — só use em prompts/diretórios de confiança total.
- O encadeamento por hook depende do Claude escrever o marcador corretamente; se um prompt malicioso/externo tentar forjar `[QUEUE:OK]` pra continuar a corrente indevidamente, trate prompts de fontes não confiáveis com o mesmo cuidado que trataria em qualquer outro contexto do Claude Code.
- Dependências entre tasks (`--after`) exigem sucesso (`done`), task com `failed` nunca libera a dependente.
