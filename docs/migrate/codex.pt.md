# A partir do Codex CLI

[English](codex.md) · Estado: 🟡 verificado com fixtures ([harnesses.md](../harnesses.md#codex-cli-native))

`t3sm` é o comando que instalas uma vez ([install.md](../install.md), em inglês); o `t3sm update` mantém-no atualizado.

## O que é importado

- As sessões do Codex guardadas como `$CODEX_HOME/sessions/<ano>/<mês>/<dia>/rollout-*.jsonl` (por omissão
  `~/.codex`), seja qual for a idade, para a instância Codex do T3 Code, pelo próprio importador de Codex do T3 Code.
  Retomam-se no Codex a partir do T3 Code.
- A descoberta foi verificada em ficheiros reais e todos os casos estão cobertos por fixtures sintéticas. Ainda **não**
  foi feita uma importação real de uma sessão Codex não comprimida através do t3sm: se experimentares, conta-nos o que
  viste.
- **Sessões comprimidas** (`rollout-*.jsonl.zst`): o Codex CLI 0.167 e posteriores comprimem as sessões mais antigas,
  e o T3 Code só lê `rollout-*.jsonl`. O t3sm lê cada ficheiro comprimido (descomprime-o em memória; os ficheiros do
  Codex nunca são alterados), converte a conversa num transcript do Claude Code na conta do respetivo projeto e
  importa-a como uma **thread do Claude**: responder-lhe continua a conversa no Claude Code, na conta do projeto, com a
  conversa do Codex como histórico; a sessão do Codex fica como está. Fica: as mensagens do utilizador e do
  assistente que o T3 Code mostraria, e as chamadas a ferramentas como resumos de uma linha (`[tool shell] ls -la → …`);
  o raciocínio fica de fora. Verificado com fixtures, descoberta só em leitura de ficheiros comprimidos reais e uma
  sessão comprimida sintética convertida e importada ao vivo. Para as deixar de fora, põe
  `"codex": { "convertCompressed": false }` no `config.json` ([configuration.md](../configuration.md)).
- **Uma sessão, uma thread:** uma sessão que já está no T3 Code como thread do Codex (importada antes de o Codex a
  comprimir, ou iniciada no T3 Code) continua a ser essa thread; nunca é convertida numa segunda thread do Claude. O
  `plan.md` lista-a como "already in T3 Code as a Codex thread".

## O que não é

- Sessões comprimidas com mais de 512 MiB depois de descomprimidas, ou com uma linha de mais de 64 MiB (`too-large`),
  e ficheiros comprimidos que não se conseguem ler por completo (corrompidos ou cortados; o `scan` conta-os como erros
  de leitura).
- Um segundo ficheiro de rollout da mesma sessão (uma cópia simples e uma comprimida, ou um ficheiro `<id>_<filho>`
  que o Codex escreve por exemplo para um sub-agente): um ficheiro é importado, os outros aparecem no plano como
  `duplicate`.
- Rollouts de sub-agentes, rollouts sem id de sessão, sem pasta de trabalho ou só com registos escondidos.
- Sessões não comprimidas, enquanto o T3 Code não tiver uma instância Codex ativa: ficam como `harness-unavailable` e
  o `doctor` avisa. Ativa primeiro o Codex nas definições do T3 Code (Providers). As sessões convertidas (comprimidas)
  não precisam dela.

## Comandos

```bash
t3sm doctor        # harness:codex
t3sm scan          # sessões por agente; as do Codex aparecem na linha codex
t3sm plan
t3sm apply --dry-run   # o que o apply faria; não escreve nada
t3sm apply
```

## Confirmar

O `plan.md` conta as sessões Codex no harness `codex` e diz quantas comprimidas converte; depois do `apply`, são
threads dos respetivos projetos no T3 Code: as não comprimidas na instância Codex, as convertidas na conta Claude do
projeto. O `doctor` mostra, por exemplo, `codex-cli 0.167.1 · 4 importable natively, 107 convertible (compressed),
1 skipped`.

## Desfazer

`t3sm rollback --run <id>` lista as threads importadas (arquiva-as com `--archive-threads`) e apaga os transcripts do
Claude que escreveu para as sessões convertidas enquanto não tiverem sido alterados. Os ficheiros do Codex nunca são
escritos: o t3sm só muda a data dos não comprimidos durante uma vaga e repõe-na.
