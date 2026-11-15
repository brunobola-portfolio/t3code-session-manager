# Pasta ilegível: o T3 Code não sabe onde a conversa correu

## O que quer dizer

O T3 Code põe cada conversa num projeto pela pasta escrita no início do registo dela, e só olha para o primeiro
1 MiB (e para os primeiros 1000 registos). A pasta desta conversa está depois disso, ou nem está escrita, por isso o
T3 Code não a consegue colocar:

- o `t3sm apply` (e o `t3sm sync`) indicam-na como não importada: "pasta ilegível" (saída 5);
- o `t3sm plan` conta-a entre as sessões ignoradas: "pasta ilegível", ou "sem pasta registada" quando o registo
  não indica pasta nenhuma.

## Porque acontece

A conversa começou com uma primeira mensagem ou um anexo muito grande, e a pasta aparece tarde demais, ou o agente
nunca escreveu a pasta no registo.

## O que fazer

- Não há nada a corrigir no t3sm, e correr `t3sm apply` outra vez não muda nada: o registo fica como está.
- A conversa está segura no disco. Continua-a num terminal a partir da pasta do projeto; numa sessão do Claude Code,
  com `claude --resume <id da sessão>` (o id é o nome do ficheiro do registo).
