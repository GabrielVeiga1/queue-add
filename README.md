# claude-queue

Fila de tarefas pro [Claude Code](https://claude.com/claude-code). Você enfileira
vários pedidos, ele roda um atrás do outro sozinho — sem você precisar ficar
digitando "próximo" toda hora.

## Pra que serve, na prática

Em vez de:
```
você escreve pedido 1 → espera terminar → escreve pedido 2 → espera → escreve pedido 3 ...
```

Você faz:
```
/queue add "pedido 1"
/queue add "pedido 2"
/queue add "pedido 3"
```

E o Claude vai emendando um depois do outro sozinho, na mesma conversa, sem você
precisar voltar lá a cada vez.

## O que ele faz

- **Enfileira pedidos** com prioridade (quem é mais importante roda primeiro)
- **Encadeia sozinho**: termina uma tarefa, já emenda a próxima automaticamente
- **Só avança se a tarefa anterior deu certo** — se algo quebrou, ele para a fila em vez de continuar empilhando erro em cima de erro
- **Dependência entre tarefas**: dá pra dizer "só roda a tarefa B depois que a A terminar com sucesso"
- **Painel visual (dashboard)**: uma telinha no navegador mostrando o status de tudo, ao vivo
- **Estatísticas**: quantas tarefas rodaram, taxa de sucesso, tempo total

Tudo roda local, na sua máquina, usando o Claude Code que você já tem instalado
e logado. Não precisa configurar nada extra, não precisa de senha ou chave de
acesso separada.

## Instalação

Dentro de uma sessão do Claude Code, digite:
```
/plugin marketplace add GabrielVeiga1/queue-add
/plugin install claude-queue@queue-add
```

Depois disso, feche e abra a sessão de novo (só da primeira vez, pra carregar
o plugin direito).

Pra desinstalar:
```
/plugin uninstall claude-queue@queue-add
```
(o histórico de tarefas não é apagado, fica guardado caso queira reinstalar depois)

## Como usar

### Adicionar uma tarefa na fila
```
/queue add "roda os testes e corrige o que falhar"
```

Opções que dá pra combinar:
```
/queue add "atualiza o changelog" --dir ~/projetos/api --priority 10
```
- `--dir <pasta>` — em qual pasta a tarefa deve rodar (padrão: a pasta atual)
- `--priority <número>` — número maior roda primeiro (padrão: 0)
- `--after <id>` — só roda depois que a tarefa com esse id terminar com sucesso
- `--auto` — pula as confirmações de permissão. **Só use em pastas/pedidos que você confia 100%.**

### Ver o que tem na fila
```
/queue list
```
Mostra cada tarefa com seu status: `queued` (esperando), `running` (rodando agora),
`done` (terminou bem), `failed` (deu erro), `rate_limited` (bateu limite de uso,
vai tentar de novo mais tarde).

### Remover uma tarefa
```
/queue remove <id>
```
(o id aparece no `/queue list`)

### Ver o painel visual
```
/queue dashboard
```
Depois abra `http://127.0.0.1:4317` no navegador. Atualiza sozinho a cada
poucos segundos. É só leitura — não consome token nem chama o Claude.

### Ver estatísticas
```
/queue stats
```
Total de tarefas, taxa de sucesso, tempo total rodando. Também só leitura local.

## Como funciona o encadeamento automático

Você não precisa fazer nada além de usar `/queue add`. Por trás dos panos:

1. Toda vez que uma resposta do Claude termina, o plugin confere se a tarefa
   que acabou de rodar terminou bem.
2. Se terminou bem, ele pega a próxima tarefa da fila e já manda rodar, na
   mesma conversa, sem você precisar digitar nada.
3. Se não terminou bem (ou não ficou claro se terminou bem), ele **para** —
   não arrisca empilhar tarefa em cima de algo que pode ter quebrado.

## Se bater o limite de uso

Se o Claude bater o limite de uso no meio de uma tarefa, o plugin não desiste
na hora — ele marca a tarefa como `rate_limited` e tenta de novo mais tarde,
esperando um pouco mais a cada tentativa (5min, depois 10min, depois 20min...
até no máximo 4h de espera).

## Avisos importantes

- **`--auto` pula as confirmações de permissão.** Só use em pedidos e pastas
  de confiança total — o Claude vai poder mexer em arquivos sem perguntar.
- **O modo `/queue run` (rodar tudo em background, tipo "deixa rodando a
  noite inteira") ainda não funciona no Windows.** O encadeamento automático
  dentro da mesma sessão (o jeito normal de usar, descrito acima) funciona
  normalmente — é só esse modo específico de rodar sem sessão aberta que
  está quebrado por enquanto.
- O painel (`/queue dashboard`) mostra o texto dos pedidos exatamente como
  foram digitados — evite colar coisas estranhas/código ali dentro.
- Os dados da fila ficam salvos em `~/.claude-queue/` no seu computador
  (histórico de tarefas e logs). Nada disso sai da sua máquina.

## Licença

MIT
