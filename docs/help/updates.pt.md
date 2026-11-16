# Atualizações: como o t3sm se atualiza, e quando falha

## O que quer dizer

Uma vez por dia o vigilante em segundo plano procura um t3sm mais recente. Uma versão de correção ou menor é
instalada sozinha; uma versão maior só é anunciada. Depois de instalar, o vigilante tem de arrancar na versão nova em
2 minutos, senão volta a versão anterior. O t3sm nunca volta a uma versão mais antiga.

Atualiza-se a partir de onde foi instalado: o registo do npm para `npm install -g t3code-session-manager`, as
etiquetas de versão do GitHub para uma instalação a partir do GitHub, ou uma cópia do código neste computador depois de
`t3sm update --from <pasta>`.

## Porque falha

- Sem rede, com um proxy, ou sem git e npm: a procura fica para mais tarde.
- A versão nova não arrancou bem: a atualização foi desfeita e a versão anterior voltou a correr. O `t3sm status`
  mostra-o em "Bom saber", não como algo que precisa de ti; a procura automática passa a saltar essa versão, e o
  `t3sm update` ainda a pode instalar de propósito.
- O computador adormeceu ou reiniciou durante a atualização: ficou interrompida.

## O que fazer

- `t3sm update --check` mostra a versão instalada e a mais recente, a última procura e como voltar atrás depois de
  uma atualização interrompida.
- `t3sm update` instala a versão mais recente depois de mostrar o que há de novo; `t3sm changelog` mostra o que
  mudou.
- `t3sm update --auto off` desliga as atualizações automáticas (`--auto on` volta a ligá-las).
- `t3sm update --source npm` passa uma instalação do GitHub para o registo do npm; `--source github` volta atrás.
