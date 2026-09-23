# CoinOps — Fase 4.2: meta mensal por slot físico

## Contrato operacional

- BTC: 7 gains confirmados por slot físico em cada mês de `America/Campo_Grande`; SOL: 2.
- A fonte é `coinops.robot_v1_monthly_slot_gains`, um fato imutável por crédito de operação Shadow ou fechamento Testnet com TP preenchido e lucro positivo. `effective_gain_at` é o fechamento Shadow ou o fill de TP da exchange; `credited_at` preserva o reconhecimento local. Fill Testnet legado sem horário exato recebe `TESTNET_CREDIT_FALLBACK` e WARNING, nunca uma hora fictícia.
- `lifetime_gain_count` é a soma histórica; `monthly_gain_count` considera apenas `period_key`. Virar o mês não apaga crédito, saldo composto, operação ou identidade física.
- Ao atingir a meta, a posição já OPEN conserva o TP, mas o slot não recebe BUY ou reentrada nova até o mês seguinte. BUY CoinOps residente e ainda sem fill é cancelada após confirmação de ownership; fill parcial é protegido. Se todos os 25 atingirem a meta, não há nova entrada.
- `physical_slot_id` não muda. `operational_rank` é derivado entre elegíveis por lifetime DESC e slot físico ASC. Num ciclo novo, o primeiro rank recebe o primeiro nível/entrada MARKET; os demais preços da grade são associados aos slots sem renumerar identidades. Durante um ciclo ativo, a Strategy Engine escolhe o preço válido mais alto abaixo do mercado **antes** de usar rank como desempate; níveis cruzados sem ordem residente continuam MISSED, jamais compra MARKET retroativa.
- Shadow e Binance Spot Testnet usam `StrategyDecision` 4.2 da mesma engine. Binance Production permanece READ-ONLY e LIVE bloqueado.

## Persistência, escopo e segurança

Migration `20260923181111_add_robot_v1_monthly_slot_gain_ledger.sql` cria ledger, gatilhos, backfill com evidência persistida, view de totais atuais e RPC de ranqueamento de ciclo Testnet ainda sem ordens. A RPC exige `service_role`, trava o run e rejeita ciclos ativos já executados; reaproveita a grade persistida e só altera os preços-alvo do run fictício novo. Ela não renumera `slot_number`, não altera ciclos ativos e não acessa Binance Production.

O ledger e a view usam escopo product/tenant/user e RLS owner-select; somente service_role insere fatos. Gatilhos verificam origem, owner, operação/sequence e TP antes de creditar. `source_id` torna o crédito idempotente. Sem ledger íntegro, os adaptadores falham fechados para novas entradas.

## UI, relatórios e auditoria

A Automação mostra, para BTC/SOL em Shadow e Testnet, físico, rank, lifetime, mês/meta, `META BATIDA`, elegibilidade, saldo composto, entrada/TP, próxima ação, filtro e próximo reset. Posições OPEN são visíveis separadamente da fila. A exportação v4 adiciona `17_METAS_MENSAIS.csv`; não projeta saldo atual em meses históricos. Regras e StrategyDecision permanecem no pacote.

Os 11 checks mensais confrontam contador, bloqueio, reentrada, virada, lifetime, rank, identidade, Single Active Entry, prioridade de preço e paridade de metas. Sem snapshot de virada de mês, fonte completa ou horário exato de TP legado, o resultado é WARNING, não PASS inventado. `LIVE_STRATEGY_PARITY_READY` também depende desses checks e **não** habilita LIVE.

## Validação e limites

Testes unitários cobrem metas 6→7/1→2, mês local, rank/empate, identidade, entrada inicial, proteção de fill parcial e prioridade de preço. A migration deve ser conferida no projeto Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`, antes da publicação do código que a lê. Smoke autenticado deve verificar desktop/mobile sem clicar em BUY, Gain ou outros comandos financeiros reais. Reconciliar BTC e SOL Testnet depois do deploy; qualquer ausência de TP, duplicação ou divergência Shadow × Testnet impede a conclusão.
