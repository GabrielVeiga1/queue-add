# Changelog

## 1.2.0

Segunda rodada de review (hands-on + revisão multi-dimensional com verificação
adversarial), focada em casos extremos e robustez.

### Corrigido
- **Falso-positivo de falha no encadeamento**: o hook procurava `[QUEUE:FAIL]`
  na resposta inteira em vez de só na última linha — se o assistente citasse o
  protocolo em algum parágrafo (ex: "vou escrever [QUEUE:FAIL] se der erro"),
  a task era marcada como falha mesmo terminando certinho com `[QUEUE:OK]`.
- **Lock de encadeamento era global pra conta inteira**: uma sessão travada no
  meio de uma task num projeto derrubava o encadeamento automático de TODOS os
  outros projetos, silenciosamente, até alguém apagar `chain_state.json` na
  mão. Agora é escopado por pasta (mapa em vez de um único `pending_id`).
- **Hijack de executável via `--dir` no Windows**: `spawnSync` usava o nome
  não-qualificado `claude` com `cwd` arbitrário (vindo de `--dir`); o cmd.exe
  resolve nomes não-qualificados procurando a pasta atual antes do PATH, então
  um `claude.exe`/`claude.cmd` plantado na pasta da task seria executado no
  lugar do CLI real. Corrigido resolvendo o caminho absoluto do `claude` uma
  vez, via `where`/`which`.
- `tasks.json` com JSON sintaticamente válido mas não-array (`{}`, `null`)
  derrubava todo comando com erro genérico — agora tratado como corrompido
  (backup + aviso), igual ao JSON malformado.
- `/queue dashboard --port` sem valor ou inválido crashava; rodar o dashboard
  duas vezes na mesma porta derrubava o processo com stack trace cru. Ambos
  agora dão mensagem amigável.
- `/queue list` crashava se uma task não tivesse o campo `status`.
- `/queue stats` sempre mostrava "0min" de tempo rodado pra tasks concluídas
  via encadeamento automático (só o modo `run` calculava `duration_ms`).
- `claude -p` travado (rede, deadlock) prendia `/queue run` pra sempre, sem
  timeout — agora mata em 30min e marca a task como falha com motivo claro.
- Estouro do limite de buffer (32MB) da saída do `claude -p` era reportado
  como erro genérico; agora tem mensagem específica.
- `chain_state.json` não usava escrita atômica no caminho de gravação — podia
  corromper com o processo morrendo no meio.

### Adicionado
- `/queue dashboard` agora valida o header `Host` (protege contra DNS
  rebinding) e mostra o motivo da falha (`fail_reason`) no hover do status.
- `/queue remove` avisa quando a task removida tem outras dependendo dela via
  `--after` (elas ficariam travadas pra sempre).
- Suíte de testes automatizados (`node:test` nativo, zero dependências,
  `npm test`) cobrindo toda a lógica pura do projeto.
- Seção "Por que isso é seguro" e nota de consumo de cota no README (antes só
  existiam no SKILL.md, que o usuário final nunca lê).

## 1.1.0

Primeira rodada de review (hands-on, incluindo análise forense de uso real).

### Corrigido
- **Encadeamento automático falhava sistematicamente**: o hook lia o
  transcript da sessão em disco pra achar o marcador de conclusão, com race
  condition confirmada (a última linha podia não estar gravada ainda quando o
  hook rodava). Trocado para usar `last_assistant_message`, campo oficial do
  evento Stop.
- `--dir` era ignorado no modo de encadeamento em sessão — uma task podia
  rodar na sessão aberta de outro projeto. Hook agora passa `--cwd`.
- `/queue run` quebrado no Windows (`claude` é um shim `.cmd` do npm,
  `spawnSync` dava `ENOENT`). Corrigido com shell condicional + prompt via
  stdin (que também fechou um bug de `<`/`>` quebrando o cmd.exe).
- XSS armazenado no dashboard (prompt/dir não eram escapados antes do
  `innerHTML`).
- `--dir`/`--priority`/`--after` sem valor crashavam ou salvavam `NaN`/`true`.
- `EPERM` do Windows ao limpar `chain_state.json` podia crashar o processo e
  travar o encadeamento pra sempre.
- `tasks.json` não usava escrita atômica.

## 1.0.0

Primeira versão pública: fila local de prompts, encadeamento automático via
hook `Stop`, execução em background via `claude -p`, backoff em rate limit,
dashboard e estatísticas.
