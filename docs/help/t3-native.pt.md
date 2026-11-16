# Começadas no T3 Code: conversas que o t3sm deixa de fora

## O que quer dizer

Estas conversas foram começadas dentro do T3 Code, mas o T3 Code já não indica uma thread a que o t3sm as possa
associar. O t3sm nunca copia por iniciativa própria uma conversa que pertence ao próprio T3 Code, por isso ficam como
estão até dizeres o contrário.

## Porque acontece

- A thread foi removida no T3 Code, ou o T3 Code foi reinstalado e perdeu a sua própria lista.
- O ficheiro da sessão foi copiado de outra máquina.

## O que fazer

- Se o T3 Code ainda mostra a conversa, não há nada a fazer.
- Se não mostra (apagaste a thread, por exemplo), trá-la de volta com `t3sm recover <id da sessão>`: uma cópia fiel
  com um id novo, importada para o seu projeto. Experimenta primeiro `t3sm recover <id da sessão> --dry-run`. O t3sm
  não consegue ver se a thread ainda existe, por isso, se existir, isto cria um duplicado. Desfaz-se com
  `t3sm rollback --run <id> --archive-threads`.
- Também a podes continuar num terminal: `claude --resume <id da sessão>` (o id é o nome do ficheiro).
- O `t3sm status` lista-as em Bom saber.
