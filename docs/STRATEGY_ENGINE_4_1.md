# CoinOps — Strategy Engine 4.1

## Limite operacional

`strategy-engine.ts` é a decisão única de BTC/SOL para os adaptadores Shadow e
Binance Spot Testnet. A engine não recebe credenciais nem ambiente para decidir.
Production permanece GET-only; LIVE permanece bloqueado. BTCUSDT/SOLUSDT manuais
não fazem parte deste executor. Perfil de teste: 25 slots físicos, 250 USDC
lógicos, gain 0,5%, distância 1%, compounding por slot e Single Active Entry.

Os fills Shadow são simulações de candles, não provas de fills do livro Testnet.
Paridade significa a mesma decisão para o mesmo estado/observação normalizados,
não igualdade artificial dos preços/fills de ambientes distintos.

## Causa da latência de SOL

TP do slot 1 executado em 23/09/2026 às 04:23:36.439 UTC, coletado às
12:30:04.982 UTC: **29.188.543 ms (8h06m28.543s)**. O cron respondia HTTP 200,
mas o checkpoint não avançava. A reprodução com o `patchFetch` real instalado
do Next 14.2.35 mostra que GET `force-dynamic` com `revalidate=false` ainda
cacheava a consulta autenticada de descoberta de ciclos. Após alteração dos
ciclos, a consulta devolvia a lista antiga até a troca de deployment.

Correção: `fetchOperationalData` força `cache: no-store` no cliente service-role;
rotas do executor também declaram `revalidate=0` e `fetchCache=force-no-store`.
O teste de regressão demonstra lista antiga com o comportamento anterior e
lista atual com o fetch explícito. Não há secret no teste.

O evento aditivo `MISSED_LEVEL_DIAGNOSED` mantém fill, coleta, latência, causa e
versão corretiva. Não altera o saldo 10,09996 USDC, os gains já creditados nem
cria uma BUY retrospectiva. O instante exato do cruzamento Testnet não foi
observado e continua nulo; candles Production não são usados para inventá-lo.

No primeiro reactor publicado (14:32 UTC), BTC também saiu do checkpoint parado
desde 12:50:14.408 UTC. Seu TP de 14:01:50.234 foi coletado às 14:32:22.202
(30m31.968s). A reentrada de 85.480,48 já havia sido ultrapassada. A migration
`20260923143630_diagnose_pre_fix_btc_reconciliation_gap.sql` apenas documenta
esse backlog anterior à correção, preservando o saldo 10,0470151 e o gain.
Nos ticks seguintes os dois ativos avançaram juntos, com aproximadamente 60s
entre verificações e execução de cerca de 2–3s; isso não representa SLA de fill.
Os quatro motores adotaram 4.1.0. Os dois missed históricos continuam explícitos;
a presença deles não autoriza certificar o gate LIVE como PASS.

## Reação e recuperação

- `/api/cron/testnet-reactor`: polling serverless a cada minuto, autorizado por
  `CRON_SECRET`, descoberta sem cache e até dois ativos em paralelo.
- `/api/cron/testnet-execution`: watchdog de cinco minutos. Ciclo saudável não é
  processado novamente; atraso acima de 90s/erro pode disparar recuperação.
- A frequência é uma agenda, não SLA subsegundo. Não há websocket permanente.
  Um cruzamento entre observações pode continuar produzindo missed legítimo.
- Lease Testnet por run; lease Shadow por configuração. Um ativo com falha não
  impede o outro. Checkpoint parado após resposta OK vira falha, não saúde verde.
- `RECONCILIATION_STARTED/FINISHED` distinguem worker não invocado, interrompido,
  ocupado, falho e concluído, com duração, intervalo e checkpoint.
- Shadow mantém seu cron de cinco minutos e replay cronológico de candles 1m.
  Não aplica preço atual antes de drenar o backlog. Reentrada criada após TP
  não pode preencher no candle que antecedeu sua criação.

## Decisões e preservação

`robot_v1_strategy_decisions` persiste a intenção antes de despachar, com escopo
produto/tenant/usuário/ambiente, ativo, ciclo, slot físico, operação, versão,
prioridade, motivo e estado esperado. Tem RLS de leitura do proprietário;
somente service-role insere/atualiza; campos da intenção são imutáveis.
Timestamps reais de persistência/dispatch/ack/conclusão não são retrodatados
para o horário do candle ou fill. IDs determinísticos deduplicam retries.

As versões históricas continuam NULL. A adoção do runtime 4.1.0 é explícita em
configuração/ciclo/run, sem reescrever operações antigas. A migration aditiva
`20260923141911_strategy_engine_decision_ledger.sql` foi aplicada exclusivamente
em `otdfpmsegjxpqrzisfmi`, schema `coinops`.

Último TP sem outra posição permite COMPLETE_CYCLE → cancelamento de BUY própria
→ REANCHOR → novo ciclo → OPEN_INITIAL_MARKET → fill → CREATE_TP → ARM_NEXT_BUY.
Com outra posição aberta, PLAN_LOCAL_REENTRY preserva preço de referência, saldo
composto e slot físico, incrementando apenas a operação. A maior entrada válida
abaixo do mercado substitui uma residente inferior, nunca uma BUY parcialmente
preenchida ou com cancelamento incerto. Não há MARKET de recuperação local.

## Auditoria, verificação e rollback

Relatórios versão 2 incluem decisões, estratégia, latência, causa de missed e
checks de prioridade, inicial MARKET, duplicação e paridade. Evidência ausente
é WARNING; falha interna/missed não aparece como Motor OK. O gate
`LIVE_STRATEGY_PARITY_READY` é informativo e não habilita LIVE.

Quando TP/BUY e reciclagem têm o mesmo timestamp de candle, o detector de
gatilhos prioriza a ação efetivamente persistida naquele primeiro instante de
encerramento. Um evento posterior não pode encobrir um encerramento anterior.
Isso evita falso `MISSING_ACTION` sem fabricar execução ou ocultar falha real.

Smoke de 23/09/2026, 14:32–14:44 UTC: 13 reconciliações por ativo, sem falha;
maior intervalo de 60,635s. O diagnóstico direto Testnet confirmou 2 ordens
próprias BTC e 5 SOL, com reservas iguais ao ledger. Os dois runs mantiveram
25 slots, uma única NEXT BUY por ativo e nenhum ID de decisão duplicado.
UI desktop e relatório v2/exportação de decisões foram inspecionados. O controle
de viewport do navegador não aplicou 390px (permaneceu em 1920px), portanto
o smoke mobile não foi certificado. Estes dados comprovam a janela observada,
não operação prolongada nem aprovação do gate LIVE.

Validação reproduzível em `apps/web`: `npm.cmd test`, `npm.cmd run lint`,
`npm.cmd run typecheck`, `npm.cmd run build`. Testes não enviam ordens e cobrem
cache real do Next, engine pura, isolamento do dispatcher, intent/retry,
cronologia de candles, reports e guardas de migração. Nenhum banco remoto é
usado como banco de testes financeiros.

Rollback de aplicação preserva as colunas/tabela e toda a trilha; não executar
DROP nem apagar decisões. Retornar ao código anterior reintroduz o bug de cache:
preferir correção à frente, mantendo no-store e os bloqueios Production/LIVE.
