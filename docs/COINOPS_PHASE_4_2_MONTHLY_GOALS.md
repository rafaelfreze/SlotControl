# CoinOps — Fase 4.2: meta mensal por slot físico

## Contrato operacional

- BTC: 7 gains confirmados por slot físico em cada mês de `America/Campo_Grande`; SOL: 2.
- A fonte é `coinops.robot_v1_monthly_slot_gains`, um fato imutável por crédito de operação Shadow ou fechamento Testnet com TP preenchido e lucro positivo. `effective_gain_at` é o fechamento Shadow ou o fill de TP da exchange; `credited_at` preserva o reconhecimento local. Fill Testnet legado sem horário exato recebe `TESTNET_CREDIT_FALLBACK` e WARNING, nunca uma hora fictícia.
- `lifetime_gain_count` é a soma histórica; `monthly_gain_count` considera apenas `period_key`. Virar o mês não apaga crédito, saldo composto, operação ou identidade física.
- Enquanto houver algum slot abaixo da meta, os slots que a atingiram cedem prioridade e não recebem nova entrada; posição OPEN conserva TP e fill parcial permanece protegido. BUY residente sem fill só pode ser cancelada pelo fluxo autorizado após confirmação de ownership. Quando todos os 25 slots físicos atingirem a meta com contagem comprovada, a meta global está concluída e todos os slots elegíveis voltam à fila normal no mesmo mês. Novos gains continuam registrados (por exemplo, SOL 3/2 e BTC 8/7): meta é piso, não teto nem stop do motor.
- `physical_slot_id` não muda. `operational_rank` é derivado entre elegíveis por lifetime DESC e slot físico ASC. Num ciclo novo, o primeiro rank recebe o primeiro nível/entrada MARKET; os demais preços da grade são associados aos slots sem renumerar identidades. Durante um ciclo ativo, a Strategy Engine escolhe o preço válido mais alto abaixo do mercado **antes** de usar rank como desempate; níveis cruzados sem ordem residente continuam MISSED, jamais compra MARKET retroativa.
- Shadow, Testnet e LIVE usam a elegibilidade mensal da Strategy Engine compartilhada. Esta regra não autoriza operações de teste em Binance Production.

## Persistência, escopo e segurança

Migration `20260923181111_add_robot_v1_monthly_slot_gain_ledger.sql` cria ledger, gatilhos, backfill com evidência persistida, view de totais atuais e RPC de ranqueamento de ciclo Testnet ainda sem ordens. A RPC exige `service_role`, trava o run e rejeita ciclos ativos já executados; reaproveita a grade persistida e só altera os preços-alvo do run fictício novo. Ela não renumera `slot_number`, não altera ciclos ativos e não acessa Binance Production.

O ledger e a view usam escopo product/tenant/user e RLS owner-select; somente service_role insere fatos. Gatilhos verificam origem, owner, operação/sequence e TP antes de creditar. `source_id` torna o crédito idempotente. Sem ledger íntegro, os adaptadores falham fechados para novas entradas.

## UI, relatórios e auditoria

A Automação mostra, para BTC/SOL em Shadow e Testnet, físico, rank, lifetime, mês/meta, `META BATIDA`, elegibilidade, saldo composto, entrada/TP, próxima ação, filtro e próximo reset. Posições OPEN são visíveis separadamente da fila. A exportação v4 adiciona `17_METAS_MENSAIS.csv`; não projeta saldo atual em meses históricos. Regras e StrategyDecision permanecem no pacote.

Os 11 checks mensais confrontam contador, bloqueio, reentrada, virada, lifetime, rank, identidade, Single Active Entry, prioridade de preço e paridade de metas. Sem snapshot de virada de mês, fonte completa ou horário exato de TP legado, o resultado é WARNING, não PASS inventado. `LIVE_STRATEGY_PARITY_READY` também depende desses checks e **não** habilita LIVE.

## Validação e limites

Testes unitários cobrem metas 6→7/1→2, 24/25 e 25/25, mês-calendário local, virada de ano, OPEN atravessando mês, rank/empate, identidade, entrada inicial, proteção de fill parcial e prioridade de preço. A migration aditiva `20260928202508_monthly_goals_are_floor_not_stop.sql` remove apenas o veto de meta 25/25 do reset Testnet, mantendo verificações de fechamento, idempotência e privilégios. Conferir projeto Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`, antes da publicação. Smoke de leitura nunca aciona BUY, Gain ou comandos financeiros reais.
