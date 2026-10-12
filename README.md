# claude-queue

Fila local de prompts pro [Claude Code](https://claude.com/claude-code): enfileira
tarefas, roda sequencial, **encadeia automaticamente** a próxima task assim que a
atual termina — na mesma sessão, sem você digitar nada — e recua sozinho quando
bate rate limit, em vez de desistir.

Plugin oficial do Claude Code: zero dependência externa (Node, que o próprio
Claude Code já exige), instala com um comando.

Inspirado em [vasiliyk/claude-queue](https://github.com/vasiliyk/claude-queue), mas
com uma diferença de arquitetura deliberada:

| | vasiliyk/claude-queue | claude-queue (este) |
|---|---|---|
| Autenticação | `CLAUDE_SESSION_KEY` extraída de cookie do claude.ai | nenhuma — usa o CLI `claude` já autenticado na sua máquina |
| Monitoramento de limite | acessa endpoint interno não documentado do claude.ai | reage ao próprio erro que o CLI oficial já devolve, sem tocar infraestrutura interna |
| Risco de ToS | o próprio repo admite que pode violar os Termos de Serviço | automação em cima do produto oficial |
| Confirmação de sucesso | — | marcador explícito `[QUEUE:OK]` / `[QUEUE:FAIL]`, escrito pelo próprio Claude, lido pelo hook |
| Distribuição | clone manual + env var | plugin oficial do Claude Code |

## O que faz

- **`/queue add "<prompt>"`** — enfileira, com prioridade e dependências entre tasks
- **`/queue list`** — status de cada task (queued/running/done/failed/rate_limited)
- **Encadeamento automático (hook `Stop`)** — toda vez que uma resposta termina, confere se a task anterior teve sucesso confirmado e injeta a próxima na mesma conversa. Sem confirmação = para a corrente, não arrisca encadear em cima de algo quebrado.
- **`/queue run`** — modo background: processa a fila inteira como subprocessos `claude -p`, pra deixar rodando desatendido (overnight, por exemplo)
- **Retry automático em rate limit** — detecta quando `claude -p` bateu o limite de uso e reagenda com backoff exponencial, em vez de marcar como falha
- **`/queue dashboard`** — painel web local, ao vivo, pra acompanhar a fila (print/gif-friendly)
- **`/queue stats`** — total de tasks, taxa de sucesso, tempo total rodado

Dashboard e stats só leem `~/.claude-queue/tasks.json` — não chamam o Claude, não custam token.

## O bug de rate limit que isso contorna

O `claude -p` tem um bug documentado
([anthropics/claude-code#79500](https://github.com/anthropics/claude-code/issues/79500)):
ele sempre sai com exit code `0`, **mesmo quando a chamada falha por rate
limit**. Não dá pra confiar em exit code pra saber se deu certo.

A solução: rodar com `--output-format json` e decidir pelo campo `is_error`
da resposta estruturada (o `subtype` também mente — diz "success" mesmo com
erro). Quando o texto do erro bate com "rate limit reached" e afins, a task
vira `rate_limited` com backoff exponencial (5min → 10min → 20min... até 4h)
em vez de `failed`. Claude Code não expõe timestamp de reset em nenhum
formato de saída documentado, então o backoff é local — não tem como saber
exatamente quando o limite libera, só tentar de novo mais tarde.

## Instalação

Requisitos: [Claude Code](https://claude.com/claude-code) v2.1.275+ (sessão) ou v2.1.292+ (shell), já logado.

**Dentro de uma sessão do Claude Code:**
```
/plugin marketplace add GabrielVeiga1/queue-add
/plugin install claude-queue@queue-add
```

**Ou pelo shell:**
```bash
claude plugin marketplace add GabrielVeiga1/queue-add
claude plugin install claude-queue@queue-add
```

Reinicie sessões abertas pra pegar o hook `Stop` novo.

### Desinstalar

```
/plugin uninstall claude-queue@queue-add
```

Dados da fila em `~/.claude-queue/` não são apagados (histórico de tasks e logs ficam preservados).

## Uso básico

Dentro de uma sessão do Claude Code:

```
/queue add "roda os testes e corrige o que falhar" --dir ~/projetos/api --priority 10
/queue add "atualiza o changelog" --dir ~/projetos/api --priority 5
/queue list
```

A primeira task já começa a rodar sozinha assim que a conversa atual
terminar. As próximas emendam automaticamente, uma por vez, até a fila
esvaziar ou alguma falhar.

Pra ver o painel: `/queue dashboard` e abrir `http://127.0.0.1:4317`.

Pra rodar em background (sem depender de sessão aberta — modo overnight):
`/queue run`. Logs completos ficam em `~/.claude-queue/logs/<id>.log`.

## Estrutura

```
claude-queue/
├── .claude-plugin/
│   ├── plugin.json          # manifesto do plugin
│   └── marketplace.json     # self-distribuição via GitHub
├── skills/queue/SKILL.md    # definição do /queue pro Claude Code
├── scripts/
│   ├── queue.js             # CLI da fila (add/list/remove/run/stats/dashboard/chain-*)
│   ├── dashboard.js         # painel web local
│   └── lib/
│       ├── store.js         # persistência (~/.claude-queue/tasks.json)
│       └── runner.js        # subprocess claude -p, detecção de rate limit, backoff
└── hooks/
    └── queue-stop-hook.js   # hook Stop: lê marcador, encadeia próxima task
```

## Limitações conhecidas

- `--auto` roda com `--dangerously-skip-permissions` — só use em prompts/diretórios de confiança total.
- O encadeamento por hook depende do Claude escrever o marcador corretamente; trate prompts de fontes não confiáveis com o mesmo cuidado que trataria em qualquer outro contexto do Claude Code.
- Backoff de rate limit é exponencial "no escuro" — Claude Code não informa quando o limite realmente reseta.
- Dependências entre tasks (`--after`) exigem sucesso (`done`); task `failed` ou `rate_limited` nunca libera a dependente.

## Licença

MIT
