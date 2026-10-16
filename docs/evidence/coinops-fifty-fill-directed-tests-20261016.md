# Thyely — prova financeira isolada de 50 slots

Data: 16/10/2026. Código de referência recuperado: `f82e134084c67b424809c586a3b7b4cd46e00489` mais o diff exclusivamente de testes descrito abaixo. Esta evidência não é uma ativação nem um certificado integral de capacidade.

## Configuração exata

- SOLBRL, Executor 03; 50 slots físicos, R$22 por slot, R$1.100 no total.
- Gain 3%, meta mensal 3, spacing normal 2%, pós-ATH 3%.
- Conta/motor/ordens/credenciais são fictícios. Nenhum `.env`, vault, banco remoto ou API Binance real é utilizado.

O factory compartilhado `tools/testing/hundred-fills-reconciliation.test.mjs` agora recebe `slotCount`, `slotCapital`, `normalSpacingRate`, `postAthSpacingRate`, `gainRate` e `monthlyTarget`. O default 100×R$11 e spacing 1%/2% dos testes anteriores permanece. O valor canônico é persistido separadamente em engine, preparation e snapshot do run; não é inferido do número de linhas retornadas. O livro simulado permite trades parciais com IDs imutáveis distintos e inclui `PARTIALLY_FILLED` entre as ordens residentes.

## Resultado direcionado

`node --experimental-strip-types --test tools/testing/fifty-fills-reconciliation.test.mjs`: **7/7 PASS, zero skips**.

1. Cinquenta TPs preenchidos simultaneamente: 100 fills BUY+SELL, 50 créditos mensais e 50 incrementos de gain, mesmo após replay. Principal reinvestido final R$1.132,99975000, incluindo taxa BNB fictícia. Nenhuma criação/cancelamento nesse caminho de observação/assentamento.
2. Crash após sync durável número 17 e após crédito durável número 17: retomada dos restantes, sem fill, gain ou reinvestimento duplicado.
3. Três respostas 503 intermitentes convergem pelo orçamento GET real; a quarta interrompe o agendamento, drena o trabalho em curso e mantém os assentamentos já duráveis. A próxima invocação conclui sem duplicação. Depois da rejeição não há GET ou SQL tardios.
4. Vinte e cinco TPs completos + vinte e cinco parciais: posições remanescentes continuam com TPs próprios residentes. O preenchimento posterior usa novos trade IDs, chega a 50 gains e 125 fills BUY+SELL/parciais, sem trocar identidade de TP.
5. TP cancelado depois de fill parcial não é aceito como proteção: posição residual continua aberta e o checkpoint falha fechado com `COINOPS_LIVE_OPEN_WITHOUT_RESIDENT_TP`. O teste não recria TP por suposição.
6. Checkpoint SQL real: 0→17→50 créditos. Replay sem progresso não renova `observed_at`; `last_reconciled_at` continua nulo até a liberação bem-sucedida completa. O checkpoint mantém a mesma origem/episódio.
7. Lease ativo não é roubado, lease expirado não autoriza sync e somente um dos dois claims concorrentes vence. O planner canônico gera uma decisão `ARM_NEXT_BUY`, não 50 ordens.

O motor fictício de 25 slots no mesmo account/symbol, em outro shard, conserva byte a byte seu ledger de principal em todos esses casos. O transporte recusa adotar a ordem do slot 50 usando a identidade do motor irmão.

## Inventário observado, não certificado

No caso nominal de 50 TPs, somente a fase de reconciliação observada executou:

| Medida | Observado na fixture |
| --- | ---: |
| Round-trips SQL/RPC | 506 |
| Syncs / renovações de lease / ACKs / decisões concluídas | 50 de cada |
| Pico de observações concorrentes | 4 |
| Request weight total / host privado / host público | 1004 / 980 / 24 |

As chamadas são do transporte VPS real com fetch simulado, helper web real, ACK/registry/decisão reais e corpos SQL versionados em PGlite. Pesos são inventário dos endpoints, não consumo Production. O relógio lógico de 150ms serve para testar TTL; não representa a latência distribuída real.

## Compatibilidade e validação

- Execução conjunta anterior à inclusão explícita da meta 3 no fixture: 19/19 PASS (7 novos de 50 + 12 existentes de 100).
- Após persistir a meta 3: 7/7 de 50 PASS; após a separação do custo da assert de configuração, o caso nominal foi repetido: 1/1 PASS.
- `node --check` dos dois arquivos e `git diff --check` direcionado: PASS.
- A suite de 100 permanece com defaults retrocompatíveis; não se converte uma prova de 100 em certificação de 50 por proporcionalidade.

## Limites explícitos

- O cenário de fill/cancel observa um cancelamento parcial confirmado e prova o bloqueio por ausência de proteção. Não é uma execução real de cancelamento concorrente na Binance.
- Os testes acima não executam o `advanceLiveRunOnce` inteiro nem provam o envelope completo por minuto de ARM, account-global budget, múltiplos símbolos, successor e próximas invocações. A continuidade SQL/planners e o inventário de carga complementar pertencem a `fifty-slot-workload.test.mjs` e devem ser reportados separadamente pelo agente responsável.
- PGlite prova os corpos financeiros e o comportamento de replay; não substitui teste de contenção PostgreSQL multissessão, runtime físico ou validação remota de RLS.
- A existência de 50 linhas na fixture não comprova um motor REAL criado, Admission PASS, saldo Binance, whitelist ou TP/NEXT BUY LIVE.
- Não foi alterado código operacional, migration, cron, política de segurança ou parâmetro de motor existente por este subtrabalho.

**NENHUMA OPERAÇÃO LIVE REALIZADA POR ESTES TESTES.**
