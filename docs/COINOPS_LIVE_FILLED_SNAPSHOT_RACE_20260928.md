# LIVE: fill entre snapshot de ordens abertas e reconciliação

## Incidente e causa

`COINOPS_LIVE_EXCHANGE_ORDER_MISSING` pode ocorrer se uma ordem residente
preencher depois da leitura de `openOrders`, mas antes de o ledger receber o
fill. Em 2026-09-28 13:30 UTC, um TP de BTCBRL preencheu na Binance e o
alerta foi registrado antes da coleta do trade. O reconciliador registrou
o fill/gain na execução seguinte, mas o gate local permaneceu fechado.

## Política segura

- Um item ausente de `openOrders` é consultado pelo `clientOrderId` **e**
  `exchange_order_id` persistidos no shard/conta/motor/mercado originais.
- Somente `FILLED` com identidade exata e trades coerentes é tratado como
  `COINOPS_LIVE_FILLED_DURING_SNAPSHOT`: retry sem alerta ou kill switch.
  O próximo tick do reconciliador oficial registra fill, gain e continuação
  idempotentes. Não há implementação paralela da estratégia no Watchdog.
- `CANCELED`, ordem não encontrada, identidade divergente, trades ausentes,
  observação indisponível ou resultado incerto continuam fail-closed.
- Para um alerta legado já latched, a retomada automática exige um único
  incidente crítico inalterado, fill tardio persistido na janela do alerta,
  reconciliação atual, saúde do executor, TPs residentes, Binance × ledger,
  limites e ausência de fill não conciliado. Se qualquer prova faltar, o gate
  do motor afetado permanece fechado; não liberar outros motores por inferência.
- Após a retomada validada, o fluxo oficial avalia a prioridade da NEXT BUY.
  Uma reentrada local elegível substitui uma BUY antiga somente mediante
  cancelamento comprovadamente sem fill, usando a identidade persistida.
  Não cancelar TP nem criar MARKET manual.

## Verificação e regressão

`live-order-snapshot-race.test.ts` cobre fill exato e ausências incertas.
`live-read-recovery-server.test.ts` cobre a evidência tardia e o gate.
`strategy-engine.test.ts` cobre a prioridade da reentrada após TP. Em
Production, usar apenas leituras/telemetria existentes; não provocar gain,
cancelamento ou ordem de teste.
