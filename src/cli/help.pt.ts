// O que `t3sm --help` e `t3sm <comando> --help` dizem, em português europeu: o gémeo de help.en.ts, com os mesmos
// comandos e a mesma forma (blocos separados por linhas em branco, "Uso:", títulos como "Opções:" seguidos de itens
// recolhidos dois espaços, comandos entre `acentos graves`). As opções são as mesmas do inglês: são os nomes que o
// t3sm aceita.

export const GLOBAL = `
Opções globais (todos os comandos):
  --lang en|pt   A língua do que o t3sm escreve. Por omissão: a variável
                 T3SM_LANG, depois "language" no config.json, depois a língua
                 do sistema, senão inglês. O --json, o plan.md e os registos
                 ficam sempre em inglês.
  --no-color     Sem cor (o NO_COLOR também é respeitado)
`;

export const USAGE = `O t3sm traz as tuas sessões do Claude Code, do Codex, do Pi e do OpenCode para o T3 Code.

Uso: t3sm [comando] [opções]

Começar aqui
  t3sm start             Configuração guiada, passo a passo (também só \`t3sm\`; \`--lang en\` em inglês)

Importar
  t3sm doctor            Verifica esta máquina, o T3 Code e as contas (só leitura)
  t3sm plan              Prepara o plano de importação em plan.md (não muda nenhuma sessão)
  t3sm apply             Importa as sessões do plano (--dry-run, --only "<pasta>")

Contas e projetos
  t3sm accounts          As tuas subscrições do Claude e as instâncias delas no T3 Code
  t3sm projects          A conta que cada projeto usa (set "<pasta>" <conta>, rename --suggest)

Manter sincronizado
  t3sm status            O t3sm precisa de ti? Tudo bem, precisa de ti ou a trabalhar (só leitura; saída 10: precisa de ti)
  t3sm sync              Importa o que é novo desde a última vez (--watch continua a vigiar)
  t3sm schedule          Sincroniza em segundo plano: install [--watch], remove, restart, status
  t3sm merge             Traz para o T3 Code as sessões continuadas num terminal

Arrumar o T3 Code
  t3sm organize          Arruma o histórico importado: arquiva, muda títulos, mostra, fixa (--undo)

Limpar e desfazer
  t3sm quarantine        Move as pastas de cópia de segurança para uma quarentena reversível
  t3sm dedupe            Move as cópias-espelho do plano para uma quarentena reversível
  t3sm runs              Lista o que cada execução fez
  t3sm rollback          Desfaz uma execução (--run <id>)

Ajuda e manutenção
  t3sm help              O que uma mensagem quer dizer e o que fazer (t3sm help <tópico>)
  t3sm scan              Conta as sessões por agente e por conta (não precisa do T3 Code)
  t3sm update            Atualiza o t3sm para a versão mais recente (--check só vê)
  t3sm changelog         O que há de novo nesta versão (--since <versão>)
  t3sm --version         Mostra a versão

Cada comando explica-se a si próprio: \`t3sm <comando> --help\`. Os comandos que escrevem perguntam primeiro; o
--dry-run mostra o que fariam.
`;

