# Conta desligada: a conta da conversa não está utilizável no T3 Code

## O que quer dizer

A conversa pertence a uma conta (ou a um agente como o Codex ou o Pi) cuja instância no T3 Code tem a sessão
terminada, está desligada ou não existe, por isso o T3 Code não a consegue importar.

## Porque acontece

- A sessão da conta expirou no T3 Code.
- A instância, ou o agente, está desligada nas definições do T3 Code (Providers).
- A conta ainda não tem instância no T3 Code.

## O que fazer

1. `t3sm accounts` mostra cada conta, a instância dela e se tem a sessão iniciada.
2. Inicia a sessão no T3 Code, ou liga o agente nas definições (Providers). Uma instância que falta:
   `t3sm accounts --apply`.
3. Depois corre `t3sm apply` outra vez.
