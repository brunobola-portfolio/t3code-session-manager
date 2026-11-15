# Conversão: sessões que o t3sm converte antes de importar

## O que quer dizer

O T3 Code não consegue ler algumas sessões tal como estão: as do OpenCode e as do Codex que o Codex comprimiu. O t3sm
escreve uma cópia de cada uma como conversa do Claude, ao lado das outras da conta, e o T3 Code importa essa cópia.
Os teus ficheiros originais nunca mudam.

## Porque falha uma conversão

- O formato do agente mudou e este t3sm não o consegue ler: atualiza o t3sm (`t3sm update`).
- A sessão não pôde ser lida (um ficheiro bloqueado ou danificado): tenta mais tarde; o `t3sm scan` conta os erros
  de leitura.
- A cópia não pôde ser escrita (disco cheio, sem permissão), ou já lá está um ficheiro com o mesmo nome: liberta
  espaço, ou tira esse ficheiro de lá.
- A pasta de destino não pode ser usada (uma pasta temporária ou do sistema): escolhe uma no `t3sm start`.

## O que fazer

Corre `t3sm apply` outra vez depois de resolver a causa. O `t3sm rollback --run <id> --dry-run` mostra as cópias que
uma execução escreveu; um rollback apaga-as, a menos que as tenhas editado.
