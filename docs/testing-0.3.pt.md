# Testar o t3sm 0.3 na tua própria máquina

[English](testing-0.3.md)

Um guia prático para confirmares tu mesmo a versão 0.3, ao vivo, no teu PC e noutros: instalá-la, migrar uma
instalação 0.2.1, responder às perguntas do assistente guiado, ver o resultado no T3 Code e no Claude Code, correr os
testes ao vivo, assistir a uma atualização automática e a uma reposição, e saber o que enviar quando algo não parecer
certo.

Todos os comandos aqui existem na 0.3.1 (o `t3sm recover` é novo nela); o `t3sm <comando> --help` dá os pormenores. Tudo o que o t3sm escreve fica no
journal e pode ser desfeito (`t3sm runs`, `t3sm rollback --run <id>`). Os exemplos usam marcadores:
`D:\Work\t3code-session-manager` é o teu clone do repositório (com o nome do repositório, para o projeto dele no T3 Code
se chamar `t3code-session-manager`), `~` a tua pasta pessoal; no macOS ou no Linux usa um caminho como
`~/work/t3code-session-manager`.

| Parte | O que confirma | Tempo |
| :-- | :-- | :-- |
| [A](#a-um-pc-novo) | Uma instalação nova e o assistente guiado | 20-40 min |
| [B](#b-migrar-um-pc-da-021) | Passar um PC com a 0.2.1 e um vigilante a correr para a 0.3.1, e depois o T3 Code e o Claude Code | 30-60 min |
| [C](#c-os-testes-ao-vivo) | Os testes ao vivo que decidem duas definições em `src/t3/compat.ts` | 10 min |
| [D](#d-o-ciclo-de-atualização) | Uma atualização, o reinício do vigilante, uma reposição forçada | 20 min |
| [E](#e-outros-pcs-e-sistemas) | O que muda noutro PC Windows, no macOS e no Linux | - |
| [F](#f-como-fica-quando-está-bem-e-o-que-enviar) | O estado final esperado, e o que enviar se não for esse | - |
| [G](#g-trabalhar-a-partir-do-t3-code) | O dia a dia depois da configuração: o que chega sozinho ao T3 Code e o que precisa de ti | - |

## Antes de começar

- **Node.js 22.18 ou mais recente** (`node --version`), **git** (`git --version`) e o npm no `PATH`.
- **O T3 Code aberto**, pelo menu Iniciar (macOS: Dock ou Launchpad; Linux: o lançador), nunca a partir de um terminal.
- **Uma shell sem `CLAUDE_CONFIG_DIR`.** PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue`.
  Bash: `unset CLAUDE_CONFIG_DIR`. Corre todos os comandos abaixo nessa shell, como o teu utilizador normal (não com
  "Executar como administrador": o t3sm avisa então que o que instala fica só para esse utilizador).
- **A versão, já no `main` e com etiqueta.** No fim da construção, o Claude junta a 0.3 ao `main` e cria a etiqueta
  `v0.3.1`, por isso já lá está quando começares. Confirma, por esta ordem:

  ```powershell
  git -C D:\Work\t3code-session-manager status --short     # não escreve nada: sem alterações locais
  git -C D:\Work\t3code-session-manager switch main
  git -C D:\Work\t3code-session-manager tag --list v0.3.1  # escreve v0.3.1
  node D:\Work\t3code-session-manager\bin\t3sm.mjs --version   # 0.3.1
  ```

  Se alguma destas disser outra coisa, para aqui e pergunta antes de continuar.
- **Confirma que o T3 Code lista todas as threads**, antes do primeiro apply ou da configuração guiada. O t3sm só
  copia de volta para o T3 uma conversa que o T3 Code começou quando o T3 já não lista a thread dela, por isso uma
  lista a que faltem threads vivas criaria uma segunda thread para uma conversa que ainda lá está. Esta verificação só
  lê:

  ```powershell
  cd D:\Work\t3code-session-manager
  $env:T3_E2E=1; node --test --test-timeout=180000 test/e2e/live.test.ts; Remove-Item Env:T3_E2E
  ```

  Escreve `live: thread list: active=<A> archived=<B>`. Compara o A com as threads que o T3 Code mostra na barra
  lateral, em todos os projetos e nas prateleiras Settled, e o B com as threads arquivadas. Se o teu CLI `t3` tiver
  `t3 thread list`, a contagem dele deve ser A + B. Se algum número for diferente, para aqui e envia os dois números;
  enquanto isso não estiver resolvido, responde "não" quando a configuração perguntar pelas conversas apagadas no T3
  Code (`organize.sessions.orphaned` "skip"). (Mesmo com os números certos, o t3sm volta a listar as threads do T3 Code
  mesmo antes de copiar de volta uma dessas conversas, e deixa de fora as que voltarem a aparecer.)
- **Opcional, recomendado no teu PC principal: uma cópia da pasta de estado do t3sm**, para comparares antes e depois.
  Tem a configuração, o journal e os planos; nada aqui precisa dela, é só uma cópia de segurança.

  ```powershell
  Copy-Item -Recurse ~\.t3code-session-manager ~\t3sm-state-before-0.3
  ```

## A. Um PC novo

### A1. Instalar

A partir do GitHub, quando a `v0.3.1` lá estiver publicada:

```bash
npm install -g --install-links github:brunobola-portfolio/t3code-session-manager#v0.5.0
```

(Usa a etiqueta da versão que estás a testar: a linha do README indica sempre a atual.)

A partir de uma pasta num disco local (copia-a primeiro de uma pen ou de uma partilha: o `t3sm update --from` recusa
mais tarde um caminho de rede):

```powershell
npm install -g --install-links D:\Work\t3code-session-manager
t3sm --version                      # 0.3.1
```

O npm constrói o pacote só com o Node (o `prepare` escreve `dist/` dentro da pasta; o git ignora-o).

### A2. Verificar

```powershell
t3sm doctor
```

Bem: uma tabela de verificações, cada uma com ✓ (bem), ! (um aviso) ou ○ (nada a verificar aqui), depois os avisos
completos com o que fazer, e um painel com o veredicto; código de saída 0. Avisos normais num PC novo: "Versão do T3
Code" (uma versão do T3 Code que o t3sm não testou; segue em frente), "Sincronização agendada" e "Vigilante" (ainda
nada instalado), "Plugin do t3sm" (os comandos `/t3sm` não instalados). Um ✗ (uma falha) diz como se resolve;
resolve-o primeiro. (O `t3sm doctor --json` dá às verificações o id: `t3-version`, `schedule`, `sync-watcher`,
`t3sm-plugin`.)

### A3. O assistente guiado

```powershell
t3sm start            # ou só: t3sm
```

Num sistema em português fala português; `--lang en` ou `--lang pt` escolhem. Como deve ficar cada ecrã:

| Passo | O que vês | Resposta |
| :-- | :-- | :-- |
| 1 Boas-vindas | Um cabeçalho com a versão (0.3.1) e quantas contas Claude o t3sm encontrou; numa segunda vez, uma lista dos passos (✓ feito, ◉ a seguir, ○ mais tarde) | `s` |
| 2 Verificação | Todas as verificações do doctor numa grelha compacta, e "A ter em conta" só para o que te diz respeito | `s` |
| 3 Contas | Uma tabela com as tuas contas Claude (emails mascarados) e as instâncias no T3 Code | `s` se os nomes estiverem certos |
| 4 Plano | Um painel com as contagens alinhadas (a importar, a converter, de fora), e depois os projetos e as contas | Enter (ou `c`) para continuar |
| 5 Decisões | Um painel por pergunta, com os números reais, o valor por omissão e a chave do `config.json` para mudar depois; as respostas ficam guardadas logo que respondes à última | vê B5 |
| 6 Limpeza | Só quando o plano encontrou pastas de backup ou cópias-espelho | à tua escolha |
| 7 Piloto | Projetos pequenos para experimentar primeiro, e depois "Isto é o que vou fazer" | escolhe um, `s` |
| 8 Importação completa | "Isto é o que vou fazer", depois uma barra de progresso, depois um painel com o resultado | `s` |
| 9 Arrumar | Uma tabela antes/depois por projeto, e depois uma pergunta por parte | vê B5 |
| 10 Manter sincronizado | O vigilante em segundo plano | `s` |
| 11 Concluído | Um painel: o que mudou, como desfazer, o que acontece a seguir | - |

Cada passo começa com uma barra como `● ● ● ◉ ○ ○ ○ ○ ○ ○ ○  Passo 4 de 11 · Plano`. As perguntas que escrevem têm "não"
por omissão: escreve `s` (em inglês `y`). `?` explica, `v` volta atrás (em inglês `b`), `q` para; corre `t3sm` outra
vez para continuar.

### A4. Depois

```powershell
t3sm status          # ✓ Tudo bem · o t3sm não precisa de nada de ti   (código 0)
t3sm schedule status # a entrada do agendador, o comando, o heartbeat do vigilante, o último ciclo
```

## B. Migrar um PC da 0.2.1

Esta é a passagem completa de um PC que corre a 0.2.1 com um vigilante em segundo plano, conversas da pasta pessoal,
conversas começadas no T3 Code e pelo menos uma cuja thread foi apagada no T3 Code.

> **Se já correste a 0.3.0:** instala a 0.3.1 (como no B2, ou `t3sm update --from D:\Work\t3code-session-manager`) e
> corre outra vez `t3sm start` (B5). As perguntas voltam: a 0.3.0 perguntava "guardar as respostas?" depois das
> decisões, e o não por omissão deixava todas as respostas (e essas conversas) de fora; e a pergunta do histórico volta
> uma vez para um `config.json` da 0.2.1. Responde como no B5; a importação traz então as conversas que ficaram de fora.

### B1. Regista onde estás

```powershell
t3sm --version          # 0.2.1
t3sm schedule status    # o vigilante e o último ciclo
t3sm runs               # aponta o id da execução mais recente
```

Tira uma captura da barra lateral do T3 Code se quiseres comparar antes e depois.

### B2. Instala a 0.3.1 a partir da pasta

```powershell
npm install -g --install-links D:\Work\t3code-session-manager
t3sm --version          # 0.3.1
```

Entretanto o vigilante 0.2.1 continua a correr o código antigo que tem em memória; o passo seguinte substitui-o. (A
0.2.1 não tem `update --from`; a partir da 0.3.0, o `t3sm update --from D:\Work\t3code-session-manager` faz este passo e o seguinte de
uma vez.)

### B3. Substitui o vigilante

```powershell
t3sm schedule install --watch --dry-run
t3sm schedule install --watch --yes
```

O ensaio diz que pararia o vigilante em execução e arrancaria o novo. A execução a sério diz
`Parei o vigilante em execução (processo <n>) e arranquei o novo.` e sai com 0 (num PC sem nenhum vigilante a correr:
`Nenhum vigilante estava a correr; arranquei-o.`). Como o parou: o vigilante 0.2.1 não
sabe responder a um pedido de paragem, por isso o t3sm leu o processo no heartbeat, confirmou que a linha de comando
desse processo é um vigilante do t3sm (`node ... t3sm sync --watch`) e que arrancou à hora que o heartbeat diz, e só
então o terminou. Nunca pelo nome. Se o vigilante já for da 0.3, usa antes `t3sm schedule restart --yes`.

Outra coisa? `O vigilante em segundo plano continua a correr (processo <n>) e não pôde ser parado em segurança` (código
1): termina tu esse único processo (Gestor de Tarefas, por esse número; Ctrl+C na janela dele, se tiver uma) e corre o
comando outra vez. Quando a mensagem não indica o processo (`O vigilante em segundo plano continua a correr e não pôde
ser parado em segurança`), o `t3sm schedule status` mostra o número do processo na linha do vigilante: termina esse
processo e corre o comando outra vez.

### B4. Confirma o heartbeat

```powershell
t3sm status
t3sm status --json      # "watcher": { "running": true, "pid": <n>, "version": "0.3.1", "stale": false }
t3sm doctor             # ✓ Sincronização agendada, ✓ Vigilante
```

O `t3sm status` mostra `Vigilante  a correr (processo <n>, t3sm 0.3.1)`. Se disser que o vigilante "ainda corre o
t3sm 0.2.1" ou que "corre um t3sm antigo que não volta a arrancar sozinho depois de uma atualização", o B3 não o substituiu: corre
`t3sm schedule restart --yes`.

Depois reinicia-o duas vezes seguidas e confirma que fica um só vigilante e que nada precisa de ti:

```powershell
t3sm schedule restart --yes   # Parei o vigilante em execução (processo <n>) e arranquei o novo.
t3sm schedule restart --yes   # a mesma linha, com o processo do vigilante que o primeiro reinício arrancou
t3sm status                   # ✓ Tudo bem; Vigilante  a correr (processo <m>, t3sm 0.3.1), o do segundo reinício
```

O Gestor de Tarefas (Detalhes, `node.exe`, a coluna Linha de comandos) mostra um só `t3sm ... sync --watch`, com esse
processo.

### B5. O assistente guiado, em português

```powershell
t3sm start --lang pt
```

(Num sistema em português basta `t3sm`.) As boas-vindas mostram uma lista do que já está feito e de onde continua. Se
disser `Outra execução do t3sm está a trabalhar agora (processo <n>)`, um ciclo do vigilante ou outra janela tem o
bloqueio do t3sm: espera um minuto e corre `t3sm start --lang pt` outra vez. Depois:

1. **Passo 5 · Decisões.** Um painel por pergunta em aberto. Responde:
   - *A tua pasta pessoal* — "Pôr cópias destas conversas nos projetos certos?" → `s`.
   - *Iniciadas por programas* (automáticas, Agent SDK) — "Importar estas conversas?" → `n`.
   - *Apagadas no T3 Code* — "Trazer de volta estas conversas como cópias?" → `s`.
   - Outras perguntas (pastas recusadas, temporárias, do sistema): os valores por omissão servem.

   Não há pergunta "guardar as respostas?": as respostas ficam guardadas no `config.json` logo que respondes à última,
   com uma linha, "Respostas guardadas no config.json; podes mudá-las depois em organize." Um `q` antes da última
   resposta não guarda nada.

   Depois, "Para onde vão as cópias": uma linha por pasta de onde vêm cópias, com o sítio para onde o t3sm as vai pôr
   e porquê ("63 de 80 caminhos em ..."). Confirma que as conversas sobre o t3sm feitas na tua pasta pessoal vão para
   o projeto `t3code-session-manager` (o projeto inferido). `e` muda um destino; Enter confirma. Só se mudaste alguma
   coisa é que pergunta "Guardar estes destinos no config.json?" (`s`).
2. **Passos 6 a 8.** A limpeza, se for oferecida; o piloto pode ser saltado (`n`) num PC que já importou uma vez;
   depois "Importar tudo agora?" → `s`. Uma barra de progresso ("A importar N conversas · M projetos") e depois o
   painel do resultado. Um projeto retido porque uma conversa dele está em uso (a conversa deste terminal, por
   exemplo) espera e é importado quando ela estiver parada há 10 minutos; o painel di-lo.
3. **Passo 9 · Arrumar.** Uma tabela por projeto (agora → depois). Depois:
   - "Mostrar os últimos 90 dias, e pelo menos 10 por projeto?" → Enter ou `s` (90 / 10). Depois de atualizar da
     0.2.1 o painel diz também o que tinhas, "Até agora: todas as conversas visíveis." (a 0.2.1 deixava todas as
     conversas visíveis): é perguntado mais uma vez, com a regra da 0.3, mesmo quando nada mudaria.
   - Títulos, automáticas, projetos fixados, projetos vazios: os valores por omissão servem.
   - Se for perguntado, "Deixar também o T3 Code arrumar as conversas começadas no T3 passados 90 dias? Agora: passados
     15 dias." → `s` (a opção do próprio T3 Code fica em 90; `n` deixa-a como está, nunca a desliga; não é perguntado
     quando já está em 90). Com uma regra de mais de 90 dias, ou de tudo, aparece antes um menu numerado; escolhe pelo
     texto, os números dependem do que se aplica: "Manter (...)" (Enter), "Pôr em 90 dias", "Desligar". O `?` explica
     porque é que a ordem é segura.
   - "Aplicar estas alterações ao T3 Code agora?" → `s`.
4. **Passos 10 e 11.** O vigilante já está instalado (B3). Para cada conta Claude sem os comandos `/t3sm`, o passo 11
   oferece "Instalar o plugin em <conta> (<pasta>)?" (por omissão não). `s` corre o `claude plugin marketplace add` e o
   `claude plugin install` para essa conta, que vão à rede; `n` serve para este teste. O último painel lista o que
   mudou e como desfazer cada execução.

### B6. Confirma no T3 Code

Abre o T3 Code (pelo menu Iniciar) e confirma:

- [ ] **Cada projeto mostra o seu histórico recente**: as conversas dos últimos 90 dias dentro do projeto, e pelo menos
  10 quando o projeto as tem. As mais antigas estão na prateleira **Settled** no fundo da barra lateral, ainda ligadas
  ao projeto (filtra a prateleira por projeto).
- [ ] **O projeto `t3code-session-manager` tem as conversas feitas na pasta pessoal**, incluindo as conversas longas em
  que o t3sm foi construído, com o histórico completo (abre uma e percorre-a). Uma conversa que ainda estava a ser
  escrita quando fizeste o B5 é copiada mais tarde, pelo vigilante, quando estiver parada há 10 minutos.
- [ ] **Sem duplicados das conversas começadas no T3 Code**: cada uma continua a aparecer uma vez. O `t3sm plan`
  lista-as no `plan.md`, em "Skipped by reason", como `already-in-t3` com a nota `started-in-t3`.
- [ ] **A apagada voltou**: uma conversa cuja thread tinhas apagado no T3 Code é outra vez uma thread, no seu projeto,
  com o histórico. Quando a transcrição não indica nenhuma thread do T3 Code, o t3sm não consegue saber que foi
  apagada: o `t3sm status` lista-a em Bom saber ("... trá-la de volta com t3sm recover <id>"). Aí o
  `t3sm recover <id> --dry-run` mostra o que faria, e o `t3sm recover <id>` pergunta e trá-la de volta como cópia com
  um id novo (um duplicado se a thread ainda existir; desfaz-se com `t3sm rollback --run <id> --archive-threads`).
- [ ] **Nenhuma conversa continua a falhar sem razão**: o `t3sm status` não lista conversas começadas no T3 Code em
  "continuam a falhar a importação".
- [ ] **As conversas mantidas para o mínimo ficam marcadas** (só enquanto a opção do próprio T3 Code estiver
  ligada, uma semana antes de lhes poder chegar): antes de aplicar, o `t3sm organize --dry-run` lista "Manter N conversas
  à vista em P projetos, marcadas para que a passagem automática para Settled do T3 Code nunca as arrume" num projeto
  que mantém conversas assim. Depois de aplicar, o `t3sm status` está limpo e essas conversas continuam à
  vista no projeto. Uma marca muda o `unsettledAt` do T3 Code, por isso podem mudar de lugar na ordenação da prateleira
  de trabalho do T3 Code; é o esperado. O `t3sm organize --undo --dry-run` lista-as como mantidas (uma marca não se
  desfaz).
- [ ] **A opção do próprio T3 Code**: nas definições do T3 Code, a opção de passar automaticamente para Settled (auto-settle) as
  suas próprias conversas está em 90 dias.
- [ ] **Dá para desfazer**: o `t3sm runs` lista as execuções do B5; o `t3sm organize --undo --dry-run` mostra o que a
  execução do organize reporia (não o corras sem quereres).

### B7. Confirma no Claude Code

```powershell
cd D:\Work\t3code-session-manager
claude --resume
```

- [ ] A lista mostra as cópias que o t3sm fez neste projeto (mantêm os títulos e as primeiras mensagens originais).
- [ ] Escolher uma abre-a com o histórico completo. Para só ver, sai sem enviar mensagem (Ctrl+C duas vezes): uma
  mensagem é um turno a sério na tua subscrição, e uma cópia continuada fora do T3 Code deixa de estar "intacta", por
  isso o t3sm deixa de a atualizar a partir do original e mostra-a no `t3sm status` se o original também crescer.

### B8. Confirma que uma cópia segue o original

1. No VS Code, aberto na tua pasta pessoal, continua uma das conversas da pasta pessoal que foram copiadas: envia uma
   mensagem curta.
2. Deixa-a parada pelo menos 10 minutos. O ciclo seguinte do vigilante (depois de as mudanças assentarem, ou a cada 15
   minutos) traz a mensagem nova.
3. No T3 Code: uma thread nova com o mesmo título no projeto `t3code-session-manager`, com a mensagem nova; a thread
   antiga fica arquivada. O `logs/sync.log` (em `~\.t3code-session-manager\logs\`) tem uma linha de ciclo com
   `followed=1`.

## C. Os testes ao vivo

Dois testes ao vivo medem como o teu T3 Code se comporta e decidem duas constantes em `src/t3/compat.ts`. Precisam do
Windows, do T3 Code a correr e do teu sim: escrevem sessões sintéticas no teu `~\.claude` verdadeiro e no T3 Code
(projetos descartáveis dentro da pasta `.spike\` do clone) e removem tudo o que criaram no `finally`. O
`organize.live` também gasta alguns tokens (um turno `claude --resume -p`), e o S7b um turno do modelo.

No clone, uma vez: `npm install` (só o TypeScript e o `@types/node`). Depois, um ficheiro de cada vez:

```powershell
cd D:\Work\t3code-session-manager
Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
$env:T3_E2E=1; node --test --test-timeout=180000 test/e2e/followup.live.test.ts
$env:T3_E2E=1; node --test --test-timeout=180000 test/e2e/organize.live.test.ts
Remove-Item Env:T3_E2E
```

Bash: `env -u CLAUDE_CONFIG_DIR T3_E2E=1 node --test --test-timeout=180000 test/e2e/followup.live.test.ts`.

### Ler o `followup.live` (S7 e S8)

Nunca falha por causa de um resultado; escreve uma linha JSON por caso. Procura as linhas que começam por `{"case":`:

| Caso | Campo | Valores |
| :-- | :-- | :-- |
| `S7a` (o ficheiro cresce e é importado outra vez) | `outcome` | `grew-same-thread`, `nothing-happened`, `error`, `other` |
| `S7b` (continuada primeiro no T3 Code, depois o ficheiro cresce) | `outcome` | os mesmos, ou `send-failed` (nada medido) |
| `S8` (resolver com um `settledAt` no passado) | `outcome` | `honoured`, `ignored`, `rejected`, `no-settledAt-seen` |

O que mudar em `src/t3/compat.ts`:

- `FOLLOW_MODE`: põe `"refresh"` **só se o S7a e o S7b disserem ambos `grew-same-thread`**. Em qualquer outro caso
  mantém `"revision"` (uma cópia que segue o original passa a ser uma thread nova e a antiga é arquivada).
- `SETTLE_BACKDATE`: põe `true` **só se o S8 disser `honoured`** (o `settledAt` guardado é igual ao enviado). Aí a
  prateleira Settled mostra cada conversa na sua data real. Em qualquer outro caso mantém `false`.

Se mudares alguma: corre `npm run typecheck` e `npm test`, escreve as linhas na secção "Results" de
`docs/spikes/S7-followup-and-backdate.md`, acrescenta uma linha ao `CHANGELOG.md` em `## [Unreleased]` e lança-a como
versão de correção (0.3.2). O teu vigilante instala-a sozinho (a parte D mostra como).

### Ler o `organize.live`

Passa ou falha como um teste normal. Importa conversas sintéticas para um projeto descartável, arquiva a automática,
mostra as duas humanas, muda o título da técnica, fixa o projeto e desfaz tudo; copia uma conversa sintética da pasta
pessoal para um projeto e retoma-a com `claude --resume`; cria e apaga um projeto vazio. Uma falha diz em que passo; o
que não conseguir remover fica registado com o comando que o remove.

## D. O ciclo de atualização

Se puderes, faz isto num segundo PC ou numa máquina virtual: deixa o teu PC numa versão de teste até limpares (passo
D6). Usa um clone descartável, para as etiquetas do teu clone verdadeiro ficarem limpas, e mantém o vigilante
instalado (o `t3sm schedule status` mostra-o): sem ele não há nada para verificar.

### D1. Uma versão de teste

```powershell
git clone D:\Work\t3code-session-manager D:\Work\t3sm-update-test
cd D:\Work\t3sm-update-test
git switch main
git config user.name "t3sm test"           # só neste clone; preciso numa máquina onde o git ainda não tem nome
git config user.email "test@example.com"
node scripts/release.js 0.3.2      # só edita os ficheiros de versão; pode dizer "Still to fix": serve para um teste
git commit -am "test release 0.3.2"
git tag -a v0.3.2 -m v0.3.2
```

### D2. Ver, e depois atualizar

```powershell
t3sm update --check
t3sm update --from D:\Work\t3sm-update-test --dry-run
t3sm update --from D:\Work\t3sm-update-test
```

- O `--check` mostra a versão instalada (0.3.1), a mais recente da origem atual (o GitHub até ficar lembrada uma
  pasta), o tipo, se as atualizações automáticas estão ligadas e a última procura. Só lê.
- O ensaio mostra um painel `t3sm 0.3.1 -> 0.3.2 (correção)`, `origem: a pasta D:\Work\t3sm-update-test`, depois a
  secção do CHANGELOG dessa etiqueta em "O que há de novo", e acaba com
  `Instalaria o t3sm 0.3.2 (origem: a pasta D:\Work\t3sm-update-test). Nada mudou.` Nada é instalado.
- A execução a sério pergunta se instala a 0.3.2 (`s`) e depois mostra cada passo: a instalação com o npm, o reinício
  do vigilante, a espera (até 2 minutos) por ele na 0.3.2, e no fim `O t3sm foi atualizado: 0.3.1 -> 0.3.2.` Código 0.

Depois:

```powershell
t3sm --version                   # 0.3.2
t3sm status                      # Vigilante  a correr (processo <n>, t3sm 0.3.2); em Bom saber: "Atualizado para 0.3.2 hoje"
t3sm update --check              # Origem: a pasta D:\Work\t3sm-update-test (agora lembrada)
Select-String '"t":"update"' ~\.t3code-session-manager\journal.jsonl   # pending, depois installed
t3sm status --json               # "watcher": { "running": true, "version": "0.3.2", ... } e um processo novo
```

A atualização só acaba `installed` depois de o vigilante novo escrever o heartbeat dele na 0.3.2: a última entrada de
atualização do journal diz `installed`, e o `t3sm status --json` mostra o vigilante a correr a 0.3.2 com um processo
diferente do anterior.

### D3. Vê o vigilante reiniciar-se sozinho

É o caminho de uma instalação que não foi o vigilante a fazer.

```powershell
cd D:\Work\t3sm-update-test
node scripts/release.js 0.3.3
git commit -am "test release 0.3.3"
git tag -a v0.3.3 -m v0.3.3
npm install -g --install-links D:\Work\t3sm-update-test
```

Num ciclo (no máximo `schedule.everyMinutes`, 15 por omissão) mais 30 segundos, o vigilante 0.3.2 em execução vê a
instalação nova, para de forma limpa e arranca o novo. O `logs/sync.log` ganha `restart from=0.3.2 to=0.3.3`, e o
`t3sm status` mostra o vigilante na 0.3.3. Se disser que a 0.3.3 está instalada e que o vigilante passa para ela depois
do ciclo seguinte, espera por esse ciclo.

### D4. Força uma reposição

Faz uma versão cujo vigilante não consegue arrancar: no clone de teste, põe esta linha logo a seguir à primeira linha
de `bin/t3sm.mjs`:

```js
if (process.argv.includes("--watch")) process.exit(1);
```

```powershell
node scripts/release.js 0.3.4
git commit -am "test release 0.3.4 (broken watcher)"
git tag -a v0.3.4 -m v0.3.4
t3sm update --yes
```

Instala a 0.3.4, reinicia o vigilante, espera 2 minutos por um heartbeat que nunca chega, diz que a versão nova não
arrancou e que está a repor a 0.3.3, e termina com
`O t3sm 0.3.4 não arrancou bem, por isso voltou a 0.3.3 (...)` (código 1). O t3sm recuperou sozinho, por isso não
precisa de ti. Confirma:

- [ ] O `t3sm --version` é 0.3.3 e o `t3sm status` mostra o vigilante a correr na 0.3.3.
- [ ] O `t3sm status` diz "Tudo bem" (código 0) e lista em "Bom saber": "A atualização para o t3sm 0.3.4 foi
  desfeita; está a correr o 0.3.3 (a verificação automática passa a ignorar o 0.3.4)", com `t3sm update --check`.
- [ ] O `t3sm update --check` ainda mostra a 0.3.4 como a mais recente, com a nota "voltou atrás antes, por isso a
  procura automática salta-a". A procura automática nunca mais a instala; o `t3sm update` ainda a instalaria de
  propósito (aqui não o faças).
- [ ] O journal tem uma entrada `update` com `"outcome":"rolled-back"`.

### D5. O caminho automático (opcional)

Com o `update.auto` ligado (o valor por omissão), o vigilante procura uma vez por dia; uma versão de correção ou menor
mais recente na origem lembrada é instalada por um `t3sm update --auto-run --yes` escondido, com a mesma verificação.
Para o veres, faz uma 0.3.5 boa no clone de teste:

```powershell
cd D:\Work\t3sm-update-test
git revert --no-edit HEAD                  # tira a linha estragada do bin/t3sm.mjs (e a subida para 0.3.4)
node scripts/release.js 0.3.5
git commit -am "test release 0.3.5"
git tag -a v0.3.5 -m v0.3.5
```

Deixa o PC ligado, com o vigilante a correr, até um dia. Depois o `t3sm --version` é 0.3.5, o `t3sm status` diz
"Atualizado para 0.3.5 hoje - novidades: t3sm changelog" e o `logs/sync.log` regista a atualização. O
`t3sm update --auto off` desliga as atualizações automáticas.

### D6. Limpar

O t3sm nunca volta a uma versão anterior, por isso não regressa sozinho à 0.3.1, e a origem lembrada ainda aponta para
o clone de teste. Repõe tudo à mão:

```powershell
t3sm schedule remove --yes
git clone --depth 1 --branch v0.3.1 file:///D:/Work/t3code-session-manager $env:TEMP\t3sm-v0.3.1
npm install -g --install-links $env:TEMP\t3sm-v0.3.1
Remove-Item ~\.t3code-session-manager\update.json      # esquece a origem de teste e a versão ignorada
Remove-Item -Recurse -Force D:\Work\t3sm-update-test, $env:TEMP\t3sm-v0.3.1
t3sm schedule install --watch --yes
t3sm --version                                         # 0.3.1
```

Sem o `update.json` o t3sm volta a seguir o GitHub. Para a próxima versão a sério a partir do teu clone, corre uma vez
`t3sm update --from D:\Work\t3code-session-manager`; daí em diante o vigilante segue essa pasta.

O `t3sm status` diz então "Tudo bem" (código 0). Se saltaste o D5, lista também uma linha em "Bom saber": "A
atualização para o t3sm 0.3.4 foi desfeita; está a correr o 0.3.1 (a verificação automática passa a ignorar o 0.3.4)".
Essa linha fica até ser instalada uma versão mais recente do que a 0.3.4; nunca precisa de ti.

## E. Outros PCs e sistemas

- **Outro PC Windows.** Os mesmos passos. O agendamento é uma tarefa do Agendador de Tarefas do teu utilizador com dois
  gatilhos (início de sessão, e a cada 15 minutos para o manter vivo); a janela fica escondida. As notificações são
  notificações do Windows.
- **macOS.** O agendamento é um LaunchAgent (`~/Library/LaunchAgents`) com `KeepAlive`: é o launchd que reinicia o
  vigilante, por isso não há gatilho de 15 minutos, e um vigilante que se reinicia numa instalação nova sai (código 75)
  para o launchd arrancar o novo. As notificações passam pelo `osascript`. Os caminhos são `~/...`; a língua segue o
  `LANG` (por exemplo `pt_PT.UTF-8`) ou a do sistema.
- **Linux.** O agendamento são duas linhas do crontab marcadas com `# t3sm` (`@reboot` e `*/15`):
  `crontab -l | grep t3sm`. O `schedule install --watch` também arranca o vigilante logo. As notificações usam o
  `notify-send` quando está instalado.
- **Os testes ao vivo (parte C)** precisam do Windows; no macOS e no Linux saltam-se sozinhos.
- **Sem T3 Code nesse PC?** O `scan`, o `status`, o `help`, o `runs`, o `changelog`, o `projects` (o que esta máquina
  sabe) e o `update --check` funcionam; o `doctor` corre e dá as verificações do T3 Code como falhas (código 1); o
  `plan`, o `apply`, o `sync`, o `organize`, o `merge` e o `accounts` saem com 3 até o T3 Code estar a correr.

## F. Como fica quando está bem, e o que enviar

Está bem quando, no fim de A ou de B:

- [ ] O `t3sm --version` mostra a versão que instalaste.
- [ ] O `t3sm status` diz "Tudo bem" (código 0), ou "Precisa de ti" com um comando que percebes para cada item.
- [ ] O `t3sm status --json` tem `"watcher": { "running": true, "version": "<essa versão>", "stale": false }`.
- [ ] O `t3sm doctor` não tem nenhum `fail` (código 0).
- [ ] No T3 Code: cada projeto mostra o histórico recente; as conversas da pasta pessoal estão no seu projeto; não há
  duplicados; a conversa apagada voltou.
- [ ] O `claude --resume` numa pasta de projeto lista e abre as cópias.
- [ ] O `logs/sync.log` ganha uma linha por ciclo, sem `error`.

Se algo não estiver bem, envia:

```powershell
t3sm --version
t3sm status --json > t3sm-status.json
t3sm doctor --json > t3sm-doctor.json
Get-Content ~\.t3code-session-manager\logs\sync.log -Tail 30 > t3sm-sync-log.txt
t3sm update --check
```

mais as linhas `{"case":...}` da parte C, o comando que correste e o que escreveu (uma captura serve). Estes ficheiros
têm contagens, versões, ids de execução, emails mascarados e pastas de projeto com a tua pasta pessoal como `~`;
lê-os antes de enviar. **Nunca envies conteúdo de conversas**: nem o `plan.md` (lista os títulos das conversas), nem o
`journal.jsonl`, nem transcrições. O `t3sm help <tópico>` explica primeiro a maior parte das mensagens: o ecrã diz qual
é o tópico.

## G. Trabalhar a partir do T3 Code

Depois do A ou do B, é no T3 Code que trabalhas; o t3sm mantém-no em dia em segundo plano.

- **O T3 Code tem de estar a correr para importar e organizar.** Com o T3 Code fechado, o vigilante espera (tenta
  outra vez a cada minuto) e põe-se em dia logo que o abres. O `t3sm status`, o `t3sm scan` e o `t3sm projects`
  funcionam sem ele (o `projects` diz que mostra o que esta máquina sabe), e o `t3sm doctor` corre e dá as
  verificações do T3 Code como falhadas; o `plan`, o `apply`, o `sync`, o `organize`, o `merge` e o `accounts` (menos
  o `accounts --init`) saem com 3 até o T3 Code correr.
- **As sessões que começas num terminal ou no VS Code dentro da pasta de um projeto chegam sozinhas ao T3 Code**:
  quando uma sessão está parada há 10 minutos, o ciclo seguinte importa-a para esse projeto, na conta com que correu.
  Um projeto com uma sessão ainda em uso espera pelo ciclo seguinte, e mais de 200 pendentes de uma vez
  (`sync.maxUnattendedImports`) esperam por um `t3sm apply`.
- **O trabalho que continuas num terminal numa conversa que já é uma thread no T3 Code** não aparece lá sozinho:
  corre `t3sm merge` (lista-as; o `t3sm merge --all` trá-las como threads novas e arquiva as antigas). Para que o
  vigilante o faça, põe `sync.autoMerge` a `true` no `config.json`; passa então a juntar cada uma quando está parada
  há 10 minutos, no máximo 20 por ciclo. Acrescenta isto ao ficheiro (as outras opções de `sync` ficam com os valores
  por omissão), e o ciclo seguinte lê-o:

  ```json
  "sync": { "autoMerge": true }
  ```

  O `config.json` fica na pasta de estado do t3sm: `%USERPROFILE%\.t3code-session-manager\config.json` no Windows,
  `~/.t3code-session-manager/config.json` no macOS e no Linux (ou dentro de `T3SM_HOME`, se o definires).
- **As conversas que começas na tua pasta pessoal** vão para onde diz a resposta que gravaste à pergunta da pasta
  pessoal: com sim, uma cópia vai para o projeto em que a conversa mais trabalhou (ou para "Geral"). A sincronização
  em segundo plano só escreve uma cópia num projeto que já existe no T3 Code; uma cujo destino ainda não existe
  espera, e o `t3sm status` ou o `t3sm sync` dizem-te para correres o `t3sm start` para o criar.
- **Cada projeto começa as threads novas numa conta Claude**: a conta a que as suas sessões pertencem, ou a que a tua
  regra indica. O `t3sm projects` mostra-a e porquê; o `t3sm projects set "<pasta>" <conta>` muda-a (pergunta
  primeiro, e também muda a conta por omissão do projeto no T3 Code quando o projeto lá está). A sincronização em
  segundo plano nunca substitui uma conta por omissão que escolheste no T3 Code; o `t3sm apply` só a muda depois de a
  mostrar (em "Project defaults to set" no `plan.md`, e em "Contas por omissão a definir" no
  `t3sm apply --dry-run`) e de perguntar uma vez pelo plano todo, e o `t3sm projects set` pergunta primeiro.
- **O que ver no `t3sm status`**: "Tudo bem" (saída 0) quer dizer que nada espera por ti. "Precisa de ti" (saída 10)
  lista cada ponto com o comando que o resolve: perguntas por responder (`t3sm start`), um vigilante parado ou
  atrasado (`t3sm schedule restart`), uma atualização falhada. Por baixo: as importações pendentes, a última e a
  próxima sincronização, o vigilante (a correr, com o processo e a versão), o plugin do t3sm por conta e o T3 Code.
  Os projetos à espera porque uma conversa está em uso, e uma versão mais nova, aparecem em "Bom saber". As sessões
  continuadas num terminal são contadas pelo `t3sm doctor` ("Sessões continuadas") e listadas pelo `t3sm merge`.
