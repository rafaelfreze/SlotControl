# CoinOps — incidente de leitura mensal REAL

## Evidência e causa

07/10/2026 20:02:13 UTC / 16:02:13 America/Campo_Grande:
Dete/BTCBRL, Executor 02 (`164.90.223.159`), engine
`119e9b7f-7582-4e8f-bd57-c15dc51a4455`, run
`1674ce3e-e514-4286-8cd0-67537763bc1e`, incidente
`34453363-d225-41a9-b0de-3d89b9d314cd`:
`COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE` em RECYCLE_SLOTS.

Watchdog detectou BLOCKED, sem recovery em andamento. Cron voltou a
reconciliar OK, mas o gate local persistiu. Leitura às 20:27 UTC confirmou
25 slots/contas, gain lifetime/mensal = 1 no físico #2, identidade/período
2026-10 corretos, target 7. Último fill antes do incidente: BUY #5 às 13:39 UTC;
nenhum gain/crédito novo na janela do alerta.

Binance no IP correto: 5 TPs NEW `2346270639`, `2347163989`, `2347246538`,
`2349238089`, `2349900155` cobrem .00251 BTC. NEXT BUY NEW `2349901173`,
.00053 BTC a 407725 BRL. IDs/clientOrderIds/quantidades/preços coincidem com
o ledger do motor; nada foi recriado/cancelado para diagnóstico.

A consulta `robot_v1_slot_gain_totals` descartava todo erro do provider e
não tinha retry limitado. A proteção do ledger principal não abrangia essa
dependência de leitura mensal. `UNAVAILABLE` não era elegível para retomada.
Logs oficiais confirmam target GET 200 às 20:02:13.657 e cron FAILED; não
preservam a resposta original de totals. Não afirmar 503, Earn ou gain como
causa específica comprovada. A causa estrutural comprovada é a classificação
genérica sem evidência/retry e bloqueio persistente depois de dados íntegros.

## Correção e invariantes

- REAL: 2 snapshots completos target + totals, 5s/tentativa, intervalo 250ms.
  Apenas GET, mesma política `live-ledger-read.ts`; escopo completo por engine.
  Erro de permissão/schema vence transient concorrente; nenhuma leitura parcial
  é usada. Target exatamente um inteiro positivo; 25 físicos únicos.
- Ganhos vazios válidos são zero apenas quando a fonte respondeu completamente
  e lifetime não diverge dos slots. Erro/null não é zero. Identidade, mês,
  duplicação e contagens continuam validados pela política mensal canônica.
- Exaustão transient usa o checkpoint comum TRANSIENT_EXECUTOR_READ e WARNING
  TRANSIENT_LEDGER_READ. Mais de 5min: LEDGER_READ_STALE local. Sem freshness
  falsa, crédito duplicado, alteração de TP ou segundo algoritmo de estratégia.
- Recursos novos allowlisted: `ledger/monthly_target`, `ledger/monthly_gains`.
  READ_FAILED e dados ambíguos/incompletos continuam fail-closed.
- Legado MONTHLY_GAIN_LEDGER_UNAVAILABLE exige root idêntico e estágio mensal
  conhecido (CREDIT_SLOTS, RECYCLE_SLOTS, RESTART_CYCLE, ATH_TRANSITION,
  ARM_ENTRY), ACTIVE + reconciliação integral OK. `resumeLiveRun` sob lease
  revalida mensal, ownership, Binance/TP, fills, caps, health e único incidente
  inalterado; CAS final. Sem UPDATE manual de gate/alerta.
- Cron normal registra VERIFIED_READ_RECOVERY; Watchdog confirma HEALTHY
  independentemente e encerra RECOVERED. Watchdog permanece fallback.
- Meta, regime, rank, 25 slots, gain lifetime, histórico, capital e ordens
  saudáveis não são modificados para corrigir uma observação.

## Regressões e publicação

`monthly-slot-read.test.ts`, `live-read-recovery.test.ts`,
`live-read-recovery-server.test.ts`: transient completo/exaurido,
target/transient concorrente com permissão, dados divergentes/estrangeiros,
mesma conta/símbolo em engines/shards distintos, viradas setembro/outubro e
dezembro/janeiro, TP/health/lease/CAS e nenhuma ordem no resume.
Relatórios v21 / regra de observação v4 exportam política e evidência sanitizada.

Somente web/control plane. Publicação Git/main → Vercel, sem migration,
credencial, restart VPS ou alteração de runtime. Após READY, aguardar cron
oficial, readback do incidente e comparação Binance × ledger; não provocar
trade para smoke. Rollback web para SHA anterior preservando histórico/gates.
