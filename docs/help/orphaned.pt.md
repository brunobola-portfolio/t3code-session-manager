# Apagadas no T3 Code: conversas que voltam como cópias

## O que quer dizer

Estas conversas foram começadas no T3 Code e apagaste lá as threads delas. Os ficheiros das sessões continuam nesta
máquina. Por omissão o t3sm traz cada uma de volta como cópia, depois de dizeres que sim a essa pergunta no
`t3sm start` (a definição `organize.sessions.orphaned` é `"copy"`). Enquanto a pergunta não tiver resposta, esperam.

## Porque fica uma de fora

Respondeste que não no `t3sm start`, ou puseste `organize.sessions.orphaned` a `"skip"` no config.json: uma conversa
que apagaste nunca é então copiada de volta sem saberes.

## O que fazer

- Nada, se querias mesmo apagá-las.
- Para as trazer de volta, põe `organize.sessions.orphaned` a `"copy"` no config.json (ou responde que sim no
  `t3sm start`) e depois corre `t3sm plan` e `t3sm apply`.
- O `t3sm status` lista as que ficaram de fora em Bom saber.
