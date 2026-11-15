# A partir do Claude Code

[English](claude-code.md) · Estado: ✅ verificado ao vivo ([harnesses.md](../harnesses.md))

Para as sessões que correste com `claude` num terminal ou com a extensão do Claude Code no VS Code, numa conta ou em
várias. `t3sm` é o comando que instalas uma vez ([install.md](../install.md), em inglês); o `t3sm update` mantém-no atualizado.

## O que é importado

- Todas as sessões em `<pasta da conta>/projects/`, seja qual for a idade, como threads do T3 Code que retomam a
  sessão original (quem importa é o próprio importador de Claude do T3 Code).
- Cada sessão vai para a instância da pasta de conta onde está. As contas são encontradas nas pastas `~/.claude` e
  `~/.claude-*`, nos aliases e funções do perfil da shell que definem `CLAUDE_CONFIG_DIR` e nos pins por projeto da
  extensão do VS Code (`claudeCode.environmentVariables` em `.vscode/settings.json`). Mais de uma conta:
  [multiple-accounts.pt.md](multiple-accounts.pt.md).
- As transcrições de sub-agentes aparecem dentro da sessão-mãe, não como threads.
- Sessões da tua pasta pessoal, de Downloads ou de outra pasta que o T3 Code recusa como projeto: copiadas inteiras
  para o projeto em que trabalharam (ou para um projeto **Geral**), depois de um sim no `t3sm start`. O trabalho que
  continuares mais tarde no original é trazido pelo `t3sm sync`.

## O que não é

- Sessões cuja pasta já não existe (`cwd-missing`), sessões com id que não é UUID ou só com registos escondidos,
  ficheiros escritos nos últimos 10 minutos (vêm na execução seguinte), cópias em pastas `.bak` e cópias-espelho de
  uma sessão guardada noutra conta. O `plan.md` lista cada uma com a razão.
- Sessões começadas no T3 Code: já lá estão, e o t3sm nunca as volta a importar. Uma cuja thread apagaste no T3 Code
  volta como cópia depois de um sim no `t3sm start` (`organize.sessions.orphaned`).
- Até responderes às perguntas do `t3sm start`: as sessões em pastas temporárias e do sistema e as sessões automáticas
  (Agent SDK), que por omissão ficam de fora.
- A atividade de ferramentas (comandos, ficheiros editados) na timeline: o T3 Code importa o texto da conversa. Só se
  veem as últimas 200 mensagens visíveis; a retoma usa tudo.

## Comandos

```bash
t3sm doctor
t3sm plan                         # lê o plan.md indicado
t3sm quarantine --dry-run         # se o doctor mostrar pastas de backup
t3sm apply --dry-run              # o que o apply faria; não escreve nada
t3sm apply --only C:/work/demo    # piloto opcional num só projeto
t3sm apply
```

## Confirmar

No T3 Code, abre um projeto do plano: as sessões são threads. Envia uma mensagem numa delas; continua a sessão com o
contexto completo. Um novo `t3sm plan` mostra-as como `already-in-t3`.

O `claude --resume` numa pasta de projeto também lista as cópias que o t3sm lá fez, e retoma-as.

Se a barra lateral parecer vazia porque tudo está em **Settled**, o `t3sm organize --dry-run` mostra como trazer as
conversas de volta para os seus projetos ([README](../../README.pt.md#organizar-o-histórico)).

## Desfazer

`t3sm runs` e depois `t3sm rollback --run <id>`. As tuas transcrições nunca foram editadas; o rollback repõe as contas
por omissão dos projetos e devolve as pastas da quarentena. As threads importadas são listadas; arquiva-as com
`--archive-threads` ou apaga-as no T3 Code.
