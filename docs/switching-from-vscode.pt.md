# Mudar do VS Code para o T3 Code

[English](switching-from-vscode.md)

Um guia passo a passo para a configuração mais comum: várias janelas de VS Code, cada uma com a extensão do Claude
Code, e duas contas Claude, por exemplo uma pessoal em `~/.claude` e uma de trabalho em `~/.claude-work` (aberta com
um alias como `claude-work`, ou fixada por projeto em `.vscode/settings.json`). No fim, cada sessão antiga é uma
thread no T3 Code, cada projeto abre com a conta certa e as novas sessões do terminal continuam a chegar.

Conta com cerca de meia hora, quase toda a ler. Instala o comando `t3sm` uma vez (a mesma linha em qualquer sistema;
as alternativas estão no [install.md](install.md), em inglês):

```bash
npm install -g --install-links github:brunobola-portfolio/t3code-session-manager#v0.2.0
```

Preferes ser guiado? O `t3sm start --lang pt` faz estes mesmos passos por ti, uma pergunta de cada vez, e pergunta
antes de qualquer escrita. Esta página é o mesmo caminho à mão, com todas as verificações. Para mudar mais tarde a
conta de um projeto: `t3sm projects set "<pasta>" <conta>`.

## 1. Abre o T3 Code da forma certa

Fecha o T3 Code se estiver aberto e volta a abri-lo pelo **menu Iniciar** (macOS: Dock ou Launchpad; Linux: o lançador
do ambiente de trabalho). Não o abras a partir de um terminal onde o alias `claude-work` ou `CLAUDE_CONFIG_DIR`
estejam ativos: o T3 Code passaria a ler a pasta de trabalho como conta por omissão.

## 2. Verifica

```bash
t3sm doctor
```

Resolve primeiro todos os `fail`; cada linha diz como ([troubleshooting.md](troubleshooting.md), em inglês). É normal
haver avisos como `backups-present` (tratado no passo 5) ou `harness:pi`, quando tens sessões do Pi mas nenhuma
instância Pi no T3 Code.

## 3. Confirma as contas

```bash
t3sm accounts
```

