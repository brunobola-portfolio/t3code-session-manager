# Títulos escritos pelo T3 Code: os que continuam técnicos

## O que quer dizer

Algumas conversas importadas ficam com um título técnico (um comando, um registo colado, uma imagem) porque o registo
delas não tem uma primeira mensagem utilizável. O `t3sm organize --ai-titles` pede ao T3 Code que escreva esses
títulos com o seu próprio modelo de texto, o que está nas definições do T3 Code. Isso gasta tokens do teu fornecedor,
por isso fica desligado a menos que o peças.

## Porque acontece

O t3sm limpa primeiro o título a partir do próprio registo (o título dele, o resumo ou a primeira mensagem a sério),
sem custo. Só um título que continua técnico depois disso passa para o T3 Code: uma conversa a que não mudaste o nome à
mão, não arquivada, não automática e nunca passada antes ao T3 Code. Antes de correr seja o que for, o resumo diz
quantos títulos, que modelo (quando o T3 Code o indica) e o limite da execução (`--ai-titles-max`, por omissão 50:
primeiro as conversas mais recentes). O T3 Code escreve cada título uns segundos depois; o t3sm espera até 2 minutos e
regista cada título que ele escreveu. A sincronização em segundo plano nunca pede títulos ao T3 Code.

## O que fazer

- Vê primeiro: `t3sm organize --ai-titles --dry-run`.
- Menos por execução: `t3sm organize --ai-titles --ai-titles-max 20`.
- Um título que o T3 Code não conseguiu escrever: o t3sm mostra o motivo. Confirma o modelo de texto nas definições do
  T3 Code e corre `t3sm organize --ai-titles` outra vez; essa conversa volta a ser pedida.
- Sempre ligado no `t3sm organize`: põe `organize.aiTitles.enabled` a `true` no config.json (`maxPerRun` define o
  limite); `--no-ai-titles` salta-o numa execução.
- O `t3sm organize --undo` repõe os títulos antigos que o t3sm registou. Um título que o T3 Code escreveu depois de a
  espera acabar fica como está: o t3sm não o distingue de um que puseste à mão.
