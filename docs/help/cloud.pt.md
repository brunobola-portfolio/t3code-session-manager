# Sessões da cloud: o claude.ai/code e a app Claude neste PC

## O que é

As sessões que começas no claude.ai/code ou na app Claude correm na cloud da Anthropic, por isso nem o T3 Code nem
um terminal as veem. O `t3sm cloud` lista-as e o `t3sm cloud pull` traz uma para aqui como uma sessão local normal:

- o código fica no ramo da sessão, numa worktree própria (as tuas árvores de trabalho nunca são alteradas);
- a conversa é escrita na conta Claude certa e pode ser continuada com `claude --resume`;
- é importada para o T3 Code, no projeto do seu repositório.

Só o teu próprio `claude` fala com a cloud, com a tua sessão iniciada. O t3sm nunca vê um token e nenhum modelo é
chamado: listar e trazer não gastam tokens.

## Como usar

- `t3sm cloud` lista as sessões de cada conta e onde cada uma está: só na cloud, neste PC, mais recente na
  cloud ou continuada aqui.
- `t3sm cloud pull <id>` mostra o que vai fazer e pergunta uma vez. `--dry-run` só mostra. `--all` leva todas as
  sessões que ainda não estão aqui ou que são mais recentes na cloud.
- A primeira vez pergunta uma pasta base para os repositórios (`<pasta>/<dono>/<repositório>`) e guarda-a no
  config.json como `cloud.baseDir`. `--base <pasta>` usa outra só nessa execução.

## Quando algo corre mal

- **O Claude Code não conseguiu listar as sessões:** corre `claude`, depois `/login`, e atualiza o Claude Code. Estes
  pedidos são internos do Claude Code e podem mudar entre versões.
- **O git falhou:** a saída aparece no ecrã. Confirma que consegues clonar o repositório tu mesmo
  (`git clone <url>`) e tenta outra vez. Um ramo que já não existe no remoto usa a cópia principal, com um aviso.
- **Uma sessão fica à espera:** uma sessão ativa na cloud nos últimos 10 minutos vem no próximo pull.
- **Continuada aqui e na cloud:** nada é escrito. A cópia no T3 Code é a deste PC; continua aí.
- **Neste PC mas não no T3 Code:** o ecrã diz porquê. O `t3sm sync` importa-a quando isso estiver resolvido.
- **Uma sessão compactada:** as mensagens antes da última compactação já não estão disponíveis na cloud.

## Desfazer

`t3sm rollback --run <execução> --archive-threads` remove as sessões trazidas e arquiva as suas threads. Os clones e
as worktrees ficam: apaga-os tu se já não precisares do código.
