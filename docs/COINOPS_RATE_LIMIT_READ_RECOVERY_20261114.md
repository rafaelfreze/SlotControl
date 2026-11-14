# CoinOps — limite Binance numa observação pré-dispatch

## Incidente e causa comprovada

Pedro/SOLBRL, Executor 01, run `aede3a8b-ad73-4c6a-9552-1f8d2e275cb4`.
Alerta `COINOPS_LIVE_ARM_ENTRY_FAILED`, root `EXECUTOR_BINANCE_RATE_LIMITED`,
14/11/2026 03:33:59 UTC (13/11 23:33:59 America/Campo_Grande).

O journal autenticado registra QUERY_ORDER bem-sucedido às 03:33:57.467Z e
READ_STATE limitado às 03:33:58.890Z, HTTP503 do executor. Nenhum CREATE_ORDER
do engine nesse intervalo. A LIMIT do slot16 estava PREPARED, sem exchange ID,
submission guard, dispatch da decisão ou reserva de envio pendente. O Watchdog
detectou o bloqueio às 03:34:46Z, porém não tinha recuperação para essa classe.

O transporte não tipava o rate limit de um endpoint de observação. O catch
legado aceitava esse root em RECONCILE_ORDERS/READ_STATE, mas não em ARM_ENTRY.
Além disso, a retomada normal recusava qualquer PREPARED/decisão pendente,
inclusive este plano comprovadamente anterior a todas as barreiras de envio.

O wrapper não preservou HTTP/código/Retry-After originais da Binance. Não
afirmar 429, ban418, -1003/-1015 ou peso exato histórico. Peso atual não prova
a causa do limite antigo. A Binance exige respeitar limites/backoff:
[documentação Spot](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits).

## Correção prospectiva

Somente os endpoints autenticados de observação health/state/query-order/
trades/observe-order convertem EXECUTOR_BINANCE_RATE_LIMITED + HTTP503 em
LiveReadUnavailable. Não fazem retry imediato: cedem ao próximo worker normal.
Não mudar frequência de cron, orçamento Binance ou headroom. Create/cancel
continuam fora desse mecanismo e seus resultados incertos continuam fechados.

O checkpoint existente mantém WARNING/RETRY por até5min, sem fabricar freshness.
Após esse prazo, somente o engine afetado fecha novas BUYs. TPs/fills continuam
no reconciliador oficial. Quando a observação volta, o cron termina reconciliação
e usa VERIFIED_READ_RECOVERY sob lease; registra a recuperação no Watchdog,
que confirma o encerramento. Não há segundo trader no fast check do Watchdog.

## Exceção restrita para plano nunca enviado

O erro legado só é elegível com code/root/stage exatos e sem campos tipados
contraditórios. Para novos erros, exigir o checkpoint stale e endpoint/status/
tentativas de observação exatos. Isso apenas permite iniciar a prova.

Sem PREPARED, manter a prova padrão de decisões/dispatches assentados. Com
PREPARED, permitir exclusivamente uma LIMIT BUY ENTRY própria, sem requested
quote, exchange ID, submission guard, receipt, execução ou taxas. Exigir:

- ledger físico completo; ownership account/engine/run/slot/operação exato;
- slot ARMED vazio, mesmo nível; reserva igual a preço × quantidade arredondada;
- uma única decisão PENDING ARM_NEXT_BUY, anterior ao incidente, target e
  identidade correspondentes, sem dispatch/ACK/conclusão;
- nenhuma reserva de envio não reconhecida nem outra BUY residente;
- GET autenticado do clientOrderId exato retornando explicitamente order:null;
- reconciliação posterior ao incidente, atual até150s, health, proteção integral
  dos TPs, caps/BNB, parents, ausência de edição/bulk pendentes;
- repetir prova completa, exigir fingerprint idêntico e CAS do incidente exato
  sob lease antes de abrir somente engine/preparation afetados.

Não cancelar, aposentar ou recriar o plano. Após a abertura, o worker oficial
continua a MESMA ordem/clientOrderId, com budget, caps, lock, guard e idempotência
normais. O arredondamento pode fazer a reserva efetiva menor que o saldo-alvo
da decisão (neste caso10,803 versus11 BRL); isso não altera capital ou estratégia.

Guard preenchido, fill parcial/concorrente, ordem existente/GET indefinido,
decisão alterada, falta de TP, prova incompleta, lease/CAS perdido ou erro duro
continuam BLOCKED_SAFE. PAUSED intencional não retoma automaticamente.

## Validação e operação

Testes offline: transporte sem burst, POST/cancel incertos, prova de plano,
duas observações, concorrência/dispatch/fill, CAS, cron, Watchdog e isolamento.
Nenhuma ordem REAL é teste. Sem migration/RLS ou mudança de perfil econômico.
O bundle nativo não muda; confirmar manifesto/paridade antes de publicar web.

Depois do deploy Git, observar execução e Watchdog normais. Confrontar a ordem
original e seu estado real na Binance, ledger e engine, 25 slots, TP por OPEN,
no máximo uma NEXT BUY, incidentes e irmãos. Registrar readbacks locais sem
commitar payloads financeiros/segredos. Se faltar prova, investigar o engine
afetado, nunca remover flags/claims manualmente ou abrir um gate global.
