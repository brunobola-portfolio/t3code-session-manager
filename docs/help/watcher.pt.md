# O vigilante: a sincronização em segundo plano parada ou atrasada

## O que quer dizer

O vigilante é a sincronização em segundo plano (`t3sm schedule install --watch`): importa as conversas novas uns
minutos depois de acalmarem. O `t3sm status` diz quando ele não está a correr, corre um t3sm antigo, ou os ciclos dele
pararam.

## Porque acontece

- Foi parado, ou terminou sem uma paragem limpa (o computador adormeceu, o processo foi terminado).
- O t3sm foi atualizado e o vigilante não reiniciou na versão nova.
- Para no arranque (o `config.json` não pode ser usado, ou, em Linux e macOS, a pasta do seu socket não é segura): o
  `logs/sync.log` diz `startup-error` ou `socket-dir-unsafe`.
- Os ciclos dele continuam a falhar (T3 Code incompatível, uma conta com a sessão terminada).

## O que fazer

- `t3sm schedule restart` para-o em segurança e arranca-o outra vez.
- `t3sm schedule status` mostra a entrada do agendador, o sinal de vida do vigilante e o último ciclo registado.
- Ainda nada instalado: `t3sm schedule install --watch`. Um vigilante que arrancou à mão volta com
  `t3sm sync --watch`.
- Para no arranque, ou os ciclos continuam a falhar: o `t3sm doctor` diz porquê.
- "Another t3sm run is in progress": uma sincronização está a meio do seu trabalho; os comandos de agendamento só param
  o vigilante entre execuções, por isso tenta outra vez daqui a pouco.
