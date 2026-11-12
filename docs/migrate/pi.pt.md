# A partir do Pi

[English](pi.md) · Estado: 🟡 verificado com fixtures ([harnesses.md](../harnesses.md#pi-native))

Abaixo, `t3sm` é `npx -y github:brunobola-portfolio/t3code-session-manager#v0.1.0`, ou o comando instalado.

## O que é importado

- As sessões do Pi de `PI_CODING_AGENT_SESSION_DIR`, senão `<PI_CODING_AGENT_DIR>/sessions`, senão
  `~/.pi/agent/sessions`, seja qual for a idade, para a instância Pi do T3 Code, pelo próprio importador de Pi do T3
  Code.
- A descoberta foi verificada em ficheiros reais e todos os casos estão cobertos por fixtures sintéticas. **Não** foi
  feita uma importação real: o T3 Code usado nos testes não tinha instância Pi.

## O que não é

- Nada, enquanto o T3 Code não tiver uma instância Pi ativa: as sessões ficam como `harness-unavailable` e o `doctor`
  avisa em `harness:pi`. Ativa o Pi nas definições do T3 Code, nos fornecedores (vê a
  [documentação do T3 Code](https://github.com/pingdotgg/t3code/tree/main/docs/user)), e planeia outra vez.
- Sessões sem pasta de trabalho ou só com registos escondidos.

## Comandos

```bash
t3sm doctor        # harness:pi: "sessions found", sem o aviso de instância em falta
t3sm plan
t3sm apply --dry-run   # o que o apply faria; não escreve nada
t3sm apply
```

## Confirmar

O `plan.md` conta as sessões Pi no harness `pi`; depois do `apply` são threads dos respetivos projetos no T3 Code.

## Desfazer

`t3sm rollback --run <id>` lista as threads importadas (`--archive-threads` arquiva-as). Os ficheiros do Pi nunca são
escritos.
