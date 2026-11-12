# A partir do OpenCode

[English](opencode.md) · Estado: ✅ verificado ao vivo com o OpenCode 1.19.5 ([harnesses.md](../harnesses.md#opencode-convert-mode))

O T3 Code não lê as sessões do OpenCode, por isso o t3sm **converte-as** em sessões do Claude Code e é essas que o T3
Code importa. Uma sessão convertida continua no Claude (no T3 Code ou com `claude --resume <id>`), não no OpenCode.
Abaixo, `t3sm` é `npx -y github:brunobola-portfolio/t3code-session-manager#v0.1.0`, ou o comando instalado.

## O que é importado

- Todas as sessões do OpenCode com pelo menos uma mensagem, de `$XDG_DATA_HOME/opencode/opencode.db` (por omissão
  `~/.local/share/opencode/opencode.db`, também no Windows).
- O texto da conversa. Cada chamada de ferramenta passa a uma linha, `[tool <nome>] <entrada> → <saída>` (cortada aos
  500 caracteres); os anexos passam a `[attachment: <nome>]`.
- Cada sessão vai para a conta do seu projeto (as regras de conta por projeto em [accounts.md](../accounts.md)), como
  `<pasta da conta>/projects/<pasta codificada>/<uuid>.jsonl`.

## O que não é

- Raciocínio, marcadores de passo, patches e snapshots; o conteúdo dos ficheiros anexados.
- Sessões de sub-agentes, sessões sem pasta ou sem uma mensagem real do utilizador, e sessões atualizadas nos últimos
  10 minutos (execução seguinte).
- A base de dados do OpenCode nunca é aberta: o t3sm copia-a, guarda só as tabelas da conversa numa cópia privada em
  `~/.t3code-session-manager/cache/opencode/` (sem tokens de conta nem credenciais) e lê essa cópia.

## Comandos

```bash
t3sm doctor        # harness:opencode: "sessions found; opencode <versão>"
t3sm plan          # o resumo conta-as em "Convert + import"
t3sm apply --dry-run   # o que o apply faria; não escreve nada
t3sm apply
```

## Confirmar

No T3 Code, as sessões são threads Claude nos respetivos projetos, com o título da primeira mensagem. Num terminal, na
pasta do projeto, `claude --resume` também as lista.

## Desfazer

`t3sm rollback --run <id>` apaga os ficheiros convertidos que não mudaram desde então (um que tenhas continuado fica e
é listado) e lista as threads importadas. Os dados do OpenCode nunca foram tocados. Podes apagar
`~/.t3code-session-manager/cache/opencode/` quando quiseres; é recriada quando for precisa.
