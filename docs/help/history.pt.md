# Histórico: que conversas ficam à vista em cada projeto

## O que quer dizer

O t3sm mantém curta a lista de cada projeto. As conversas com atividade nos últimos 90 dias ficam à vista dentro do
projeto; as mais antigas passam para Settled: ficam no projeto, na prateleira Settled. Um projeto com menos conversas
recentes continua a mostrar as 10 mais recentes.

## Porque acontece

É a regra do histórico, `organize.history` no config.json (por omissão: os últimos 90 dias, pelo menos 10 por
projeto). Abrange todas as conversas importadas (uma thread cujo id começa por `import:`), tenha sido o t3sm ou a
importação do próprio T3 Code a trazê-las; uma conversa que começaste no T3 Code só é mexida pela opção do próprio
T3 Code. O `t3sm organize` aplica a regra; a sincronização em segundo plano aplica-a logo a seguir a uma importação aos
projetos que receberam conversas novas, e uma vez por dia a todos os projetos. A passagem automática para Settled do
próprio T3 Code não muda.

## O que fazer

- Experimenta primeiro outra regra só numa execução: `t3sm organize --history 30 --min 5 --dry-run` (ou
  `--history all`, ou `--history off`).
- Guarda a que preferires no config.json (`organize.history`), ou responde no `t3sm start`.
- Para mudar também a definição do próprio T3 Code, acrescenta `--auto-settle 90` (de 1 a 90 dias, ou off).
- Cada alteração fica no diário: o `t3sm organize --undo` repõe-na.
