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

## O que não é

- Sessões cuja pasta já não existe (`cwd-missing`), sessões com id que não é UUID ou só com registos escondidos,
  ficheiros escritos nos últimos 10 minutos (vêm na execução seguinte), cópias em pastas `.bak` e cópias-espelho de
  uma sessão guardada noutra conta. O `plan.md` lista cada uma com a razão.
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

## Desfazer

`t3sm runs` e depois `t3sm rollback --run <id>`. As tuas transcrições nunca foram editadas; o rollback repõe as contas
por omissão dos projetos e devolve as pastas da quarentena. As threads importadas são listadas; arquiva-as com
`--archive-threads` ou apaga-as no T3 Code.