As duas pastas devem aparecer, com o sítio onde cada uma foi encontrada (pasta, alias, pin do VS Code) e, quando as
instâncias já existirem, o email com sessão iniciada em cada uma (mascarado; acrescenta `--show-emails` para o ver por
inteiro). No T3 Code, uma *instância* é uma entrada de fornecedor nas definições; cada conta tem a sua, criada pelo
`apply` (ou pelo `t3sm accounts --apply`) depois de confirmares. Se faltar uma, vê
[accounts.md](accounts.md#how-accounts-are-found). Para lhes dar nomes claros no seletor do T3 Code:

```bash
t3sm accounts --init      # escreve ~/.t3code-session-manager/config.json
```

Edita aí `displayName` e `accentColor`, ou usa `t3sm accounts --rename` depois de as instâncias existirem.

## 4. Planeia e revê

```bash
t3sm plan
```

Abre o `plan.md` indicado. Lê três coisas:

- **Project accounts**: cada projeto, a conta com que vai abrir e porquê (`route`, `vscode-pin`, `recent-activity`,
  `default`). Se um projeto estiver errado, acrescenta uma entrada em `routes` no `config.json`
  ([configuration.md](configuration.md#send-one-project-to-another-account)) e corre `t3sm plan` outra vez.
- **Warnings**: cópias-espelho, pastas de backup, ficheiros grandes, sessões continuadas fora do T3 Code.
- **Skipped by reason**: `cwd-missing` quer dizer que a pasta do projeto já não existe; `active` quer dizer que a
  sessão foi escrita nos últimos 10 minutos (fecha-a e planeia mais tarde).

## 5. Arruma as cópias

Se alguma vez copiaste sessões de uma conta para a outra, o plano lista **cópias-espelho** (mirror copies); se fizeste
backups dentro de `projects/`, o doctor mostrou **pastas de backup**. Põe-nas de parte, de forma reversível:

```bash
t3sm dedupe --dry-run
t3sm dedupe
t3sm quarantine --dry-run
t3sm quarantine
```

Depois, `t3sm plan` outra vez.

## 6. Ensaio, depois experimenta com um projeto

Vê exatamente o que o `apply` faria, sem escrever nada:

```bash
t3sm apply --dry-run
```

Depois escolhe um projeto pequeno do plano e importa só esse:

```bash
t3sm apply --only C:/work/demo
```

Mostra o resumo e pede `yes`. Se a instância Claude do próprio T3 Code não tiver uma pasta definida nas definições,
o resumo diz também `Pin claudeAgent to …/.claude`: o primeiro `apply` fixa-a, para que um T3 Code aberto a partir de
uma shell com `CLAUDE_CONFIG_DIR` não a possa mudar. No T3 Code, abre o projeto: as sessões antigas são threads. Abre
uma e envia uma mensagem curta; ela continua a sessão original (essa mensagem é um turno real na subscrição dessa
conta). Começa uma thread nova: o compositor já deve mostrar a conta do projeto.

## 7. Importa tudo

Antes de começar: mantém a máquina acordada até terminar, fecha as sessões dos projetos que queres importar e pausa o
OneDrive (ou qualquer sincronização na nuvem da tua pasta pessoal) até acabar.

```bash
t3sm apply
```

Um histórico grande leva várias vagas. Podes parar com Ctrl+C a qualquer momento; as datas dos ficheiros são repostas
e o próximo `t3sm apply` continua. Se a máquina suspender mesmo assim, o lote que estava a correr para quando ela
acorda (datas repostas) e a execução seguinte retoma-o. Podes continuar a trabalhar entretanto: um projeto com uma
sessão escrita nos últimos 10 minutos fica retido e é importado numa execução seguinte. Ainda não foi cronometrada nenhuma execução
completa; cada vaga tem no máximo 5 projetos e 50 sessões por projeto.

## 8. Mantém tudo sincronizado

Só depois de o passo 7 ter importado tudo (o `sync` não importa nada enquanto houver mais de 200 sessões pendentes):

```bash
t3sm schedule install --watch
```

Fica um vigilante a correr desde o início de sessão, que importa as sessões novas pouco depois de pararem. Preferes um
temporizador simples? Usa `t3sm schedule install` (a cada 15 minutos). `t3sm schedule status` mostra o que está
instalado.

## No dia a dia

- **Escolhe a conta** no compositor do T3 Code, por thread. As threads novas de um projeto começam na conta por omissão
  desse projeto.
- **Cada sessão num só sítio.** Nunca tenhas a mesma sessão aberta ao mesmo tempo no T3 Code e num terminal ou no VS
  Code: dois escritores criam ramos.
- **O trabalho do terminal volta com merge.** Se continuares uma sessão importada com `claude --resume`, o T3 Code não
  vê esses turnos. O `t3sm doctor` (`merge-pending`) e o `sync` avisam; `t3sm merge` lista-as e `t3sm merge --all`
  trá-las como threads novas, arquivando as antigas.
- **Para que guardar o VS Code:** tudo o que o T3 Code não faz por ti, como o próprio editor. As sessões que começas no
  VS Code são sessões normais do Claude Code, por isso a sincronização também as traz para o T3 Code quando ficam
  paradas.

## Voltar atrás

Nada disto te prende. As tuas transcrições ficam onde estavam e continuam a funcionar no VS Code e com
`claude --resume`. Para desfazer o que o t3sm mudou, vê `t3sm runs` e `t3sm rollback --run <id>` (indica sempre a
execução; devolve as cópias da quarentena e repõe as contas por omissão dos projetos; as threads importadas ficam para
as arquivares ou apagares no T3 Code) e depois `t3sm schedule remove`.
