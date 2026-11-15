# Erros: quando um comando do t3sm para

## O que quer dizer

O comando parou e diz o que aconteceu. Nada fica a meio: as datas dos ficheiros são repostas, e cada alteração feita
até ali fica no diário e pode ser desfeita com `t3sm rollback --run <id>`.

## Os mais comuns

- O T3 Code não está a correr (saída 3): abre-o pelo menu Iniciar ou pelo teu lançador e corre o comando outra vez.
- Sem contacto com o T3 Code (saída 3): fechou ou deixou de responder; abre-o e corre o comando outra vez.
- O T3 Code respondeu de uma forma que o t3sm não conhece (saída 4): nada foi alterado; atualiza o t3sm com
  `t3sm update`.
- Um problema de uso ou de configuração (saída 2): faz o que a mensagem diz. Um comando que escreve precisa de `--yes`
  quando não corre num terminal.
- Outra execução do t3sm está a decorrer (saída 0): espera por ela; o `t3sm status` mostra o que está a correr.

## O que fazer

Corre `t3sm doctor`: verifica tudo o que o t3sm precisa e diz o que corrigir. Para reportar um problema, junta o
resultado de `t3sm doctor --json` (os emails vão mascarados e a tua pasta pessoal aparece como ~; lê-o antes de o
partilhares).