export const COMMANDS: Record<string, string> = {
  doctor: `Uso: t3sm doctor [--json] [--repair]

Verifica tudo aquilo de que o t3sm depende e diz o que corrigir: o Node, a pasta de estado, o config.json, o bloqueio,
execuções interrompidas, o CLAUDE_CONFIG_DIR da shell, o T3 Code (a correr, versão, CLI, uma sessão só de leitura),
as instâncias do Claude e a conta com que cada uma tem sessão iniciada (emails mascarados), contas encontradas nesta
máquina que faltam no config.json, pastas de cópia de segurança e de quarentena, os agentes (Claude Code, Codex, Pi,
OpenCode), os comandos /t3sm e a sincronização em segundo plano. Só leitura: abre uma sessão só de leitura no T3 Code
e revoga-a antes de sair. Sai com 1 quando uma verificação falha.

Opções:
  --json     Escreve as verificações em JSON (sempre em inglês)
  --repair   Repõe as datas dos ficheiros de conversa deixadas adiantadas por
             uma execução interrompida (fica com o bloqueio; é a única coisa
             que o doctor alguma vez escreve)
`,
  accounts: `Uso: t3sm accounts [--show-emails] [--allow-untested]
     t3sm accounts --init [--force]
     t3sm accounts --apply [--yes] [--allow-untested]
     t3sm accounts --rename <id> "<Nome a mostrar>" [--color "#RRGGBB"]

Sem opções: uma tabela, só de leitura, das contas do config.json ao lado das instâncias do T3 Code (o email com
sessão iniciada, mascarado como b***@example.com; sessão, disponibilidade, onde cada conta foi encontrada), com um
aviso para emails partilhados, contas sem instância, instâncias com a sessão terminada e contas encontradas nesta
máquina que faltam no config.json.

As contas são procuradas em ~/.claude, nas pastas ~/.claude-*, no CLAUDE_CONFIG_DIR dos perfis da shell (PowerShell,
bash, zsh, fish; o nome do alias ou da função passa a ser o id da conta), nas fixações de .vscode/settings.json, na
shell atual e nas pastas das instâncias que já existem no T3. Uma pasta só conta quando tem projects/.

Opções:
  --init         Escreve o config.json com todas as contas encontradas (nunca emails)
  --force        Com --init, substitui um config.json que já exista
  --apply        Cria as instâncias que faltam e fixa o claudeAgent em ~/.claude
  --yes          Não pergunta (obrigatório quando não há terminal)
  --rename       Muda o nome (e a cor) de uma instância no seletor do T3 Code,
                 e faz o mesmo no config.json
  --color        Com --rename: a cor da instância, como #RRGGBB
  --show-emails  Mostra os emails completos na tabela (mascarados por omissão)
  --allow-untested  Sem aviso numa versão do T3 Code que o t3sm não testou (nunca bloqueia)

Exemplos:
  t3sm accounts
  t3sm accounts --apply
  t3sm accounts --rename claude-work "Claude Trabalho" --color "#7C3AED"
`,
  apply: `Uso: t3sm apply [--plan <caminho>] [--yes | --dry-run] [--only <pasta>] [--quiet] [--verbose] [--allow-untested]

Importa as sessões de um plano para o T3 Code: cria as instâncias e os projetos que faltam, define a conta por omissão
de cada projeto e importa por vagas (as conversas antigas têm a data do ficheiro adiantada por um momento, registada
no diário, para que o próprio importador do T3 Code as aceite; todas as datas são repostas a seguir). O Ctrl+C repõe a
vaga em curso e para. Sai com 5 quando algumas sessões não puderam ser importadas: uma tabela diz porquê e o que
fazer, e \`t3sm help <tópico>\` explica cada motivo.

Opções:
  --plan <caminho>   O plano a aplicar (por omissão: o runs/*/plan.json mais recente)
  --yes              Não pergunta (obrigatório quando não há terminal)
  --dry-run          Faz todas as verificações (sessão só de leitura no T3
                     Code), mostra o resumo e o que faria, não escreve nada
  --only <pasta>     Aplica só as sessões da pasta deste projeto
  --quiet            Sem progresso (e nada quando outra execução tem o bloqueio)
  --verbose          Mostra também uma linha por vaga de importação (a barra de
                     progresso continua)
  --allow-untested   Sem aviso numa versão do T3 Code que o t3sm não testou (nunca bloqueia)

O T3 Code importa de uma vez todas as conversas recentes de um projeto, de todas as contas. Por isso, enquanto um
projeto é importado, as outras conversas recentes dele (cópias-espelho e de segurança, excluídas, vagas seguintes)
ficam estacionadas: a data do ficheiro passa para 7 dias no futuro, o que o T3 Code ignora, e volta logo a seguir (um
crash é reparado pela execução seguinte do t3sm). Um projeto com uma sessão em uso agora espera pela execução
seguinte (\`t3sm help held\`). As cópias-espelho dentro da janela são indicadas: corre \`t3sm dedupe\` para que a
importação de boas-vindas do T3 Code também não as apanhe.

Um plano com mais de 24 h, ou feito para outra versão do T3 Code, é recusado: corre \`t3sm plan\` outra vez.

Exemplos:
  t3sm apply --dry-run
  t3sm apply --only "~/code/app"
  t3sm apply
`,
  quarantine: `Uso: t3sm quarantine [--yes | --dry-run]

Move as pastas de cópia de segurança dentro da pasta projects/ de cada conta (\`.bak-*\`, \`<pasta>.bak\`,
\`<pasta>.bak-AAAAMMDD-HHMMSS\`) para <pasta da conta>/session-manager-quarantine/backups/. Nada é apagado: cada
movimento é uma mudança de nome no mesmo disco (as datas ficam), fica no diário e é desfeito por \`t3sm rollback --run
<id>\`. Uma pasta com um ficheiro alterado nos últimos 10 minutos fica onde está.

Opções:
  --yes       Não pergunta (obrigatório quando não há terminal)
  --dry-run   Só lista o que seria movido
`,
  dedupe: `Uso: t3sm dedupe [--plan <caminho>] [--yes | --dry-run]

Move as cópias-espelho do plano (uma sessão copiada para uma segunda conta, igual à cópia que fica ou um início mais
antigo dela) para <pasta da conta>/session-manager-quarantine/mirror/<pasta do projeto>/, junto com a pasta que
acompanha a sessão. Cada cópia é comparada outra vez mesmo antes de ser movida; ramificações, ficheiros em uso e
cópias cuja cópia guardada já não existe ficam onde estão. Desfaz-se com \`t3sm rollback --run <id>\`.

Opções:
  --plan <caminho>   O plano a usar (por omissão: o runs/*/plan.json mais recente; com mais de 24 h é recusado)
  --yes              Não pergunta (obrigatório quando não há terminal)
  --dry-run          Só lista o que seria movido
`,
  merge: `Uso: t3sm merge [--session <id> | --all] [--yes | --dry-run] [--allow-untested]

Traz para o T3 Code o trabalho continuado num terminal (\`claude --resume\`). O T3 Code continua uma thread importada a
partir da última mensagem que conhece, por isso as mensagens escritas no terminal depois da importação não aparecem
lá. Uma junção:
  - cria um ficheiro de sessão novo ao lado do original (<id da revisão>.jsonl) com o ramo que o \`claude --resume\`
    continuaria; o ficheiro original nunca é editado;
  - importa-o para o T3 Code como uma thread nova e arquiva a thread antiga;
  - é reversível com \`t3sm rollback --run <id>\`.

Sem --session nem --all só lista as candidatas (projeto, sessão, última atividade no terminal, mensagens novas) e sai
com 0. Uma sessão só conta como continuada com uma prova: uma mensagem depois da importação escrita por outro ponto
de entrada que não o T3 Code. As sessões escritas nos últimos 10 minutos esperam; um projeto com outra sessão em uso
espera. Uma sessão compactada não é juntada (ainda não é suportado), nem uma com a cadeia de mensagens partida. O
trabalho de terminal num ramo lateral (não o que o \`claude --resume\` continua) é listado com a dica \`claude --resume
<id>\` e nunca é juntado.

Depois de uma junção: continua no T3 Code na thread nova, ou num terminal com \`claude --resume <id da revisão>\`
(escrito para cada junção). O id da sessão original continua a poder ser retomado no terminal, mas passa a ser um ramo
desatualizado, e o seletor do \`claude --resume\` mostra os dois. Nunca tenhas a mesma sessão aberta no T3 Code e num
terminal ao mesmo tempo. Desfaz-se com \`t3sm rollback --run <id>\`: uma revisão intacta é apagada e a thread antiga
desarquivada; uma revisão continuada entretanto fica (as duas threads ficam). O \`t3sm sync\` só indica as junções por
fazer, a menos que sync.autoMerge seja true no config (por omissão false): aí junta-as ele próprio.

Opções:
  --session <id>     Junta uma sessão (o id, ou um início único com 8 ou mais caracteres)
  --all              Junta todas as candidatas
  --yes              Não pergunta (obrigatório quando não há terminal)
  --dry-run          Só lista as candidatas
  --allow-untested   Sem aviso numa versão do T3 Code que o t3sm não testou (nunca bloqueia)

Exemplos:
  t3sm merge
  t3sm merge --session 1a2b3c4d
  t3sm merge --all
`,
  rollback: `Uso: t3sm rollback [--run <id>] [--yes | --dry-run] [--instances] [--archive-threads] [--allow-untested]

Desfaz uma execução. Sem --run mostra a execução mais recente que não seja ela própria um rollback (pode ser uma
sincronização automática) e pergunta; --yes precisa de --run <id>:
  - os ficheiros convertidos que escreveu são apagados, a menos que tenham sido editados entretanto (aí ficam e são
    listados);
  - o que pôs em quarentena volta ao lugar (um caminho original que voltou a existir fica na quarentena e é
    indicado);
  - as contas por omissão que definiu nos projetos são repostas (precisa do T3 Code a correr; senão a parte dos
    ficheiros corre na mesma e o resto é indicado);
  - uma junção (\`t3sm merge\`): a revisão é apagada, a thread antiga desarquivada e a thread da revisão arquivada;
    uma revisão continuada entretanto fica e as duas threads ficam como estão (indicado);
  - uma execução de organize (\`t3sm organize\`, \`t3sm projects rename --suggest\`): as alterações são revertidas onde
    o T3 Code ainda mostra o que o t3sm deixou, tal como \`t3sm organize --undo <run>\`; o que mudaste depois fica.
As threads importadas e as instâncias e projetos criados são listados, nunca apagados. Corrê-lo duas vezes não muda
nada na segunda.

Opções:
  --run <id>          A execução a desfazer (ver \`t3sm runs\`)
  --yes               Não pergunta (precisa de --run; obrigatório quando não há terminal)
  --dry-run           Só lista o que seria desfeito
  --instances         Repõe também os nomes, cores e pastas das instâncias que a execução mudou
  --archive-threads   Arquiva (não apaga) as threads que a execução importou
  --allow-untested    Sem aviso numa versão do T3 Code que o t3sm não testou (nunca bloqueia)

Exemplos:
  t3sm runs
  t3sm rollback --run 20261114-120000-abcd --dry-run
  t3sm rollback --run 20261114-120000-abcd --yes
`,
  sync: `Uso: t3sm sync [--quiet] [--verbose] [--allow-untested]
     t3sm sync --watch [--quiet] [--allow-untested]
     t3sm sync --dry-run [--allow-untested]

Um ciclo sem supervisão: prepara um plano novo e aplica-o sem perguntar. Foi feito para correr a partir de um
agendador, por isso é cauteloso:
  - nunca cria instâncias no T3 (as sessões de uma conta que falta esperam por \`t3sm accounts --apply\`), nunca põe
    em quarentena nem tira duplicados;
  - as sessões continuadas num terminal depois de o t3sm as importar são indicadas (corre \`t3sm merge\`); com
    sync.autoMerge true (por omissão false) junta-as ele próprio quando estão paradas há 10 min, no máximo 20 por
    ciclo;
  - uma sessão com uma cópia-espelho dentro da janela de 30 dias do T3 Code espera por \`t3sm dedupe\` (a cópia fica
    estacionada enquanto o projeto importa);
  - um projeto com uma sessão em uso agora espera pelo ciclo seguinte;
  - uma sessão cuja importação falhou (e que não mudou desde então) espera por \`t3sm apply\`;
  - mais de sync.maxUnattendedImports (por omissão 200) por importar: nada é importado, uma linha diz para correr
    \`t3sm apply\` uma vez (mesmo com --quiet);
  - uma conta por omissão que escolheste no T3 Code nunca é substituída;
  - nada para importar quer dizer nada escrito (nem entrada no diário, nem pasta de execução).
Sai com 3 quando o T3 Code não está a correr (em silêncio com --quiet), com 0 quando outra execução do t3sm tem o
bloqueio, com 4 para um T3 Code incompatível, com 2 quando a instância do Claude por omissão do T3 Code lê outra pasta.
Cada ciclo acrescenta uma linha (só contagens e ids de execução) a <estado>/logs/sync.log (rodado a 1 MiB, ficam 3).

Opções:
  --quiet            Nada no ecrã a não ser um erro numa linha (saída 2/4/1/5)
  --watch            Fica a correr: vigia as pastas das conversas, corre um
                     ciclo quando as mudanças acalmam e outra vez quando uma
                     sessão alterada fica parada 10 min, e ainda a cada
                     schedule.everyMinutes; espera enquanto o T3 Code está
                     fechado. Escreve <estado>/sync-status.json. O Ctrl+C para
                     depois do ciclo em curso. Um segundo vigilante sai com 0.
  --dry-run          Só mostra o que um ciclo importaria (não escreve nada, nem
                     a cache de descoberta)
  --verbose          Mostra também uma linha por vaga de importação (sem efeito
                     com --quiet ou --watch, que nunca desenham progresso)
  --allow-untested   Sem aviso numa versão do T3 Code que o t3sm não testou (nunca bloqueia)

Exemplos:
  t3sm sync --dry-run
  t3sm sync
  t3sm schedule install --watch
`,
  schedule: `Uso: t3sm schedule install [--watch] [--yes | --dry-run]
     t3sm schedule remove [--yes | --dry-run]
     t3sm schedule restart [--yes | --dry-run]
     t3sm schedule status

Regista \`t3sm sync --quiet\` no agendador do sistema, como o utilizador atual, sem elevação: o Agendador de Tarefas do
Windows (um XML da tarefa em <estado>/schedule/: a cada schedule.everyMinutes, só com a tua sessão iniciada, janela
escondida, nunca dois ao mesmo tempo), um LaunchAgent no macOS, ou uma linha do crontab marcada "# t3sm". Com --watch o
agendador arranca \`t3sm sync --watch --quiet\` quando inicias sessão, carregas ou reinicias, e o Windows e o cron
verificam a cada 15 min que continua a correr (um que já corre fica como está). O vigilante reinicia-se sozinho para
um t3sm mais recente depois do ciclo seguinte, quando há um instalado. Corre-o a partir da tua própria conta: numa
shell aberta como Administrador, o t3sm avisa que o agendamento fica instalado só para esse utilizador.

O install e o remove podem ser corridos as vezes que quiseres. O install --watch para primeiro um vigilante em
execução (pedido pelo próprio canal dele; um processo verificado só em último caso, nunca pelo nome), volta a criar a
entrada e arranca já o vigilante novo; o remove também o para e di-lo (sai com 1 e o pid se ainda estiver a correr); o
restart para e arranca o vigilante agendado sem reinstalar (sai com 2 quando nada está instalado). O status mostra a
entrada do agendador, o comando que corre (e se os caminhos dele ainda existem), o sinal de vida do vigilante e o
último ciclo registado.

Opções:
  --watch     Com install: um vigilante sempre a correr desde o início de sessão, em vez de um ciclo de poucos em poucos minutos
  --yes       Não pergunta (obrigatório quando não há terminal)
  --dry-run   Mostra o que aconteceria; não muda nada

Exemplos:
  t3sm schedule install --watch --dry-run
  t3sm schedule install --watch
  t3sm schedule status
`,
  start: `Uso: t3sm start [--lang en|pt] [--no-color]

Uma configuração guiada para quem prefere não aprender os comandos. Em passos curtos, corre por ti os comandos do
próprio t3sm: verificação (doctor), contas, o plano e a tabela de projetos e contas, limpeza (quarantine, dedupe), uma
importação de experiência de um projeto, a importação completa, a sincronização em segundo plano e um resumo com os
ids das execuções e como as desfazer. Antes de cada escrita pergunta, e só s avança (Enter quer dizer não). Em
qualquer pergunta: ? explica mais, b volta atrás, q para; nada fica a meio. Corre-o outra vez para continuar: descobre
onde estavas a partir do estado do próprio t3sm (diário, plano, config, agendador).

O \`t3sm\` sozinho num terminal também o arranca. Sem terminal, escreve o início rápido e sai com 0.

Opções:
  --lang en|pt   A língua (ver as opções globais abaixo); o start oferece-se
                 para a guardar como "language" no config.json
`,
  projects: `Uso: t3sm projects [--json] [--allow-untested]
     t3sm projects set "<pasta>" <conta> [--yes | --dry-run] [--force] [--allow-untested]
     t3sm projects unset "<pasta>" [--dry-run]
     t3sm projects rename --suggest [--yes | --dry-run] [--allow-untested]

Sem subcomando: uma tabela, só de leitura, de todas as pastas de projeto que o t3sm conhece, com a conta em que as
threads novas começam, porquê (route: uma regra no config.json; vscode-pin: .vscode/settings.json; recent-activity: a
conta da sessão mais recente; default: defaultAccount), as sessões por importar, se o projeto já está no T3 Code (sim,
não, arquivado) e se uma sessão dele está em uso (uma importação espera por ela). Com o T3 Code fechado mostra o que
esta máquina sabe e di-lo.

t3sm projects set "<pasta>" <conta>
  Escreve no config.json uma regra para essa pasta exata (ou substitui a regra dela no mesmo sítio). Uma regra nova
  fica mesmo antes da primeira regra com asterisco que apanhe a pasta, por isso só ganha para essa pasta: a conta de
  nenhuma outra pasta muda. Quando a pasta já é um projeto do T3 Code e o T3 Code está a correr, também define lá a
  conta por omissão do projeto (fica no diário: \`t3sm rollback --run <id>\` desfaz). A regra decide onde começam as
  threads novas e para que conta vão as sessões do OpenCode e as do Codex comprimidas ainda por importar; as sessões
  do Claude Code ficam na conta em que foram gravadas, e as threads que já estão no T3 Code ficam com a sua. ~ é a
  tua pasta pessoal; uma regra cobre essa pasta exata, não as subpastas. Pergunta primeiro.

t3sm projects unset "<pasta>"
  Remove a regra dessa pasta (as regras com asterisco ficam). O T3 Code não muda.

t3sm projects rename --suggest
  Nomes limpos para os projetos que o t3sm criou e cujo título ainda é o que o t3sm lhes deu (um projeto a que mudaste
  o nome nunca é tocado): o nome da pasta, \`pai/nome\` para pastas genéricas como src ou app, no máximo
  organize.names.maxLength caracteres (por omissão 40), com uma pasta pai acrescentada quando o nome já existe.
  Mostra cada título antes -> depois e pergunta. Cada mudança de nome fica no diário: \`t3sm organize --undo <run>\`
  repõe os títulos antigos.

Opções:
  --json             Escreve a tabela em JSON
  --yes              Não pergunta (obrigatório quando não há terminal)
  --dry-run          Só mostra a mudança; não escreve nada
  --force            Com set: aceita uma pasta que (ainda) não existe
  --suggest          Com rename: calcula os nomes limpos (o único modo)
  --allow-untested   Sem aviso numa versão do T3 Code que o t3sm não testou (nunca bloqueia)

Exemplos:
  t3sm projects
  t3sm projects set "~/code/app" claude-work --dry-run
  t3sm projects rename --suggest --dry-run
`,
  organize: `Uso: t3sm organize [--dry-run | --yes] [--only <pasta>] [--history <dias|all|off>] [--min <n>]
                    [--auto-settle <dias|off>] [--no-delete] [--no-pin <ids>] [--no-archive-folders]
                    [--allow-untested] [--plain]
     t3sm organize --undo [<run>] [--dry-run | --yes] [--allow-untested]

Arruma o histórico que o t3sm importou para o T3 Code. Primeiro mostra uma linha por tipo de alteração, com quantas,
porquê e como desfazer, depois os projetos com mais conversas à vista (agora -> depois), e pergunta antes de mudar
alguma coisa:
  - arquiva as conversas automáticas (começadas pelo Agent SDK) e as de um projeto que o t3sm criou numa pasta
    temporária ou do sistema;
  - títulos novos para as conversas cujo título é uma primeira mensagem técnica (<command-name>, <ide_...>, [external
    ...]): o título da própria conversa, o resumo ou a primeira mensagem a sério, no máximo 80 caracteres;
  - mantém arrumado o histórico de cada projeto (organize.history, por omissão os últimos 90 dias e pelo menos 10 por
    projeto): as conversas com atividade nesses dias ficam à vista dentro do projeto, as mais antigas passam para
    Settled (ficam no projeto, na prateleira Settled), e um projeto com menos conversas recentes continua a mostrar as
    mais recentes; a passagem automática para Settled do próprio T3 Code não muda a menos que passes --auto-settle
    (\`t3sm help history\`);
  - fixa os projetos com atividade mais recente (organize.pinRecent, por omissão 5) e desafixa os que o t3sm fixou e
    já não estão entre eles;
  - apaga os projetos vazios que o t3sm criou (sem conversa nenhuma).
As definições ficam em "organize" no config.json (organize.titles, organize.archiveAutomated, ...).

As conversas que começaste no T3 Code nunca são tocadas, nem os projetos que criaste (a não ser para fixar), as
definições do T3 Code (a menos que passes --auto-settle) ou a base de dados dele. O que mudares no T3 Code depois do
t3sm fica como deixaste: uma conversa que desarquivaste, a que mudaste o nome, passaste para Settled ou reabriste, ou um projeto
que desafixaste. Cada alteração fica no diário. Numa versão do T3 Code que o t3sm não testou, avisa uma vez e
continua.

Opções:
  --dry-run          Mostra o que mudaria; não escreve nada (nem a cache de
                     descoberta do t3sm)
  --yes              Não pergunta (obrigatório quando não há terminal)
  --only <pasta>     Só as conversas deste projeto do T3 Code (sem fixar, sem
                     apagar)
  --undo [<run>]     Reverte uma execução de organize. Sem id oferece a mais
                     recente ainda por desfazer e pergunta; com --yes o id é
                     obrigatório. Só volta atrás o que o T3 Code ainda mostra
                     como o t3sm deixou; um projeto apagado é recriado.
                     \`t3sm rollback --run <run>\` faz o mesmo.
  --history <dias|all|off>  A regra do histórico só para esta execução (o
                     config.json não muda): os últimos 1-3650 dias, tudo (all)
                     ou desligada (off)
  --min <n>          Mostra pelo menos n (0-1000) conversas por projeto, só
                     nesta execução (com os dias configurados)
  --auto-settle <dias|off>  Muda também a passagem automática para Settled do T3
                     Code, para as conversas começadas no T3 Code: depois de
                     1-90 dias (o T3 Code não aceita outra coisa), ou desligada
                     (fica registado; o --undo repõe o valor antigo)
  --no-delete        Deixa ficar os projetos vazios que o t3sm criou
  --no-pin <ids>     Nunca fixa estes projetos (ids de projeto do T3 Code, separados por vírgulas)
  --no-archive-folders  Não arquiva as conversas dos projetos que o t3sm criou
                     em pastas temporárias ou do sistema
  --allow-untested   Sem aviso numa versão do T3 Code que o t3sm não testou (nunca bloqueia)
  --plain            Só texto simples, nunca um ecrã interativo. Num terminal,
                     a pergunta oferece d = detalhes: as alterações numa lista
                     que revês com as setas; as que desmarcares não são
                     aplicadas

Exemplos:
  t3sm organize --dry-run
  t3sm organize
  t3sm organize --only "~/code/app" --yes
  t3sm organize --history 90 --min 10 --auto-settle 90 --dry-run
  t3sm organize --undo
  t3sm organize --undo 20261114-120000-abcd --dry-run
  t3sm organize --undo 20261114-120000-abcd --yes
`,
  update: `Uso: t3sm update [--from <pasta> | --source github] [--yes | --dry-run]
     t3sm update --check
     t3sm update --auto on|off [--dry-run]

Atualiza o t3sm para a versão mais recente da origem: as etiquetas vX.Y.Z do GitHub (o repositório do package.json),
ou as etiquetas no main de uma cópia do código neste computador. Primeiro mostra o que há de novo (uma pasta: o
CHANGELOG.md dessa etiqueta; GitHub: depois da instalação, a partir do CHANGELOG.md instalado) e depois pergunta. A
instalação é um \`npm install -g --install-links\` dessa etiqueta; o vigilante em segundo plano é parado (pelo próprio
controlo dele, nunca pelo nome) e volta a arrancar na versão nova, e se nenhum sinal de vida dele chegar em 2 minutos
a versão anterior é reinstalada. Cada atualização fica no diário. O t3sm nunca volta a uma versão anterior. Uma cópia
git ou a cache do npx só recebem instruções. Numa shell aberta como Administrador, o t3sm avisa que a atualização fica
instalada só para esse utilizador.

Uma vez por dia o vigilante também procura (update.auto, ligado por omissão): uma versão de correção ou menor mais
recente (incluindo as menores 0.x) é instalada sozinha, uma versão maior só é anunciada; uma atualização que falhou ou
voltou atrás aparece no \`t3sm status\` (\`t3sm help updates\`), e a procura automática salta uma versão desfeita (o
t3sm update ainda a pode instalar). Procurar as versões (git ls-remote, ou npm view) é a única ligação à rede do
próprio t3sm; instalar uma versão descarrega-a com o npm.

Opções:
  --check            Só vê: a versão instalada, a mais recente e o tipo dela
                     (nenhuma, correção, menor, maior), a origem, se as
                     atualizações automáticas estão ligadas, a última procura,
                     uma atualização interrompida e como voltar atrás. Só
                     leitura (sem bloqueio); sai com 0 mesmo sem rede
  --from <pasta>     Atualiza a partir desta cópia do código (um caminho local
                     absoluto como D:\\code\\t3sm; nunca uma pasta de rede);
                     fica lembrado para as próximas quando a versão nova entra
  --source github    Volta a atualizar a partir do GitHub (lembrado da mesma forma)
  --auto on|off      Liga ou desliga a atualização automática diária no
                     config.json (corre t3sm start primeiro se não houver um).
                     Uma preferência como o \`projects unset\`: não precisa de --yes
  --yes              Não pergunta (obrigatório quando não há terminal); a única
                     forma de uma versão maior ser instalada sem perguntar
  --dry-run          Mostra o que seria instalado; não muda nada
  --auto-run         Usado pelo vigilante com --yes (só correções ou menores);
                     não precisas dele

Exemplos:
  t3sm update --check
  t3sm update --dry-run
  t3sm update --auto off
`,
  changelog: `Uso: t3sm changelog [--since <versão>]

As notas de versão do t3sm instalado, a partir do próprio CHANGELOG.md (escrito em inglês): a secção desta versão,
ou com --since todas as versões mais recentes do que essa, da mais nova para a mais antiga. Só leitura.

Opções:
  --since <versão>   As notas das versões depois desta (como 0.2.1)
`,
  runs: `Uso: t3sm runs [--json]

Lista as execuções registadas no diário: id, hora de início, comando, estado e o que cada uma mudou. Só leitura.

Opções:
  --json   Escreve as execuções em JSON
`,
  status: `Uso: t3sm status [--json]

Diz se o t3sm precisa de ti. A primeira linha é um nível: "Tudo bem", "Precisa de ti (N)" ou "A trabalhar" (está a
correr uma execução do t3sm). Depois vêm os itens, primeiro o que precisa de ti, cada um com o comando que o resolve:
o vigilante em segundo plano (parado, numa versão antiga do t3sm, ou a falhar); uma atualização do t3sm que falhou
ou foi interrompida; conversas à espera da tua decisão; conversas que continuam a falhar na importação; cópias
continuadas duas vezes; cópias à espera de uma pasta; alterações que a última execução de organize não conseguiu
fazer. Bom saber (nunca uma necessidade): uma atualização recente, uma atualização desfeita (a versão anterior voltou
a correr: o t3sm recuperou sozinho), uma versão mais recente que não foi
instalada (uma versão maior só é anunciada: o t3sm nunca a instala sozinho), projetos à espera porque uma conversa
está em uso, conversas começadas no T3 Code que o t3sm deixa de fora. Depois a última e a próxima sincronização, a
última execução de organize e se o T3 Code está a correr. Estritamente só de leitura: sem bloqueio, sem escrever no
diário nem na cache, e nunca se liga ao T3 Code (só lê o ficheiro de execução do T3).

Sai com 0, ou com 10 quando alguma coisa precisa de ti (para um script ou uma notificação saberem); 10 não é um erro.
2 para um erro de uso.

Opções:
  --json   Escreve os mesmos dados num objeto JSON (sem cor; chaves em inglês):
             version            2
             ran                false (e mais nada) quando o t3sm ainda não correu
             level              "ok" | "needs-you" | "working"
             items              [{ level: "needs-you"|"info", key, text, command }] (command pode ser null)
             needsAttention     { reason, detail, command, since, facts } ou null (como o último ciclo o registou)
             waiting            [{ project, title, modifiedAt, since }] projetos à espera por uso
             heldRehome         cópias à espera de uma pasta de destino no T3 Code
             decisionsPending   { <pergunta>: sessões à espera }
             pendingImports     { count, source: "sync" | "plan", at } ou null
             lastSync           { at, outcome, runId } ou null
             nextSync           { at, source: "watcher" } ou null
             watcher            { running, pid, version, stale } ou null
             update             { installed, available, failure, lastInstalled }
             runInProgress      { pid, startedAt } ou null
             lastOrganize       { runId, at, changes, reverted, rolledBackBy } ou null
             plugin             [{ account, state: installed|outdated|missing, version }] (os comandos /t3sm)
             t3Code             { running, version }
`,
  scan: `Uso: t3sm scan [--json]

Conta as sessões desta máquina por agente e por conta. Não precisa do T3 Code a correr. Só escreve a cache de
descoberta do próprio t3sm (na pasta de estado); nunca um ficheiro de sessão.

Opções:
  --json    Escreve as sessões encontradas como uma lista JSON
`,
  plan: `Uso: t3sm plan [--json] [--allow-untested]

Liga-se ao T3 Code em execução (só leitura), encontra as sessões e escreve o plano de importação em
<estado>/runs/<runId>/plan.md e plan.json. Também atualiza a cache de descoberta do t3sm e, na primeira vez, guarda as
contas detetadas em <estado>/config.json. O T3 Code e os ficheiros das sessões não mudam.

Opções:
  --json             Escreve o plano em JSON em vez do resumo
  --allow-untested   Sem aviso numa versão do T3 Code que o t3sm não testou (nunca bloqueia)
`,
  help: `Uso: t3sm help [<tópico> | <comando>]

O que uma mensagem num ecrã do t3sm quer dizer, porque acontece e o que fazer, na tua língua. Sem tópico, lista-os; um
ecrã que mostra um problema diz qual é o tópico (\`t3sm help not-imported\`). \`t3sm help <comando>\` é o mesmo que
\`t3sm <comando> --help\`.

Exemplos:
  t3sm help
  t3sm help held
  t3sm help apply
`,
};
