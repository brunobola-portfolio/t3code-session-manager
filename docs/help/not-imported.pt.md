# Não importada: o T3 Code não aceitou uma conversa

## O que quer dizer

O t3sm pediu ao T3 Code para importar a conversa, verificou duas vezes e ela não está no T3 Code. Não se perdeu nada:
o ficheiro da sessão está onde estava e o t3sm repôs todas as datas dos ficheiros.

## Porque acontece

- A pasta registada na conversa não é a do projeto que o T3 Code abriu (uma pasta que mudou de nome ou de sítio).
- A conversa não tem nenhuma mensagem tua que o T3 Code consiga ler (só resultados de ferramentas ou um resumo).
  Uma sessão só com comandos e sem resposta fica de fora ("nada para mostrar").
- O T3 Code registou um erro para ela (vê os registos em `~/.t3/userdata/logs/`).

## O que fazer

1. Corre `t3sm apply` outra vez: tenta mais uma vez as conversas que falharam.
2. Se voltar a falhar, corre `t3sm plan` e lê o `plan.md`: uma pasta que mudou de sítio pode ser mapeada com `remap`
   no config.json.
3. `t3sm runs` lista cada execução e o que importou; a conversa continua a poder ser tentada outra vez.
