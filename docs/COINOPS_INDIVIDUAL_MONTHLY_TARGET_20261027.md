# Meta mensal individual — correção de cadastro

Alvo: CoinOps, OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`, REAL.

## Incidente comprovado

A tentativa Thyely/SOLBRL/Executor01 de 27/10/2026, request
`974cc222-bcc5-4073-83d7-c2a4331c858f`, passou na prévia com capital
375 BRL, 25 slots, gain 5,5%, spacing normal 1%, pós-ATH 2%, meta mensal 3.
Não havia ENGINE_APPEND concluído nem motor SOLBRL após o erro.

O schema real ainda tinha `robot_v1_live_monthly_target` exigindo BTC=7/SOL=2.
O plano canônico, cadastro, editor e runtime já usam meta positiva por engine.
A incompatibilidade foi reproduzida com o RPC APPEND versionado e a definição
real do CHECK em PostgreSQL isolado: SQLSTATE 23514 nessa constraint, com
rollback integral de motor, cap, reserva e auditoria. O wrapper retornava
`COINOPS_ENGINE_APPEND_FAILED`. Não era erro de capacidade ou depósito.

## Correção mínima

Migration `20261027232254_allow_individual_live_monthly_targets.sql` troca
somente o CHECK por `monthly_target >= 1`, mantendo a coluna integer NOT NULL,
os defaults, RLS, grants, flags e todos os valores existentes. Constraint
validada no mesmo bloco transacional, com lock/statement timeout limitado.
Não altera função financeira, runtime, ordens, perfis ou histórico.

## Regressão

`node --test tools/operations/individual-monthly-target-sql.test.mjs`

- Reproduz a falha antiga e o rollback integral.
- Preserva valores antigos, RLS e grants; aceita metas individuais positivas
  de BTC/SOL e rejeita zero, negativo, NULL e overflow integer.
- Mesmo request cria uma única identidade, 25 slots, cap e reserva uma vez;
  conserva os parâmetros exatos e o engine irmão com OPEN/TP/BUY.
- Gates de saldo, capacidade, ownership, orçamento e credenciais continuam nos
  fluxos canônicos; a fixture não certifica nem altera capacidade produtiva.

## Continuação operacional

Reutilizar o request original, confirmar ausência/presença de replay antes de
qualquer tentativa e obter prévia fresca pelo fluxo APPEND. Preparar INACTIVE,
confirmar registry e só então usar PREPARE/ACTIVATE oficiais. Primeiras ordens
pertencem ao worker, com lease/idempotência; nunca enviar ordem manual nem
duplicar ativação após resposta incerta. Confirmar Binance × ledger × engine.
