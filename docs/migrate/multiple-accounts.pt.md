# Várias contas Claude

[English](multiple-accounts.md) · Estado: ✅ verificado ao vivo com duas contas ([accounts.md](../accounts.md))

Para quando usas duas ou mais subscrições Claude na mesma máquina, cada uma na sua pasta de configuração: por exemplo
`~/.claude` (pessoal) e `~/.claude-work` (trabalho), com um alias ou função que define `CLAUDE_CONFIG_DIR`, ou com
projetos do VS Code fixados numa delas. Abaixo, `t3sm` é
`npx -y github:brunobola-portfolio/t3code-session-manager#v0.1.0`, ou o comando instalado.

## O que ganhas

- Uma instância do T3 Code por conta, com nome e cor próprios no seletor de modelo. A instância por omissão do T3 Code
  fica em `~/.claude`; o t3sm fixa-a aí para que um `CLAUDE_CONFIG_DIR` perdido não a desvie.
- Cada sessão importada para a conta com que foi corrida. Uma sessão que existe nas duas contas é comparada: cópias
  idênticas ou mais antigas dão uma thread, ramos reais dão duas.
- Uma conta por omissão por projeto (route, pin do VS Code, sessão mais recente, `defaultAccount`), para as threads
  novas abrirem na subscrição certa.

## O que não faz

- Mudar uma thread de conta: uma thread fica na conta com que a sessão foi corrida. Começa uma thread nova e escolhe a
  outra conta no compositor.
- Iniciar sessão em nada. Cada pasta mantém o seu login; `t3sm accounts` mostra o email de cada instância
  (mascarado; `--show-emails` mostra-o por inteiro) e avisa quando duas partilham o mesmo.

## Comandos

```bash
t3sm accounts                   # o que foi encontrado, onde, e que instâncias existem
t3sm accounts --init            # escreve config.json; define lá displayName e accentColor
t3sm plan                       # revê a tabela Project accounts no plan.md
t3sm dedupe --dry-run           # se o plano listar cópias-espelho
t3sm dedupe
t3sm apply                      # cria as instâncias em falta e depois importa
t3sm accounts --rename claude-work "Claude · Work" --color "#6A42C9"
```

Para pôr um projeto na outra conta, acrescenta uma route em `~/.t3code-session-manager/config.json` e planeia outra
vez:

```json
"routes": [{ "match": "C:/work/clients/**", "account": "claude-work" }]
```

## Confirmar

`t3sm doctor`: `instances` diz que cada conta tem a sua instância, `instance-accounts` mostra um email diferente por
instância, `instance-home-drift` diz `claudeAgent reads ~/.claude` e `instance-unpinned` diz que tem uma pasta explícita
(o primeiro `apply` define-a). No T3 Code o seletor mostra as duas contas, e uma
thread nova num projeto de trabalho começa na conta de trabalho.

## Desfazer

`t3sm rollback --run <id>` repõe as contas por omissão dos projetos e devolve as cópias tiradas pelo dedupe. As
instâncias criadas são listadas, não removidas (`--instances` repõe nomes, cores e pastas que tenha mudado); remove uma
instância nas definições do T3 Code se já não a quiseres.
